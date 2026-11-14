"""Verify the pinned build source and artifacts before GitHub publication."""
import hashlib,json,os,re,shutil,subprocess,urllib.request
from pathlib import Path
class SecureRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,request,fp,code,msg,headers,url):
        if not url.startswith('https://'):raise ValueError('HTTPS downgrade rejected')
        return super().redirect_request(request,fp,code,msg,headers,url)
def main():
    record=json.loads(Path('release/manifest.json').read_text())
    if os.environ.get('GITHUB_REF_TYPE')=='tag' and os.environ['GITHUB_REF_NAME']!=record['tag']:raise ValueError('Tag differs from publication manifest')
    if not re.fullmatch('[0-9a-f]{40}',record['source_revision']):raise ValueError('Invalid source revision')
    subprocess.run(['git','merge-base','--is-ancestor',record['source_revision'],'HEAD'],check=True)
    out=Path('release-output');out.mkdir(exist_ok=True)
    opener=urllib.request.build_opener(SecureRedirect());seen=set()
    for asset in record['assets']:
        name=asset['file']
        if Path(name).name!=name or '\\' in name or name in seen:raise ValueError('Invalid artifact name')
        seen.add(name)
        if not asset['url'].startswith('https://'):raise ValueError('HTTPS artifact required')
        h=hashlib.sha256();count=0
        with opener.open(asset['url'],timeout=180) as response,(out/name).open('wb') as f:
            while data:=response.read(1024*1024):
                h.update(data);count+=len(data);f.write(data)
        if h.hexdigest()!=asset['sha256'] or count!=asset['bytes']:raise ValueError('Artifact digest/size mismatch: '+name)
        print('Verified:',name,flush=True)
    shutil.copy2('release/manifest.json',out/'release-manifest.json')
    lines=[]
    for path in sorted(out.iterdir()):
        if path.name=='SHA256SUMS.txt':continue
        h=hashlib.sha256()
        with path.open('rb') as f:
            while data:=f.read(1024*1024):h.update(data)
        lines.append(h.hexdigest()+'  '+path.name+'\n')
    (out/'SHA256SUMS.txt').write_text(''.join(lines))
if __name__=='__main__':main()
