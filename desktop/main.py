"""Native Python window displaying Aster's real firmware UI and APP runtime."""
from __future__ import annotations
import argparse
import base64
import json
import hashlib
import os
from pathlib import Path
import shutil
import struct
import sys
import time
import tempfile
import tomllib

from PySide6.QtCore import Qt,QProcess,QTimer,Signal,QEvent,QSize,QUrl
from PySide6.QtMultimedia import QAudioFormat,QAudioSink,QMediaDevices,QMediaPlayer,QAudioOutput,QAudioBufferOutput
from PySide6.QtGui import QImage,QPainter,QColor,QKeySequence,QShortcut,QCloseEvent,QFontDatabase
from PySide6.QtWidgets import (QApplication,QMainWindow,QWidget,QVBoxLayout,QHBoxLayout,QLabel,
    QPushButton,QComboBox,QSpinBox,QFileDialog,QMessageBox,QPlainTextEdit,QSplitter,QFrame,QInputDialog)
from bootstrap import Bootstrap
from recording import AudioTracks
from install_dialog import InstallDialog

ROOT=Path(__file__).resolve().parents[1]
CONFIG_DIR=ROOT.parent/'aster-firmware/config'
def distribution():
    config=json.loads((CONFIG_DIR/'distribution.json').read_text(encoding='utf-8-sig'))
    return config,(CONFIG_DIR/config['ca_bundle']).resolve()
PROFILES={
 'p4':{'label':'ESP32-P4 · 480 × 480','width':480,'height':480,'board':'osptek-p4-st7102','arch':3,'soc':'esp32p4','touch':5,'target':'riscv'},
 'lckfb':{'label':'lckfb · 240 × 320','width':240,'height':320,'board':'aster.esp32s3.lckfb','arch':1,'soc':'esp32s3','touch':2,'target':'xtensa'},
 'custom':{'label':'自定义分辨率','width':320,'height':480,'board':'aster.simulator','arch':4,'soc':'host','touch':5,'target':'riscv'},
}

class Screen(QWidget):
    touched=Signal(int,int,int,int)
    def __init__(self):
        super().__init__();self.image=QImage();self.zoom=1;self.contacts={};self.mouse_down=False
        self.setAttribute(Qt.WidgetAttribute.WA_AcceptTouchEvents);self.setMouseTracking(True);self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
    def sizeHint(self):return self.image.size()*self.zoom if not self.image.isNull() else QSize(480,480)
    def set_image(self,image):
        changed=self.image.size()!=image.size();self.image=image
        if changed:self.updateGeometry()
        self.update()
    def rect_on_widget(self):
        if self.image.isNull():return None
        width=self.image.width()*self.zoom;height=self.image.height()*self.zoom
        from PySide6.QtCore import QRect
        return QRect((self.width()-width)//2,(self.height()-height)//2,width,height)
    def position(self,p):
        area=self.rect_on_widget()
        if not area:return None
        x=int((p.x()-area.x())/self.zoom);y=int((p.y()-area.y())/self.zoom)
        return max(0,min(self.image.width()-1,x)),max(0,min(self.image.height()-1,y))
    def paintEvent(self,event):
        painter=QPainter(self);painter.fillRect(self.rect(),QColor('#111315'))
        area=self.rect_on_widget()
        if area:painter.drawImage(area,self.image)
    def mousePressEvent(self,event):
        if event.button()!=Qt.MouseButton.LeftButton:return
        area=self.rect_on_widget()
        if not area or not area.contains(event.position().toPoint()):return
        self.mouse_down=True;self.setFocus();p=self.position(event.position());self.touched.emit(1,*p,0)
    def mouseMoveEvent(self,event):
        if self.mouse_down:self.touched.emit(2,*self.position(event.position()),0)
    def mouseReleaseEvent(self,event):
        if self.mouse_down and event.button()==Qt.MouseButton.LeftButton:self.mouse_down=False;self.touched.emit(3,*self.position(event.position()),0)
    def release_all(self):
        if self.mouse_down:self.mouse_down=False;self.touched.emit(3,0,0,0)
        for slot,p in list(self.contacts.values()):self.touched.emit(3,*p,slot)
        self.contacts.clear()
    def event(self,event):
        if event.type() in (QEvent.Type.TouchBegin,QEvent.Type.TouchUpdate,QEvent.Type.TouchEnd):
            from PySide6.QtGui import QEventPoint
            for point in event.points():
                key=point.id();state=point.state();p=self.position(point.position())
                if not p:continue
                if state==QEventPoint.State.Pressed:
                    used={v[0] for v in self.contacts.values()};slot=next((n for n in range(5) if n not in used),None)
                    if slot is None:continue
                    self.contacts[key]=(slot,p);self.touched.emit(1,*p,slot)
                elif key in self.contacts:
                    slot,_=self.contacts[key];self.contacts[key]=(slot,p)
                    if state==QEventPoint.State.Released:self.touched.emit(3,*p,slot);del self.contacts[key]
                    elif state==QEventPoint.State.Updated:self.touched.emit(2,*p,slot)
            return True
        if event.type() in (QEvent.Type.TouchCancel,QEvent.Type.WindowDeactivate):self.release_all()
        return super().event(event)

class Window(QMainWindow):
    def __init__(self,args):
        super().__init__();self.args=args;self.setWindowTitle(args.title or 'Aster · 系统模拟器')
        # The Qt offscreen platform does not enumerate Windows system fonts.
        if sys.platform=='win32' and not QFontDatabase.families():
            font=Path(os.environ.get('WINDIR','C:/Windows'))/'Fonts/msyh.ttc'
            if font.exists():QFontDatabase.addApplicationFont(str(font))
        self.profile_key=args.profile;self.profile=PROFILES[self.profile_key];self.state_base=Path(args.state).resolve()
        self.native_buffer=bytearray();self.bridge_buffer=bytearray();self.catalog=[];self.active=None;self.overlay=False
        self.core=None;self.core_generation=0;self.pending_tick=False;self.last_tick=time.monotonic();self.encoder=None;self.record_frames=0;self.record_since=0;self.closing=False
        self.record_audio=None;self.record_folder=None;self.muxer=None
        self.bootstrap=None;self.installing_bootstrap=False
        self.startup_app=getattr(args,'app',None);self.debug_mode=bool(self.startup_app);self.import_busy=False;self.import_serial=0;self.import_request=None;self.install_dialog=None;self.launch_after_import=False;self.pending_launch=None
        self.native_size=(args.width or self.profile['width'],args.height or self.profile['height']);self.base_size=self.native_size
        self.pcm_queue=bytearray();audio_format=QAudioFormat();audio_format.setSampleRate(48000);audio_format.setChannelCount(2);audio_format.setSampleFormat(QAudioFormat.SampleFormat.Int16)
        audio_device=QMediaDevices.defaultAudioOutput();self.audio_sink=None;self.pcm_io=None
        if not audio_device.isNull() and audio_device.isFormatSupported(audio_format):
            self.audio_sink=QAudioSink(audio_device,audio_format,self);self.audio_sink.setBufferSize(19200);self.pcm_io=self.audio_sink.start()
        self.music=QMediaPlayer(self);self.music_output=QAudioOutput(self);self.music.setAudioOutput(self.music_output);self.music_session=None
        self.music_buffers=QAudioBufferOutput(audio_format,self);self.music.setAudioBufferOutput(self.music_buffers);self.music_buffers.audioBufferReceived.connect(self.capture_music)
        self.music.durationChanged.connect(self.music_duration);self.music.mediaStatusChanged.connect(self.music_status)
        self.screen=Screen();self.screen.touched.connect(self.touch)
        self.logs=QPlainTextEdit();self.logs.setReadOnly(True);self.logs.document().setMaximumBlockCount(500);self.logs.hide()
        self.status=QLabel('准备系统…');self.statusBar().addWidget(self.status)
        self.device=QComboBox()
        for key,value in PROFILES.items():self.device.addItem(value['label'],key)
        self.device.setCurrentIndex(list(PROFILES).index(args.profile));self.device.currentIndexChanged.connect(self.choose_profile)
        self.width_box=QSpinBox();self.height_box=QSpinBox()
        for box,value in zip([self.width_box,self.height_box],self.base_size):box.setRange(240,1280);box.setSingleStep(2);box.setValue(value)
        self.zoom=QComboBox();self.zoom.addItems(['1×','2×','3×']);self.zoom.currentIndexChanged.connect(self.change_zoom)
        toolbar=QHBoxLayout();toolbar.setContentsMargins(14,10,14,10);toolbar.setSpacing(8)
        for widget in [self.device,self.width_box,QLabel('×'),self.height_box]:toolbar.addWidget(widget)
        toolbar.addWidget(self.button('应用尺寸',self.apply_geometry));toolbar.addWidget(self.zoom);toolbar.addStretch()
        self.home_button=self.button('主页',self.go_home);self.install_button=self.button('安装 APP',self.import_app)
        self.shot_button=self.button('截图',self.screenshot_dialog);self.record_button=self.button('录屏',self.record_dialog)
        self.record_button.setToolTip('导出原始屏幕画面及模拟器内的系统音效、APP 音效和背景音乐为 MP4')
        for button in [self.home_button,self.install_button,self.shot_button,self.record_button,self.button('日志',lambda:self.logs.setVisible(not self.logs.isVisible()))]:toolbar.addWidget(button)
        top=QWidget();top.setLayout(toolbar);splitter=QSplitter(Qt.Orientation.Vertical);splitter.addWidget(self.screen);splitter.addWidget(self.logs);splitter.setStretchFactor(0,1)
        central=QWidget();layout=QVBoxLayout(central);layout.setContentsMargins(0,0,0,0);layout.setSpacing(0);layout.addWidget(top);layout.addWidget(splitter);self.setCentralWidget(central)
        self.setStyleSheet('QMainWindow,QWidget{font-family:"Microsoft YaHei UI";font-size:12px;color:#20261d;} QMainWindow{background:#f5f5f2;} QPushButton{padding:6px 12px;border:1px solid #d8dcd7;border-radius:6px;background:white;color:#20261d;} QPushButton:hover{background:#eaf0e5;} QComboBox,QSpinBox{padding:5px;border:1px solid #d8dcd7;border-radius:5px;background:white;color:#20261d;} QPlainTextEdit{background:#151815;color:#d8e0d1;} QStatusBar{color:#596050;}')
        self.resize(max(1000,self.base_size[0]+60),self.base_size[1]+150)
        QShortcut(QKeySequence('Escape'),self,activated=self.go_home);QShortcut(QKeySequence('Ctrl+Shift+S'),self,activated=self.screenshot_dialog);QShortcut(QKeySequence('Ctrl+Shift+R'),self,activated=self.record_dialog)
        self.bridge=QProcess(self);self.bridge.readyReadStandardOutput.connect(self.read_bridge);self.bridge.readyReadStandardError.connect(lambda:self.log(bytes(self.bridge.readAllStandardError()).decode(errors='replace')))
        self.bridge.errorOccurred.connect(lambda error:self.error('APP 服务启动失败，请检查 Node.js 安装。'))
        node=os.environ.get('ASTER_SIM_NODE') or (str(ROOT/'.tools/desktop/node.exe') if (ROOT/'.tools/desktop/node.exe').exists() else shutil.which('node'))
        if not node:raise RuntimeError('需要 Node.js 22 或更高版本。')
        self.bridge.start(node,[str(ROOT/'src/desktop-bridge.js')])
        if not self.bridge.waitForStarted(5000):raise RuntimeError('无法启动 APP 服务')
        self.seed();self.configure_bridge();self.start_core(*self.base_size)
        self.timer=QTimer(self);self.timer.timeout.connect(self.tick);self.timer.start(16)
        self.record_timer=QTimer(self);self.record_timer.timeout.connect(self.record_frame);self.record_timer.setInterval(33)
        self.audio_timer=QTimer(self);self.audio_timer.timeout.connect(self.flush_audio);self.audio_timer.start(10)
    def button(self,title,action):
        button=QPushButton(title);button.clicked.connect(action);return button
    def log(self,message):
        if message.strip():self.logs.appendPlainText(message.strip())
    def error(self,message):
        self.log(message);self.status.setText(message)
        if not self.args.smoke:QMessageBox.warning(self,'Aster',message)
    def state(self):return self.state_base/self.profile_key
    def sd(self):return self.state()/'shared/sd'
    def seed(self):
        for relative in ['aster/fonts','aster/apps','aster/system/kv']:(self.sd()/relative).mkdir(parents=True,exist_ok=True)
        if self.args.seed_local or self.debug_mode:
            fonts=ROOT.parent/'aster-firmware/resources/fonts'
            for file in fonts.glob('ui_*.cpfont'):
                dest=self.sd()/'aster/fonts'/file.name
                if not dest.exists():shutil.copy2(file,dest)
    def send_bridge(self,message):
        if self.bridge.state()==QProcess.ProcessState.Running:self.bridge.write((json.dumps(message,ensure_ascii=False)+'\n').encode())
    def configure_bridge(self):
        profile=self.profile
        self.send_bridge({'type':'configure','options':{'state':str(self.state()),'width':self.base_size[0],'height':self.base_size[1],
            'network':True,'wifi':True,'noAudio':False,'maxTouchPoints':profile['touch'],
            'deviceProfile':{**{k:profile[k] for k in ['board','arch','soc']},'platform':'simulator' if self.profile_key=='custom' else 'desktop'},
            'networkCA':str(distribution()[1]),
            'firmwareFonts':str(self.sd()/'aster/fonts'),
            'missingFeatures':['accelerometer','gyroscope'] if self.profile_key=='p4' else []}})
        self.seed_store=self.args.seed_local
    def native_command(self,command):
        if self.core and self.core.state()==QProcess.ProcessState.Running:self.core.write((command+'\n').encode())
    def start_core(self,width,height):
        self.core_generation+=1;generation=self.core_generation
        if self.core:
            self.core.readyReadStandardOutput.disconnect();self.core.kill();self.core.waitForFinished(3000);self.core.deleteLater()
        self.native_size=(width,height);self.native_buffer.clear();self.pending_tick=False
        self.core=QProcess(self);core=self.core
        core.readyReadStandardOutput.connect(lambda:self.read_native(generation));core.readyReadStandardError.connect(lambda:self.log(bytes(core.readAllStandardError()).decode(errors='replace')))
        executable=ROOT/('build/desktop-windows/aster-desktop-core.exe' if sys.platform=='win32' else 'build/desktop-core/aster-desktop-core')
        if not executable.exists():raise RuntimeError('请先运行 python desktop/build_native.py 构建系统界面。')
        if sys.platform=='win32':
            digest=hashlib.sha256(executable.read_bytes()).hexdigest();snapshot=ROOT/'.tools/desktop'/f'core-{digest[:24]}.exe';snapshot.parent.mkdir(parents=True,exist_ok=True)
            if not snapshot.exists():shutil.copy2(executable,snapshot)
            elif hashlib.sha256(snapshot.read_bytes()).hexdigest()!=digest:raise RuntimeError('系统界面运行副本校验失败')
            executable=snapshot
        core.finished.connect(lambda code,status:self.core_finished(generation,code))
        core.start(str(executable),[str(width),str(height),str(self.sd())])
        if not core.waitForStarted(5000):raise RuntimeError('系统界面进程启动失败')
        self.sync_catalog()
        if self.active:self.native_command('H')
        self.last_tick=time.monotonic()
    def core_finished(self,generation,code):
        if generation==self.core_generation and not self.closing:self.pending_tick=False;self.error(f'系统界面进程已退出（{code}），请检查日志。')
    def sync_catalog(self):
        if not self.core:return
        def clean(value):return str(value).replace('\t',' ').replace('\n',' ').replace('\r',' ')
        self.native_command('C')
        for app in self.catalog:self.native_command('A\t'+'\t'.join(clean(app.get(k,'')) for k in ['id','name','description','version','category']))
        self.native_command('I '+str(int(self.dependencies_ready())))
        if not self.active:self.native_command('R')
    def dependencies_ready(self):
        return (self.debug_mode or any(app['id']=='aster.store' for app in self.catalog)) and all((self.sd()/f'aster/fonts/ui_{px}.cpfont').exists() for px in [12,14,16,18,20,24,28,32,40,48])
    def begin_setup(self):
        if self.bootstrap and self.bootstrap.thread and self.bootstrap.thread.is_alive():return
        config,ca=distribution()
        source,ok=QInputDialog.getText(self,'模拟联网','模拟器使用电脑当前网络，无需连接虚拟热点。\n系统资源服务器：',text=config['source_url'])
        if not ok:return
        if self.profile_key=='custom':self.error('首次联网准备请先选择 P4 或 lckfb；准备后可修改宽高测试布局。');return
        try:self.bootstrap=Bootstrap(self.sd(),self.profile,source,ca)
        except Exception as error:self.error(str(error));return
        self.bootstrap.progress.connect(self.setup_progress);self.bootstrap.complete.connect(self.setup_complete);self.bootstrap.failed.connect(self.setup_failed);self.bootstrap.start()
    def setup_progress(self,data):
        self.native_command(f"S {data['phase']} {data['bytes']} {data['total']} {data['index']} {data['files']} {data['seconds']} {data['file'] or '-'}")
    def setup_complete(self,file,market):
        self.installing_bootstrap=True
        kv=self.state()/'aster.store/kv';kv.mkdir(parents=True,exist_ok=True);(kv/'store.url'.encode().hex()).write_bytes(market.encode()+b'\0')
        self.send_bridge({'type':'import','file':file})
    def setup_failed(self,message):self.native_command('K -5');self.error(message)
    def read_native(self,generation):
        if generation!=self.core_generation:return
        self.native_buffer.extend(bytes(self.core.readAllStandardOutput()))
        while len(self.native_buffer)>=12:
            magic,kind,size=struct.unpack_from('<III',self.native_buffer)
            if magic!=0x4d495341 or size>16*1024*1024:self.error('系统界面通信数据无效');self.core.kill();return
            if len(self.native_buffer)<12+size:break
            data=bytes(self.native_buffer[12:12+size]);del self.native_buffer[:12+size]
            if kind==1:
                w,h=struct.unpack_from('<II',data);pixels=data[8:]
                if len(pixels)!=w*h*2:continue
                if not self.active or self.overlay:self.screen.set_image(QImage(pixels,w,h,w*2,QImage.Format.Format_RGB16).copy())
            elif kind==2:
                action,_,value=data.decode('utf-8',errors='replace').partition('\t')
                if action=='launch':self.start_app(value)
                elif action=='uninstall':self.send_bridge({'type':'uninstall','id':value})
                elif action=='home':self.go_home()
                elif action=='touch':
                    a,x,y,slot=map(int,value.split());self.send_bridge({'type':'touch','action':a,'x':x,'y':y,'slot':slot})
                elif action=='overlay':self.overlay=value=='1';self.send_bridge({'type':'pause'})
                elif action=='volume':
                    volume=max(0,min(100,int(value)));self.music_output.setVolume(volume/100);self.send_bridge({'type':'volume','volume':volume})
                elif action=='setup':QTimer.singleShot(0,self.begin_setup)
            elif kind==3:
                if self.record_audio:self.record_audio.add('effects',data,at=time.monotonic()-len(data)/192000)
                if self.pcm_io:
                    self.pcm_queue.extend(data)
                    if len(self.pcm_queue)>384000:del self.pcm_queue[:-19200]
                    self.flush_audio()
            elif kind==4:self.pending_tick=False
    def read_bridge(self):
        self.bridge_buffer.extend(bytes(self.bridge.readAllStandardOutput()))
        while b'\n' in self.bridge_buffer:
            line,_,self.bridge_buffer=self.bridge_buffer.partition(b'\n')
            try:self.bridge_message(json.loads(line))
            except Exception as error:self.error(str(error))
    def bridge_message(self,message):
        if message.get('state') and Path(message['state']).resolve()!=self.state().resolve():return
        kind=message.get('type')
        if kind=='catalog':
            self.catalog=message['apps'];self.sync_catalog()
            if self.installing_bootstrap and self.dependencies_ready():
                self.installing_bootstrap=False;self.native_command('S 9 1 1 11 11 0 done');self.native_command('R')
            if not self.active:self.status.setText(f"{self.profile['label']} · 系统桌面 · {len(self.catalog)} 个应用")
            if self.seed_store:
                self.seed_store=False
                if not any(app['id']=='aster.store' for app in self.catalog):
                    file=ROOT.parent/'aster-apps/AppStore/dist'/self.profile['target']/'aster.store.ast'
                    if file.exists():self.send_bridge({'type':'import','file':str(file)})
            if self.startup_app and (not self.args.seed_local or any(a['id']=='aster.store' for a in self.catalog)):
                file=self.startup_app;self.startup_app=None
                QTimer.singleShot(0,lambda:self.install_package(file,getattr(self.args,'resources',None),launch=True))
        elif kind=='ready':
            self.active=message['manifest'];self.overlay=False;size=(message['width'],message['height'])
            if size!=self.native_size:self.start_core(*size)
            else:self.native_command('H')
            self.status.setText(f"{self.active.get('name')} · {size[0]} × {size[1]} · WASM 桌面执行")
        elif kind=='frame':
            image=QImage.fromData(base64.b64decode(message['data']),'PNG')
            if not image.isNull() and self.active:
                if not self.overlay:self.screen.set_image(image)
                if self.core and self.core.bytesToWrite()<2*1024*1024 and not self.overlay:
                    frame=image.convertToFormat(QImage.Format.Format_RGB16);raw=bytes(frame.constBits())
                    # QImage pads rows; the native port expects a tightly packed frame.
                    raw=b''.join(raw[y*frame.bytesPerLine():y*frame.bytesPerLine()+frame.width()*2] for y in range(frame.height()))
                    self.core.write(f'B {len(raw)}\n'.encode()+raw)
        elif kind=='home':
            if self.active:
                self.active=None;self.overlay=False
                if self.native_size!=self.base_size:self.start_core(*self.base_size)
                else:self.native_command('R')
            self.status.setText(f"{self.profile['label']} · 系统桌面 · {len(self.catalog)} 个应用")
            if message.get('error'):self.error(message['error'])
            if self.pending_launch:
                id=self.pending_launch;self.pending_launch=None;QTimer.singleShot(0,lambda:self.start_app(id))
        elif kind=='log':self.log(message.get('message',''))
        elif kind=='error':self.error(message['message'])
        elif kind=='install':
            if self.import_busy and message.get('request')==self.import_request:self.install_dialog.update_progress(message)
            elif not message.get('request'):self.status.setText('正在安装资源…' if message['phase']=='copy' else '安装完成')
        elif kind=='imported' and self.import_busy and message.get('request')==self.import_request:
            self.import_busy=False;self.install_button.setEnabled(True);self.home_button.setEnabled(True)
            app=next((a for a in self.catalog if a['id']==message['id']),{});name=app.get('name',message['id'])
            self.install_dialog.finish(message['id'],name);self.status.setText('安装成功：'+name);self.log('安装成功：'+name+' ('+message['id']+')')
            if self.launch_after_import:self.install_dialog.accept();self.open_installed(message['id'])
        elif kind=='import-failed':
            if self.import_busy and message.get('request')==self.import_request:
                self.import_busy=False;self.install_button.setEnabled(True);self.home_button.setEnabled(True);self.install_dialog.fail(message['message']);self.status.setText('安装失败：'+message['message']);self.log('安装失败：'+message['message'])
            else:self.error('安装失败：'+message['message'])
        elif kind=='audio':self.audio_message(message)
    def flush_audio(self):
        if self.pcm_io and self.pcm_queue:
            size=min(len(self.pcm_queue),self.audio_sink.bytesFree())
            if size:
                written=self.pcm_io.write(bytes(self.pcm_queue[:size]))
                if written>0:del self.pcm_queue[:written]
    def audio_message(self,message):
        op=message.get('op');handle=message.get('handle',0)
        if op=='effect-load':
            data=base64.b64decode(message['data']);info=message['info'];pcm=data[info['offset']:info['offset']+info['bytes']]
            if self.core:self.core.write(f"L {handle} {info['rate']} {info['channels']} {len(pcm)}\n".encode()+pcm)
        elif op=='effect':
            d=message.get('desc') or {'flags':0,'start':0,'end':0,'fade':0,'pitch':65536,'gain':65536,'ms':0}
            self.native_command(f"E {handle} "+' '.join(str(d[k]) for k in ['flags','start','end','fade','pitch','gain','ms']))
        elif op=='effect-params':
            p=message['params'];self.native_command(f"U {handle} {p['pitch']} {p['gain']} {p['ms']}")
        elif op=='effect-stop':self.native_command(f"V {handle} {message['ms']}")
        elif op=='effect-unload':self.native_command(f'X {handle}')
        elif op=='effect-suspend':self.native_command('Y '+str(int(message['paused'])))
        elif op=='start':
            if self.record_audio:self.record_audio.reset('music')
            data=base64.b64decode(message['data']);self.music_session=message['session'];suffix='.wav' if data[:4]==b'RIFF' else '.mp3'
            cache=self.state()/'audio';cache.mkdir(parents=True,exist_ok=True);file=cache/f'music-{time.time_ns()}{suffix}';file.write_bytes(data)
            self.music.setSource(QUrl.fromLocalFile(str(file)));self.music_output.setVolume(message.get('volume',70)/100);self.music.play()
        elif op=='stop':
            self.native_command('Z');self.music_session=None;self.music.stop();self.music.setSource(QUrl());self.pcm_queue.clear()
            if self.record_audio:self.record_audio.reset('music')
        elif op=='pause':self.music.pause()
        elif op=='resume':
            if self.record_audio:self.record_audio.reset('music')
            self.music.play()
        elif op=='seek':
            if self.record_audio:self.record_audio.reset('music')
            self.music.setPosition(message['ms'])
        elif op=='volume':self.native_command(f"W {message['volume']}");self.music_output.setVolume(message['volume']/100)
    def music_duration(self,duration):
        if self.music_session and duration>0:self.send_bridge({'type':'audio-feedback','session':self.music_session,'event':'started','durationMs':duration,'positionMs':self.music.position()})
    def music_status(self,status):
        if not self.music_session:return
        if status==QMediaPlayer.MediaStatus.EndOfMedia:self.send_bridge({'type':'audio-feedback','session':self.music_session,'event':'ended'})
        elif status==QMediaPlayer.MediaStatus.InvalidMedia:self.send_bridge({'type':'audio-feedback','session':self.music_session,'event':'error'})
    def capture_music(self,buffer):
        if not self.record_audio or not buffer.isValid() or self.music.playbackState()!=QMediaPlayer.PlaybackState.PlayingState:return
        format=buffer.format()
        if format.sampleRate()!=48000 or format.channelCount()!=2 or format.sampleFormat()!=QAudioFormat.SampleFormat.Int16:
            self.error('背景音乐录音格式无效，请检查 Qt FFmpeg 后端。');return
        gain=0 if self.music_output.isMuted() else self.music_output.volume()
        self.record_audio.add('music',bytes(buffer.constData()),gain=gain)
    def start_app(self,id):
        if self.active:return
        self.send_bridge({'type':'start','id':id})
    def go_home(self):
        self.screen.release_all();self.send_bridge({'type':'home'})
    def touch(self,action,x,y,slot):
        if slot<self.profile['touch']:self.native_command(f'P {action} {x} {y} {slot}')
    def tick(self):
        if not self.core or self.core.state()!=QProcess.ProcessState.Running:return
        if self.pending_tick:return
        now=time.monotonic();elapsed=max(1,min(100,int((now-self.last_tick)*1000)));self.last_tick=now;self.pending_tick=True;self.native_command(f'T {elapsed}')
    def choose_profile(self):
        profile=PROFILES[self.device.currentData()];self.width_box.setValue(profile['width']);self.height_box.setValue(profile['height'])
    def apply_geometry(self):
        if self.import_busy:self.error('请等待应用安装完成后再切换设备。');return
        if self.encoder:self.error('请先结束录屏再切换设备或尺寸。');return
        if self.bootstrap and self.bootstrap.thread and self.bootstrap.thread.is_alive():self.error('请等待系统资源下载完成后再切换设备。');return
        self.screen.release_all();self.profile_key=self.device.currentData();self.profile=PROFILES[self.profile_key];self.base_size=(self.width_box.value(),self.height_box.value());self.active=None;self.catalog=[]
        self.seed();self.configure_bridge();self.start_core(*self.base_size)
    def change_zoom(self,index):self.screen.zoom=index+1;self.screen.updateGeometry();self.screen.update();self.resize(max(1000,self.native_size[0]*(index+1)+50),self.native_size[1]*(index+1)+150)
    def import_app(self):
        if self.active:self.error('请先返回主页再安装 APP。');return
        file,_=QFileDialog.getOpenFileName(self,'安装 Aster 应用','','Aster 应用 (*.ast)')
        if not file:return
        resources=None
        if QMessageBox.question(self,'外部资源','此应用是否还需要导入一个外部资源目录？')==QMessageBox.StandardButton.Yes:resources=QFileDialog.getExistingDirectory(self,'选择对应的资源目录') or None
        self.install_package(file,resources)
    def install_package(self,file,resources=None,launch=False):
        if self.import_busy or self.active:self.error('请先返回主页并等待当前安装完成。');return
        if self.install_dialog:self.install_dialog.close();self.install_dialog.deleteLater()
        self.import_serial+=1;self.import_request=str(self.import_serial);self.import_busy=True;self.launch_after_import=launch
        self.install_dialog=InstallDialog(self);self.install_dialog.open_app.connect(self.open_installed);self.install_dialog.show()
        self.install_button.setEnabled(False);self.home_button.setEnabled(False);self.status.setText('正在安装应用…')
        self.send_bridge({'type':'import','request':self.import_request,'file':str(file),'resources':str(resources) if resources else None})
    def open_installed(self,id):
        if self.active:self.pending_launch=id;self.go_home()
        else:self.start_app(id)
    def save_screenshot(self,path):
        if self.screen.image.isNull():return False
        Path(path).parent.mkdir(parents=True,exist_ok=True);return self.screen.image.save(str(path),'PNG')
    def screenshot_dialog(self):
        file,_=QFileDialog.getSaveFileName(self,'保存屏幕截图',f'aster-{self.profile_key}.png','PNG 图片 (*.png)')
        if file and self.save_screenshot(file):self.status.setText('截图已保存：'+file)
    def record_dialog(self):
        if self.encoder:self.stop_recording();return
        file,_=QFileDialog.getSaveFileName(self,'保存屏幕录像',f'aster-{self.profile_key}.mp4','MP4 视频 (*.mp4)')
        if file:self.start_recording(file)
    def start_recording(self,file):
        if self.encoder or self.muxer:return
        image=self.screen.image
        if image.isNull():return
        if image.width()%2 or image.height()%2:self.error('MP4 录制需要偶数宽高，请调整分辨率。');return
        self.record_path=str(Path(file).resolve());Path(self.record_path).parent.mkdir(parents=True,exist_ok=True)
        self.record_folder=Path(tempfile.mkdtemp(prefix='.aster-record-',dir=Path(self.record_path).parent))
        self.record_size=image.size();self.encoder=QProcess(self);encoder=self.encoder;ffmpeg=shutil.which('ffmpeg');arguments=[]
        if not ffmpeg and sys.platform=='win32':
            ffmpeg='wsl';arguments=['-d',self.args.wsl,'--','ffmpeg']
        if not ffmpeg:self.encoder=None;self.cleanup_record_folder();self.error('录屏需要 FFmpeg。');return
        self.record_ffmpeg=ffmpeg;self.record_prefix=arguments[:];self.record_wsl=ffmpeg=='wsl'
        output=self.record_file(self.record_folder/'video.mp4')
        arguments+=['-hide_banner','-loglevel','error','-y','-f','rawvideo','-pixel_format','rgb24','-video_size',f'{image.width()}x{image.height()}','-framerate','30','-i','pipe:0','-an','-c:v','libx264','-preset','veryfast','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',output]
        encoder.readyReadStandardError.connect(lambda:self.log(bytes(encoder.readAllStandardError()).decode(errors='replace')));encoder.start(ffmpeg,arguments)
        if not encoder.waitForStarted(5000):self.encoder=None;encoder.deleteLater();self.cleanup_record_folder();self.error('无法启动 FFmpeg。');return
        self.record_frames=0;self.record_since=time.monotonic();self.record_audio=AudioTracks(self.record_folder,self.record_since);self.record_button.setText('■ 结束录屏');self.record_timer.start()
    def record_file(self,file):
        value=Path(file).resolve().as_posix()
        return '/mnt/'+value[0].lower()+value[2:] if self.record_wsl else value
    def cleanup_record_folder(self):
        if self.record_audio:self.record_audio.abort();self.record_audio=None
        if self.record_folder:
            # Only the uniquely created recording directory is removed.
            folder=self.record_folder;self.record_folder=None
            if folder.name.startswith('.aster-record-') and folder.parent==Path(self.record_path).parent:shutil.rmtree(folder)
    def record_frame(self):
        if not self.encoder:return
        if self.encoder.state()!=QProcess.ProcessState.Running:self.stop_recording();return
        image=self.screen.image
        if image.size()!=self.record_size:self.stop_recording();self.error('屏幕方向变化，已结束本段录制。');return
        if self.encoder.bytesToWrite()>4*1024*1024:return
        frame=image.convertToFormat(QImage.Format.Format_RGB888);data=bytes(frame.constBits());raw=b''.join(data[y*frame.bytesPerLine():y*frame.bytesPerLine()+frame.width()*3] for y in range(frame.height()))
        # Preserve wall-clock duration after encoder startup/backpressure. Repeating
        # the latest image is preferable to silently speeding up the exported clip.
        target=max(1,int((time.monotonic()-self.record_since)*30))
        count=min(6,max(0,target-self.record_frames))
        if count:self.encoder.write(raw*count);self.record_frames+=count
        self.record_button.setText(f'■ {int(time.monotonic()-self.record_since):02d}s')
    def stop_recording(self):
        if not self.encoder:return
        self.record_timer.stop();encoder=self.encoder;self.encoder=None
        tracks=self.record_audio;self.record_audio=None
        if tracks:tracks.close(self.record_frames*1600)
        encoder.closeWriteChannel()
        if not encoder.waitForFinished(10000):encoder.kill();encoder.waitForFinished(2000)
        self.record_button.setText('录屏')
        if encoder.exitStatus()==QProcess.ExitStatus.NormalExit and encoder.exitCode()==0 and self.record_frames and tracks:
            self.status.setText('正在合成录像声音…');self.record_button.setEnabled(False);self.record_button.setText('正在导出…')
            self.muxer=QProcess(self);muxer=self.muxer
            args=self.record_prefix+['-hide_banner','-loglevel','error','-y','-i',self.record_file(self.record_folder/'video.mp4')]
            for name in ('effects','music'):args+=['-f','s16le','-ar','48000','-ac','2','-i',self.record_file(tracks.paths[name])]
            args+=['-filter_complex','[1:a][2:a]amix=inputs=2:duration=longest:normalize=0[a]','-map','0:v:0','-map','[a]','-c:v','copy','-c:a','aac','-b:a','192k','-t',str(self.record_frames/30),'-movflags','+faststart',self.record_file(self.record_folder/'complete.mp4')]
            muxer.readyReadStandardError.connect(lambda:self.log(bytes(muxer.readAllStandardError()).decode(errors='replace')))
            muxer.finished.connect(self.record_mux_finished)
            muxer.errorOccurred.connect(lambda error:self.record_mux_finished(-1,QProcess.ExitStatus.CrashExit) if error==QProcess.ProcessError.FailedToStart else None)
            muxer.start(self.record_ffmpeg,args)
        else:self.error('录像未成功完成；临时数据保存在 '+str(self.record_folder))
        encoder.deleteLater()
    def record_mux_finished(self,code,status):
        muxer=self.muxer
        if not muxer:return
        self.muxer=None;self.record_button.setEnabled(True);self.record_button.setText('录屏')
        try:
            if code!=0 or status!=QProcess.ExitStatus.NormalExit:raise RuntimeError('声音合成失败')
            os.replace(self.record_folder/'complete.mp4',self.record_path);self.cleanup_record_folder();self.status.setText('有声录像已保存：'+self.record_path)
        except Exception as error:self.error(str(error)+'；临时数据保存在 '+str(self.record_folder))
        muxer.deleteLater()
    def closeEvent(self,event:QCloseEvent):
        self.closing=True;self.timer.stop();self.screen.release_all();self.stop_recording();self.send_bridge({'type':'quit'});self.bridge.closeWriteChannel()
        muxer=self.muxer
        if muxer and not muxer.waitForFinished(30000):
            muxer.kill();muxer.waitForFinished(2000)
        if self.bootstrap:self.bootstrap.cancel.set()
        self.audio_timer.stop();self.music_session=None;self.music.stop();self.music.setSource(QUrl())
        if self.audio_sink:self.audio_sink.stop()
        if not self.bridge.waitForFinished(3000):self.bridge.kill();self.bridge.waitForFinished(1000)
        if self.core:self.core.kill();self.core.waitForFinished(3000)
        event.accept()

def parse_args(argv=None):
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--profile',choices=PROFILES,default='p4');parser.add_argument('--width',type=int);parser.add_argument('--height',type=int);parser.add_argument('--state',default=str(ROOT/'state/desktop'));parser.add_argument('--title');parser.add_argument('--wsl',default='Ubuntu-22.04');parser.add_argument('--smoke',action='store_true');parser.add_argument('--seed-local',action='store_true',help='Developer shortcut: seed local fonts and compiled Store instead of first-boot download');parser.add_argument('--app',help='Install and launch an AST package or the compiled project directory');parser.add_argument('--resources',help='External resource root (defaults to resources beside the package)');args=parser.parse_args(argv)
    for dimension in (args.width,args.height):
        if dimension is not None and not 240<=dimension<=1280:parser.error('尺寸范围为 240..1280')
    if args.resources and not args.app:parser.error('--resources 需要同时指定 --app')
    if args.app:
        file=Path(args.app).resolve()
        if file.is_dir():
            try:
                with (file/'app.toml').open('rb') as stream:manifest=tomllib.load(stream)
                file=file/'dist'/PROFILES[args.profile]['target']/(manifest['app']['id']+'.ast')
            except (OSError,ValueError,KeyError) as error:parser.error('无法读取 APP 工程：'+str(error))
        if not file.is_file():parser.error('安装包不存在，请先使用 SDK 编译：'+str(file))
        args.app=str(file)
        resources=Path(args.resources).resolve() if args.resources else file.parent/'resources'
        if args.resources and not resources.is_dir():parser.error('资源目录不存在：'+str(resources))
        args.resources=str(resources) if resources.is_dir() else None
    return args
def main():
    args=parse_args()
    app=QApplication(sys.argv);app.setApplicationName('Aster Desktop');window=Window(args);window.show();return app.exec()
if __name__=='__main__':raise SystemExit(main())
