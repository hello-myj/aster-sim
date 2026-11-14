"""Integration checks against the real native UI and isolated APP process."""
import os
os.environ.setdefault('QT_QPA_PLATFORM','offscreen')
import json
import base64
import io
import math
import subprocess
import wave
from array import array
from pathlib import Path
import tempfile
import time
import unittest
from types import SimpleNamespace
from PySide6.QtWidgets import QApplication
from PySide6.QtCore import QProcess
from main import Window,ROOT,parse_args

APP=QApplication.instance() or QApplication([])
ARTIFACTS=ROOT/'build/desktop-artifacts'

def until(predicate,seconds=20):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        APP.processEvents()
        if predicate():return
        time.sleep(.01)
    raise AssertionError('Desktop operation timed out')

def pump(seconds):
    end=time.monotonic()+seconds
    while time.monotonic()<end:APP.processEvents();time.sleep(.01)

class WindowTests(unittest.TestCase):
    def test_install_progress_result_and_failure_preserve_installed_app(self):
        with tempfile.TemporaryDirectory(prefix='install-window-test-',dir=ROOT/'build') as folder:
            args=SimpleNamespace(profile='p4',width=None,height=None,state=folder,wsl='Ubuntu-22.04',smoke=True,seed_local=True,title='Install integration test')
            window=Window(args)
            try:
                until(lambda:window.dependencies_ready());app=ROOT.parent/'aster-apps/GoldMiner/dist/riscv/aster.goldminer.ast';resources=app.parent/'resources'
                window.install_package(app,resources)
                self.assertTrue(window.import_busy);self.assertFalse(window.install_button.isEnabled())
                until(lambda:not window.import_busy)
                self.assertEqual(window.install_dialog.title.text(),'安装成功');self.assertEqual(window.install_dialog.bar.value(),1000)
                self.assertFalse(window.install_dialog.open_button.isHidden());self.assertTrue(window.install_button.isEnabled());self.assertIsNone(window.active)
                ARTIFACTS.mkdir(parents=True,exist_ok=True);window.install_dialog.grab().save(str(ARTIFACTS/'install-success.png'))
                index=(window.state()/'registry.json').read_bytes()
                window.install_package(app,Path(folder)/'missing-resources');until(lambda:not window.import_busy)
                self.assertEqual(window.install_dialog.title.text(),'安装失败');self.assertEqual((window.state()/'registry.json').read_bytes(),index)
                window.install_dialog.close()
                window.start_app('aster.goldminer');until(lambda:window.active and window.active['id']=='aster.goldminer');pump(.3)
                self.assertIsNotNone(window.active)
            finally:window.close();APP.processEvents()

    def test_command_line_project_autodetects_resources_and_launches_game(self):
        with tempfile.TemporaryDirectory(prefix='cli-window-test-',dir=ROOT/'build') as folder:
            project=ROOT.parent/'aster-apps/GoldMiner'
            args=parse_args(['--profile','p4','--app',str(project),'--state',folder,'--smoke'])
            self.assertEqual(Path(args.resources),project/'dist/riscv/resources')
            window=Window(args)
            try:
                until(lambda:window.active and window.active['id']=='aster.goldminer');pump(.4)
                self.assertFalse(window.import_busy);self.assertEqual(window.install_dialog.title.text(),'安装成功');self.assertFalse(window.install_dialog.isVisible())
                self.assertTrue((window.state()/'registry.json').exists());self.assertIsNotNone(window.active)
                self.assertIn('安装成功',window.logs.toPlainText())
                self.assertEqual(window.screen.image.width(),480)
            finally:window.close();APP.processEvents()

    def test_native_ui_app_profile_switch_and_video(self):
        ARTIFACTS.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='window-test-',dir=ROOT/'build') as folder:
            args=SimpleNamespace(profile='p4',width=None,height=None,state=folder,wsl='Ubuntu-22.04',smoke=True,seed_local=True,title='Integration test')
            window=Window(args)
            try:
                until(lambda:window.dependencies_ready() and window.screen.image.width()==480)
                pump(.4)
                self.assertEqual(window.core.state(),QProcess.ProcessState.Running)
                self.assertTrue(window.save_screenshot(ARTIFACTS/'p4-launcher.png'))
                app=ROOT.parent/'aster-apps/TouchTest/dist/riscv/aster.touchtest.ast'
                window.send_bridge({'type':'import','file':str(app)})
                until(lambda:any(a['id']=='aster.touchtest' for a in window.catalog))
                window.start_app('aster.touchtest')
                until(lambda:window.active and 'WASM' in window.status.text())
                pump(1)
                self.assertTrue(window.save_screenshot(ARTIFACTS/'p4-touchtest.png'))
                # Binary RGB565 includes CR/LF/EOF bytes: the native process must remain alive.
                self.assertEqual(window.core.state(),QProcess.ProcessState.Running)
                window.touch(1,120,160,4);pump(.1);window.touch(3,120,160,4)
                window.go_home();until(lambda:not window.active);pump(.3)
                window.start_recording(str(ARTIFACTS/'p4-system.mp4'))
                self.assertIsNotNone(window.encoder)
                window.native_command('N 1');pump(1.2)
                window.native_command('N -1');pump(1.2)
                window.stop_recording()
                until(lambda:window.muxer is None)
                self.assertGreater(window.record_frames,30)
                self.assertGreater((ARTIFACTS/'p4-system.mp4').stat().st_size,1000)
                window.device.setCurrentIndex(1);window.apply_geometry()
                until(lambda:window.dependencies_ready() and window.screen.image.width()==240)
                pump(.4)
                self.assertEqual(window.profile_key,'lckfb')
                self.assertTrue(window.save_screenshot(ARTIFACTS/'lckfb-launcher.png'))
                # A custom size retains this device's persistent card and installed APPs.
                window.width_box.setValue(320);window.height_box.setValue(480);window.apply_geometry()
                until(lambda:window.screen.image.width()==320 and window.screen.image.height()==480)
                pump(.4)
                self.assertTrue(window.save_screenshot(ARTIFACTS/'custom-320x480.png'))
                errors=window.logs.toPlainText()
                self.assertNotIn('通信数据无效',errors)
                self.assertNotIn('系统界面进程已退出',errors)
                (ARTIFACTS/'integration.log').write_text(errors,encoding='utf-8')
            finally:
                window.close();APP.processEvents()

    def test_recorded_music_and_effects_have_synchronized_aac_audio(self):
        ARTIFACTS.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='audio-window-test-',dir=ROOT/'build') as folder:
            args=SimpleNamespace(profile='p4',width=None,height=None,state=folder,wsl='Ubuntu-22.04',smoke=True,seed_local=True,title='Audio integration test')
            window=Window(args)
            try:
                until(lambda:window.dependencies_ready() and window.screen.image.width()==480);pump(.2)
                output=ARTIFACTS/'p4-system-audio.mp4'
                window.start_recording(str(output));self.assertIsNotNone(window.record_audio)
                # Deliberately use mono 44.1 kHz music; Qt must supply stereo 48 kHz capture.
                music=array('h',(int(4000*math.sin(2*math.pi*440*i/44100)) for i in range(44100*4)))
                wav=io.BytesIO()
                with wave.open(wav,'wb') as file:file.setnchannels(1);file.setsampwidth(2);file.setframerate(44100);file.writeframes(music.tobytes())
                window.audio_message({'op':'start','session':999,'volume':50,'data':base64.b64encode(wav.getvalue()).decode()})
                until(lambda:window.record_audio.ends['music']>0,10)
                effect=array('h',(int(4000*math.sin(2*math.pi*880*i/16000)) for i in range(16000)))
                window.audio_message({'op':'effect-load','handle':999,'info':{'offset':0,'bytes':len(effect)*2,'rate':16000,'channels':1},'data':base64.b64encode(effect.tobytes()).decode()})
                window.audio_message({'op':'effect','handle':999})
                pump(.8)
                self.assertGreater(window.record_audio.ends['effects'],0)
                window.audio_message({'op':'pause'});window.audio_message({'op':'effect-stop','handle':999,'ms':0});pump(.3)
                window.audio_message({'op':'resume'});pump(.5)
                frames=window.record_frames;window.stop_recording();until(lambda:window.muxer is None)
                self.assertTrue(output.exists(),window.logs.toPlainText())
                linux='/mnt/'+str(output)[0].lower()+output.as_posix()[2:]
                probe=subprocess.run(['wsl','-d',args.wsl,'--','ffprobe','-v','error','-show_streams','-of','json',linux],capture_output=True,check=True)
                streams=json.loads(probe.stdout)['streams'];video=next(s for s in streams if s['codec_type']=='video');audio=next(s for s in streams if s['codec_type']=='audio')
                self.assertEqual(audio['codec_name'],'aac');self.assertEqual(audio['channels'],2);self.assertEqual(audio['sample_rate'],'48000')
                self.assertLess(abs(float(video['duration'])-float(audio['duration'])),.04)
                decoded=subprocess.run(['wsl','-d',args.wsl,'--','ffmpeg','-v','error','-i',linux,'-map','0:a:0','-f','s16le','-ar','48000','-ac','1','pipe:1'],capture_output=True,check=True)
                pcm=array('h');pcm.frombytes(decoded.stdout)
                # Both independent test tones must survive capture and AAC mixing.
                def magnitude(hz):
                    count=min(len(pcm),frames*1600)
                    a=sum(pcm[i]*math.cos(2*math.pi*hz*i/48000) for i in range(count))
                    b=sum(pcm[i]*math.sin(2*math.pi*hz*i/48000) for i in range(count))
                    return 2*math.hypot(a,b)/count
                self.assertGreater(magnitude(440),150)
                self.assertGreater(magnitude(880),150)
                self.assertNotIn('录音格式无效',window.logs.toPlainText())
            finally:window.close();APP.processEvents()

if __name__=='__main__':unittest.main()
