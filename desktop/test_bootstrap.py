from pathlib import Path
import hashlib
import json
import sys
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
os.environ.setdefault('QT_QPA_PLATFORM','offscreen')
from PySide6.QtWidgets import QApplication
from bootstrap import Bootstrap,SecureRedirect,source_url
from urllib.request import Request

ROOT=Path(__file__).resolve().parents[1]
APP=QApplication.instance() or QApplication([])

class BootTests(unittest.TestCase):
    def test_verified_download_resume_and_atomic_promotion(self):
        self.download(False)
    def test_corrupt_resource_is_not_promoted(self):
        self.download(True)
    def download(self,corrupt):
        data=b'font-fixture'*100;digest=hashlib.sha256(data).hexdigest();release='a'*64;requests=[]
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                requests.append((self.path,self.headers.get('Range')))
                if self.path=='/source.json':value={'schema':1,'kind':'aster-static-source','base_url':base}
                elif self.path=='/setup-osptek-p4-st7102-riscv.json':value={'schema':2,'board':'osptek-p4-st7102','target':'riscv','release':release,'files':11,'total_bytes':len(data)*11,'market_url':base+'/source.json'}
                elif self.path.startswith('/setup-'):
                    index=int(self.path.rsplit('-',1)[1].split('.')[0]);value={'schema':1,'index':index,'kind':'store' if index==10 else 'font','path':'store/package.ast' if index==10 else f'fonts/ui_{[12,14,16,18,20,24,28,32,40,48][index]}.cpfont','bytes':len(data),'sha256':digest,'url':'blob'}
                elif self.path=='/blob':
                    offset=int(self.headers.get('Range','bytes=0-').split('=')[1].split('-')[0]);payload=data[offset:]
                    if corrupt:payload=b'x'*len(payload)
                    self.send_response(206 if offset else 200);self.send_header('Content-Length',str(len(payload)))
                    if offset:self.send_header('Content-Range',f'bytes {offset}-{len(data)-1}/{len(data)}')
                    self.end_headers();self.wfile.write(payload);return
                else:self.send_error(404);return
                payload=json.dumps(value).encode();self.send_response(200);self.send_header('Content-Length',str(len(payload)));self.end_headers();self.wfile.write(payload)
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler);base=f'http://127.0.0.1:{server.server_port}';thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        build=ROOT/'build';build.mkdir(exist_ok=True)
        try:
            with tempfile.TemporaryDirectory(prefix='bootstrap-test-',dir=build) as folder:
                sd=Path(folder);self.assertTrue(sd.resolve().is_relative_to(build.resolve()))
                target=sd/'aster/fonts/ui_12.cpfont';target.parent.mkdir(parents=True);target.with_name(target.name+'.'+digest[:12]+'.part').write_bytes(data[:100])
                boot=Bootstrap(sd,{'board':'osptek-p4-st7102','target':'riscv'},base+'/source.json',ROOT.parent/'aster-firmware/config/certificates/roots.pem');outcomes=[]
                boot.complete.connect(lambda file,market:outcomes.append(('ok',file)));boot.failed.connect(lambda error:outcomes.append(('error',error)))
                if corrupt:
                    with self.assertRaises(ValueError):boot.download()
                    self.assertFalse(target.exists())
                else:
                    boot.download();APP.processEvents()
                    self.assertTrue(target.exists());self.assertEqual(target.read_bytes(),data);self.assertTrue((sd/'aster/system/setup/store.ast').exists());self.assertTrue(any(header=='bytes=100-' for _,header in requests))
        finally:server.shutdown();server.server_close();thread.join()
    def test_source_validation_and_no_https_downgrade(self):
        with self.assertRaises(ValueError):source_url('https://user:password@example.org')
        with self.assertRaises(ValueError):source_url('file:///test')
        with self.assertRaises(ValueError):SecureRedirect().redirect_request(Request('https://example.org'),None,302,'',{},'http://example.org')

if __name__=='__main__':unittest.main()
