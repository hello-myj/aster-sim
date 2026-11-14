"""Verified first-boot resource download for a virtual SD card."""
from __future__ import annotations
import hashlib
import json
import re
import ssl
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path
from PySide6.QtCore import QObject,Signal

class SecureRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,request,fp,code,msg,headers,newurl):
        if urllib.parse.urlsplit(request.full_url).scheme=='https' and urllib.parse.urlsplit(newurl).scheme!='https':
            raise ValueError('拒绝 HTTPS 降级重定向')
        return super().redirect_request(request,fp,code,msg,headers,newurl)

def source_url(value):
    parsed=urllib.parse.urlsplit(value)
    if parsed.scheme not in ('http','https') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('请输入不含认证信息、查询参数或片段的 HTTP(S) 地址')
    return value.rstrip('/')

class Bootstrap(QObject):
    progress=Signal(dict)
    complete=Signal(str,str)
    failed=Signal(str)
    def __init__(self,sd:Path,profile:dict,source:str,ca:Path):
        super().__init__();self.sd=sd;self.profile=profile;self.source=source_url(source);self.ca=ca;self.cancel=threading.Event();self.started=time.monotonic();self.thread=None
    def start(self):
        self.thread=threading.Thread(target=self.run,daemon=True,name='aster-bootstrap');self.thread.start()
    def emit(self,phase,done=0,total=0,index=0,files=0,file=''):
        self.progress.emit(dict(phase=phase,bytes=done,total=total,index=index,files=files,seconds=int(time.monotonic()-self.started),file=file))
    def run(self):
        try:self.download()
        except Exception as error:
            if not self.cancel.is_set():self.failed.emit(str(error))
    def download(self):
        context=ssl.create_default_context(cafile=str(self.ca));self.opener=urllib.request.build_opener(SecureRedirect(),urllib.request.HTTPSHandler(context=context))
        def fetch(url):
            with self.opener.open(url,timeout=30) as response:
                raw=response.read(65537)
            if len(raw)>65536:raise ValueError('系统清单过大')
            return json.loads(raw)
        self.emit(4)
        descriptor=fetch(self.source)
        if descriptor.get('kind')!='aster-static-source' or descriptor.get('schema')!=1:raise ValueError('此向导需要静态发布源 aster-source.json')
        base=source_url(descriptor['base_url']);self.emit(5)
        profile=fetch(f"{base}/setup-{self.profile['board']}-{self.profile['target']}.json")
        if profile.get('schema')!=2 or profile.get('board')!=self.profile['board'] or profile.get('target')!=self.profile['target']:raise ValueError('系统资源与当前设备不兼容')
        release=profile.get('release','');count=profile.get('files',0);total=profile.get('total_bytes',0)
        if not re.fullmatch('[0-9a-f]{64}',release) or count!=11 or not 0<total<=256*1024*1024:raise ValueError('无效的系统资源清单')
        done=0;store=None
        for i in range(count):
            if self.cancel.is_set():return
            item=fetch(f'{base}/setup-{release}-{i}.json');digest=item.get('sha256','');length=item.get('bytes',0);relative=item.get('path','')
            if not re.fullmatch('[0-9a-f]{64}',digest) or not 0<length<=128*1024*1024 or item.get('index')!=i:raise ValueError('无效的资源记录')
            if item.get('kind')=='font' and re.fullmatch(r'fonts/ui_\d+\.cpfont',relative):destination=self.sd/'aster'/relative
            elif item.get('kind')=='store' and relative=='store/package.ast':destination=self.sd/'aster/system/setup/store.ast';store=destination
            else:raise ValueError('未知的系统资源类型')
            self.emit(6,done,total,i,count,relative);destination.parent.mkdir(parents=True,exist_ok=True)
            if destination.exists() and destination.stat().st_size==length and self.hash(destination)==digest:done+=length;continue
            partial=destination.with_name(destination.name+'.'+digest[:12]+'.part');offset=partial.stat().st_size if partial.exists() else 0
            if offset>length:raise ValueError('续传文件大小超过资源大小')
            if offset==length:
                if self.hash(partial)==digest:partial.replace(destination);done+=length;continue
                offset=0
            url=urllib.parse.urljoin(base+'/',item['url']);source_url(url)
            if urllib.parse.urlsplit(base).scheme=='https' and urllib.parse.urlsplit(url).scheme!='https':raise ValueError('拒绝下载源降级到 HTTP')
            headers={'Range':f'bytes={offset}-'} if offset else {}
            with self.opener.open(urllib.request.Request(url,headers=headers),timeout=30) as response:
                if offset and response.status==206:
                    content_range=response.headers.get('Content-Range','')
                    if not content_range.startswith(f'bytes {offset}-') or not content_range.endswith(f'/{length}'):raise ValueError('续传范围无效')
                elif response.status==200:offset=0
                else:raise ValueError(f'下载返回 HTTP {response.status}')
                received=offset
                with partial.open('ab' if offset else 'wb') as output:
                    while True:
                        if self.cancel.is_set():return
                        chunk=response.read(min(65536,length-received+1))
                        if not chunk:break
                        received+=len(chunk)
                        if received>length:raise ValueError('资源超过声明大小')
                        output.write(chunk);self.emit(6,done+received,total,i,count,relative)
            self.emit(7,done+received,total,i,count,relative)
            if received!=length or self.hash(partial)!=digest:raise ValueError('资源长度或 SHA-256 校验失败')
            partial.replace(destination);done+=length
        if store is None:raise ValueError('系统清单缺少商城')
        self.emit(8,done,total,count,count,'store/package.ast');self.complete.emit(str(store),source_url(profile['market_url']))
    @staticmethod
    def hash(file):
        digest=hashlib.sha256()
        with file.open('rb') as stream:
            for block in iter(lambda:stream.read(65536),b''):digest.update(block)
        return digest.hexdigest()
