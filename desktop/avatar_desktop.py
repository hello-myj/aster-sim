"""Desktop Live2D lab with native audio and a local-only renderer."""

from collections import deque
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
from pathlib import Path
import sys
from threading import Event, Semaphore, Thread
from time import monotonic
from urllib.parse import unquote, urlsplit

from PySide6.QtCore import QEvent, QFile, QIODevice, QObject, Qt, QTimer, QUrl, QUrlQuery, Signal, Slot
from PySide6.QtGui import QKeySequence, QShortcut
from PySide6.QtMultimedia import QAudioFormat, QAudioSink, QAudioSource, QMediaDevices, QtAudio
from PySide6.QtWebChannel import QWebChannel
from PySide6.QtWebEngineCore import (QWebEngineLoadingInfo, QWebEnginePage, QWebEngineProfile,
                                    QWebEngineUrlRequestInterceptor)
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import QApplication, QFileDialog, QVBoxLayout, QWidget

from avatar_voice import (AvatarPlan, DeepSeek, FACE_EXPRESSIONS, FACE_PRESETS, GESTURES, JOINTS, PlanStage, VOICE_RATE,
                          VoiceEnvelope, check_pose, sequence_duration)

ASSETS = Path(getattr(sys, '_MEIPASS', Path(__file__).resolve().parent))
MAX_CAPTURE = 16000 * 2 * 15
IDLE_INTERVAL = 10.0
IDLE_RETRY_DELAY = 300_000


def load_looks(model):
    manifest = json.loads((model / 'preview-original.model3.json').read_text(encoding='utf-8-sig'))
    references = manifest['FileReferences']
    paths = {item['Name']: item['File'] for item in references.get('Expressions', [])}
    faces = {'默认': {}}
    parts = {}
    order = (*[name for name in FACE_EXPRESSIONS if name in paths],
             *[name for name in paths if name not in FACE_EXPRESSIONS])
    for name in order:
        path = (model / paths[name]).resolve()
        if not path.is_relative_to(model) or not path.is_file():
            continue
        definition = json.loads(path.read_text(encoding='utf-8-sig'))
        parameters = definition.get('Parameters', [])
        if parameters and all(item.get('Blend') == 'Add' and item['Id'] not in JOINTS.values() for item in parameters):
            collection = faces if name in FACE_EXPRESSIONS else parts
            collection[name] = {item['Id']: item['Value'] for item in parameters}
    display = (model / references.get('DisplayInfo', '')).resolve()
    if display.is_relative_to(model) and display.is_file():
        info = json.loads(display.read_text(encoding='utf-8-sig'))
        ids = {item['Id'] for item in info.get('Parameters', [])}
        for name, parameters in FACE_PRESETS.items():
            if parameters.keys() <= ids:
                faces.setdefault(name, parameters)
    return faces, parts


def load_motions(model):
    catalog = model / 'controls.json'
    if not catalog.is_file():
        return {}
    motions = {'自然站姿': {'duration': 0, 'curves': {}}}
    for entry in json.loads(catalog.read_text(encoding='utf-8-sig')).get('motions', []):
        path = (model / entry['file']).resolve()
        if not path.is_relative_to(model) or not path.is_file():
            continue
        definition = json.loads(path.read_text(encoding='utf-8-sig'))
        curves = {curve['Id']: curve['Segments'] for curve in definition['Curves'] if curve['Target'] == 'Parameter'}
        if curves:
            motions[entry['name']] = {'duration': definition['Meta']['Duration'], 'curves': curves}
    return motions if len(motions) > 1 else {}


class SceneServer(ThreadingHTTPServer):
    def __init__(self, source):
        self.source = source.resolve()
        for file in ('deps/purism-preview-core.js', 'deps/pixi.min.js', 'deps/live2d-pixi.min.js',
                     'model/preview-original.model3.json'):
            if not (self.source / file).is_file():
                raise ValueError(f'原版模型目录缺少 {file}')
        model = (self.source / 'model').resolve()
        self.faces, self.parts = load_looks(model)
        self.motions = load_motions(model)
        super().__init__(('127.0.0.1', 0), SceneRequest)

    @property
    def url(self):
        return QUrl(f'http://127.0.0.1:{self.server_port}/')

    @property
    def has_lightweight(self):
        return (self.source / 'model/preview.model3.json').is_file()


class SceneRequest(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        route = unquote(urlsplit(self.path).path)
        files = {'/': ASSETS / 'avatar_scene.html', '/scene.js': ASSETS / 'avatar_scene.js'}
        if route == '/webchannel.js':
            script = QFile(':/qtwebchannel/qwebchannel.js')
            if not script.open(QIODevice.OpenModeFlag.ReadOnly):
                return self.send_error(404)
            try:
                return self.send_bytes(bytes(script.readAll()), 'text/javascript')
            finally:
                script.close()
        if route == '/joints.json':
            return self.send_bytes(json.dumps(JOINTS).encode(), 'application/json')
        if route == '/expressions.json':
            config = {'faces': self.server.faces, 'parts': self.server.parts, 'motions': self.server.motions}
            return self.send_bytes(json.dumps(config, allow_nan=False).encode(), 'application/json')
        path = files.get(route)
        if route.startswith(('/source/model/', '/source/deps/')):
            path = (self.server.source / route.removeprefix('/source/')).resolve()
            if not (path.is_relative_to(self.server.source / 'model') or
                    path.is_relative_to(self.server.source / 'deps')):
                path = None
        try:
            if path is None or path.suffix.lower() not in ('.html', '.js', '.json', '.png', '.moc3'):
                return self.send_error(404)
            return self.send_bytes(path.read_bytes(), mimetypes.guess_type(path.name)[0] or 'application/octet-stream')
        except OSError:
            return self.send_error(404)

    def send_bytes(self, data, mime):
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(data)


class SceneOrigin(QWebEngineUrlRequestInterceptor):
    def __init__(self, port, parent):
        super().__init__(parent)
        self.port = port

    def interceptRequest(self, info):
        url = info.requestUrl()
        if url.scheme() in ('data', 'blob'):
            return
        info.block(url.scheme() != 'http' or url.host() != '127.0.0.1' or url.port() != self.port)


class Result(QObject):
    turn = Signal(int, str, object)
    idle = Signal(int, object, bool)


class AvatarBridge(QObject):
    def __init__(self, window):
        super().__init__(window)
        self.window = window

    @Slot()
    def connected(self):
        self.window.publish_ui()

    @Slot(str)
    def control(self, name):
        self.window.control(name)

    @Slot(int)
    def zoomChanged(self, percent):
        self.window.zoom_percent = max(60, min(560, percent))
        self.window.idle_activity()


@dataclass
class PlayingPlan:
    permits: Semaphore
    queued: deque[tuple[PlanStage, bytes]] = field(default_factory=deque)
    stage: PlanStage | None = None
    started: float | None = None
    motion_before: tuple[str, bool] | None = None
    minimum: float = 0.0
    looping: bool = False
    audio_done: bool = False
    error: str = ''
    spoken: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class AvatarState:
    joints: dict[str, float]
    face: str
    parts: frozenset[str]
    motion: str
    motion_loop: bool


def pcm_format(rate):
    fmt = QAudioFormat()
    fmt.setSampleRate(rate)
    fmt.setChannelCount(1)
    fmt.setSampleFormat(QAudioFormat.SampleFormat.Int16)
    return fmt


class AvatarWindow(QWidget):
    audio_written = Signal(bytes, float)

    def __init__(self, server, api, idle_autonomy=False, parent=None, *, ai_enabled=True, save_ai_options=None):
        super().__init__(parent)
        self.setWindowTitle('Aster · 小鲸关节模拟器')
        self.api, self.ready = api, False
        self.ai_enabled = ai_enabled
        self.ai_settings_open = False
        self.ai_setting_notice = ''
        self.save_ai_options = save_ai_options
        self.scene_url = server.url
        self.attempt = 0
        self.scene_state = 'loading'
        self.has_lightweight = server.has_lightweight
        self.original_mode = not self.has_lightweight
        self.autonomous_enabled = True
        self.idle_autonomy_enabled = idle_autonomy
        self.zoom_percent = 160
        self.notice_text = ''
        self.caption_text = ''
        self.cancelled = Event()
        self.history, self.pose = [], {}
        self.face = '默认'
        self.faces = tuple(name for name in server.faces if name != '默认')
        self.casual_faces = tuple(name for name in self.faces if name != '加载')
        self.face_options = ('默认', *self.faces, '换一个') if self.faces else ()
        self.part_definitions = server.parts
        self.parts = set()
        self.motion = '自然站姿'
        self.motion_loop = False
        self.clip_durations = {name: clip['duration'] for name, clip in server.motions.items()}
        self.last_gesture = ''
        self.idle_generation = 0
        self.idle_pending = False
        self.idle_previous = {}
        self.idle_effect = None
        self.idle_due = None
        self.tool_options = {'expressions': self.face_options, 'motions': tuple(server.motions),
                             'parts': tuple(server.parts)}
        self.capture = self.capture_stream = None
        self.capture_data = bytearray()
        self.playback = self.playback_stream = None
        self.output_bytes = 0
        self.queue = bytearray()
        self.pending_pose = None
        self.pending_text = ''
        self.network_done, self.busy, self.performing = False, False, False
        self.turn_number = 0
        self.turn_cancel = Event()
        self.turn_pose = None
        self.turn_keep_pose = False
        self.turn_used_pose = False
        self.turn_changed_motion = False
        self.plan = None
        self.envelope = VoiceEnvelope()
        self.voice_level = 0.0
        self.result = Result(self)
        self.result.turn.connect(self.on_turn_event)
        self.result.idle.connect(self.finish_idle)
        self.idle_timer = QTimer(self, singleShot=True)
        self.idle_timer.setTimerType(Qt.TimerType.PreciseTimer)
        self.idle_timer.timeout.connect(self.start_idle)
        self.idle_effect_timer = QTimer(self, singleShot=True)
        self.idle_effect_timer.timeout.connect(self.finish_idle_effect)

        self.scene = QWebEngineView(self)
        self.scene.setContextMenuPolicy(Qt.ContextMenuPolicy.NoContextMenu)
        self.web_profile = QWebEngineProfile(self)
        self.scene.setPage(QWebEnginePage(self.web_profile, self.scene))
        self.origin = SceneOrigin(server.server_port, self.web_profile)
        self.web_profile.setUrlRequestInterceptor(self.origin)
        self.channel = QWebChannel(self.scene.page())
        self.bridge = AvatarBridge(self)
        self.channel.registerObject('avatar', self.bridge)
        self.scene.page().setWebChannel(self.channel)
        self.scene.titleChanged.connect(self.scene_title)
        self.scene.page().loadingChanged.connect(self.scene_navigation)
        self.scene.renderProcessTerminated.connect(self.scene_terminated)
        self.scene_timeout = QTimer(self, singleShot=True)
        self.scene_timeout.timeout.connect(self.scene_timed_out)

        if parent is None:
            QShortcut(QKeySequence('Escape'), self).activated.connect(self.stop_turn)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(self.scene)
        self.setFixedSize(460, 460)
        self.player_tick = QTimer(self, interval=20)
        self.player_tick.timeout.connect(self.play_audio)
        self.player_tick.start()
        self.record_limit = QTimer(self, singleShot=True, interval=15000)
        self.record_limit.timeout.connect(self.finish_capture)
        QApplication.instance().installEventFilter(self)
        self.load_scene()

    def control(self, name):
        if self.cancelled.is_set() or not self.isVisible():
            return
        self.idle_activity()
        if name == 'record' and self.ready and self.ai_enabled:
            self.record_clicked()
        elif name == 'stop':
            self.stop_turn()
        elif name == 'retry' and self.scene_state == 'failed' and not self.busy:
            self.load_scene()
        elif not self.busy and self.capture is None and name == 'original' and self.has_lightweight:
            self.original_mode = not self.original_mode
            self.load_scene()
        elif name == 'autonomous':
            self.autonomous_enabled = not self.autonomous_enabled
        elif name == 'idle':
            self.idle_autonomy_enabled = not self.idle_autonomy_enabled
            self.arm_idle()
        elif name == 'reset' and self.ready and not self.busy and self.capture is None:
            self.reset_pose()
        elif name == 'ai-settings':
            self.ai_settings_open = True
            self.ai_setting_notice = ''
        elif name == 'ai-back':
            self.ai_settings_open = False
        elif name == 'ai-toggle':
            self.toggle_ai()
        elif name == 'ai-key' and not self.busy and self.capture is None:
            self.choose_ai_key()
        self.publish_ui()
        self.arm_idle()

    def toggle_ai(self):
        enabled = not self.ai_enabled
        try:
            if self.save_ai_options:
                self.save_ai_options(ai_enabled=enabled)
        except OSError:
            self.ai_setting_notice = '无法保存 AI 设置'
            return
        self.ai_setting_notice = ''
        self.ai_enabled = enabled
        if not enabled:
            self.stop_capture()
            self.capture_data.clear()
            self.stop_turn()
            self.set_notice('')

    def choose_ai_key(self):
        filename, _ = QFileDialog.getOpenFileName(self, '选择 DeepSeek Key 文件', '', '文本文件 (*.txt);;所有文件 (*)')
        if not filename:
            return
        path = Path(filename).resolve()
        try:
            api = DeepSeek(path.read_text(encoding='utf-8-sig').strip())
            if self.save_ai_options:
                self.save_ai_options(key_file=str(path))
        except (OSError, ValueError):
            self.ai_setting_notice = '无法读取或保存 Key 配置，请检查文件'
            return
        self.api = api
        self.history.clear()
        self.ai_setting_notice = '已保存 Key 文件配置'

    def publish_ui(self):
        if self.cancelled.is_set():
            return
        state = {'ready': self.ready, 'recording': self.capture is not None, 'busy': self.busy,
                 'stoppable': self.busy or self.motion_loop, 'failed': self.scene_state == 'failed',
                 'has_lightweight': self.has_lightweight, 'original': self.original_mode,
                 'autonomous': self.autonomous_enabled, 'idle': self.idle_autonomy_enabled,
                 'aiEnabled': self.ai_enabled, 'aiSettingsOpen': self.ai_settings_open,
                 'aiSettingNotice': self.ai_setting_notice,
                 'zoom': self.zoom_percent, 'notice': self.notice_text, 'caption': self.caption_text}
        self.scene.page().runJavaScript(f'window.asterUI?.update({json.dumps(state, ensure_ascii=True)})')

    def set_notice(self, text):
        self.notice_text = text
        self.publish_ui()

    def load_scene(self):
        self.attempt += 1
        self.ready = False
        self.idle_activity()
        self.scene_state = 'loading'
        self.set_notice('正在打开角色页面…')
        self.update_controls()
        original = self.original_mode
        query = QUrlQuery()
        query.addQueryItem('quality', 'original' if original else 'lightweight')
        query.addQueryItem('attempt', str(self.attempt))
        self.scene_url.setQuery(query)
        self.scene_timeout.start(40000 if original else 25000)
        self.scene.load(self.scene_url)

    def scene_title(self, title):
        prefix = 'aster-avatar:'
        if not title.startswith(prefix):
            return
        try:
            attempt, state, message = json.loads(title.removeprefix(prefix))
        except ValueError:
            return
        if attempt != self.attempt or self.scene_state == 'failed':
            return
        if state == 'yes':
            self.scene_timeout.stop()
            self.ready = True
            self.scene_state = 'ready'
            self.set_notice('')
            self.change_zoom(self.zoom_percent)
            restoration = {'joints': self.pose.copy(), 'duration_ms': 150}
            if self.face != '默认':
                restoration['expression'] = self.face
            if self.parts:
                restoration['parts'] = dict.fromkeys(self.parts, True)
            if self.motion != '自然站姿':
                restoration.update(motion=self.motion, motion_loop=self.motion_loop)
            if self.pose or self.face != '默认' or self.parts or self.motion != '自然站姿':
                self.set_pose(restoration, restore_motion=True)
            self.update_controls()
        elif state == 'failed':
            self.report_scene_failure(message)
        elif self.scene_state == 'loading' and state == 'loading':
            self.set_notice(message)

    def scene_navigation(self, info):
        if (self.scene_state == 'loading' and info.url() == self.scene_url and
                info.status() == QWebEngineLoadingInfo.LoadStatus.LoadFailedStatus):
            self.report_scene_failure('角色页面读取失败，请重试')

    def scene_terminated(self, status, code):
        self.report_scene_failure(f'角色渲染进程已退出（{code}），请重试')

    def scene_timed_out(self):
        self.report_scene_failure(self.notice_text.rstrip('…') + '超时，请重试')
        self.scene.stop()

    def report_scene_failure(self, message):
        self.scene_timeout.stop()
        self.ready = False
        self.scene_state = 'failed'
        self.set_notice(message)
        self.update_controls()

    def change_zoom(self, percent):
        self.zoom_percent = percent
        if self.ready:
            self.scene.page().runJavaScript(f'asterAvatar.setZoom({percent / 100})')
        self.publish_ui()

    def update_controls(self):
        self.publish_ui()
        self.arm_idle()

    def allows_idle(self):
        return (self.ai_enabled and not self.ai_settings_open and self.idle_autonomy_enabled and self.ready and self.isVisible()
                and not self.window().isMinimized() and not self.busy and self.capture is None
                and not self.motion_loop and not self.cancelled.is_set())

    def arm_idle(self):
        if not self.allows_idle():
            self.idle_timer.stop()
            self.idle_due = None
        elif not self.idle_pending and self.idle_effect is None and not self.idle_timer.isActive():
            now = monotonic()
            if self.idle_due is None:
                self.idle_due = now + IDLE_INTERVAL
            self.idle_timer.start(max(1, round((self.idle_due - now) * 1000)))

    def idle_activity(self):
        self.idle_generation += 1
        self.idle_timer.stop()
        self.idle_due = None
        self.idle_effect_timer.stop()
        effect, self.idle_effect = self.idle_effect, None
        if effect and self.ready:
            self.set_pose(effect)
        self.arm_idle()

    def eventFilter(self, watched, event):
        kind = event.type()
        if watched in (self, self.window()) and kind in (QEvent.Type.Show, QEvent.Type.Hide, QEvent.Type.WindowStateChange):
            self.idle_activity()
        elif kind in (QEvent.Type.MouseButtonPress, QEvent.Type.MouseButtonRelease, QEvent.Type.KeyPress,
                      QEvent.Type.Wheel, QEvent.Type.TouchBegin, QEvent.Type.TouchEnd):
            if watched is self or (isinstance(watched, QWidget) and self.isAncestorOf(watched)):
                self.idle_activity()
        return False

    def start_idle(self):
        if self.idle_pending or self.idle_effect is not None or not self.allows_idle():
            return
        generation = self.idle_generation
        self.scene.page().runJavaScript('window.asterAvatar?.hasMotion() ?? true',
                                       lambda moving: self.request_idle(generation, moving))

    def request_idle(self, generation, moving):
        if (generation != self.idle_generation or self.idle_pending or self.idle_effect is not None or
                not self.allows_idle()):
            return
        if moving is not False:
            self.idle_timer.start(500)
            return
        self.idle_due = monotonic() + IDLE_INTERVAL
        self.idle_pending = True
        api, result, closed = self.api, self.result, self.cancelled
        faces, face, previous = self.casual_faces, self.face, self.idle_previous
        held_joints = self.pose.copy()

        def work():
            try:
                action, failed = api.choose_idle(faces, face, previous, held_joints), False
            except ValueError:
                action, failed = None, False
            except Exception:
                action, failed = None, True
            if not closed.is_set():
                result.idle.emit(generation, action, failed)

        Thread(target=work, daemon=True).start()

    def finish_idle(self, generation, action, failed):
        self.idle_pending = False
        if generation != self.idle_generation or not self.allows_idle():
            self.arm_idle()
            return
        if failed:
            self.idle_due = monotonic() + IDLE_RETRY_DELAY / 1000
            self.idle_timer.start(IDLE_RETRY_DELAY)
        elif action:
            self.play_idle_pose(action)
        else:
            self.arm_idle()

    def play_idle_pose(self, action):
        sequence_ms = sequence_duration(action)
        joints = set(action['joints'])
        restoration = {'duration_ms': 230}
        if sequence_ms:
            restoration['stop_sequence'] = True
        if 'expression' in action:
            restoration['expression'] = self.face
        if joints:
            restoration['joints'] = {name: self.pose[name] for name in joints & self.pose.keys()}
            restoration['release'] = sorted(joints - self.pose.keys())
        self.set_pose(action)
        self.idle_effect = restoration
        animated = joints | {name for step in action.get('steps', []) for name in step['joints']}
        self.idle_previous = {key: action[key] for key in ('gesture', 'expression') if key in action}
        if animated:
            self.idle_previous['joints'] = sorted(animated)
        pose_ms = action['duration_ms'] * 2 + action['hold_ms'] if joints or 'expression' in action else 0
        self.idle_effect_timer.start(max(pose_ms + 100, sequence_ms + 500))

    def finish_idle_effect(self):
        self.idle_effect = None
        self.arm_idle()

    def set_pose(self, pose, restore_motion=False, sequence_loop=False):
        pose = check_pose(pose, **self.tool_options)
        gesture = pose.pop('gesture', None)
        if gesture:
            pose['steps'] = [{'duration_ms': ms, 'joints': joints} for ms, joints in GESTURES[gesture]]
            self.last_gesture = gesture
        elif 'steps' in pose:
            self.last_gesture = '自编动作'
        if sequence_loop and 'steps' in pose:
            pose['sequence_loop'] = True
        if pose.get('expression') == '换一个':
            faces = self.casual_faces or self.faces
            index = faces.index(self.face) + 1 if self.face in faces else 0
            pose['expression'] = faces[index % len(faces)]
        for name in pose['release']:
            self.pose.pop(name, None)
        if not pose['hold_ms']:
            self.pose.update(pose['joints'])
            self.face = pose.get('expression', self.face)
        if 'parts' in pose:
            for name, enabled in pose['parts'].items():
                if not enabled:
                    self.parts.discard(name)
                    continue
                channels = self.part_definitions[name].keys()
                glasses = {'单片眼镜', '黑框眼镜'}
                self.parts = {current for current in self.parts if not channels & self.part_definitions[current].keys()
                              and not (name in glasses and current in glasses)}
                self.parts.add(name)
            pose['parts'] = sorted(self.parts)
        if 'motion' in pose:
            self.motion, self.motion_loop = pose['motion'], pose['motion_loop']
            if restore_motion:
                pose['motion_restored'] = True
        if self.ready:
            self.scene.page().runJavaScript(f'asterAvatar.setPose({json.dumps(pose, allow_nan=False)})')

    def reset_pose(self):
        self.idle_activity()
        pose = {'release': list(JOINTS), 'duration_ms': 420, 'stop_sequence': True}
        if self.face_options:
            pose['expression'] = '默认'
        if self.parts:
            pose['parts'] = dict.fromkeys(self.parts, False)
        if self.tool_options['motions']:
            pose['motion'] = '自然站姿'
        self.set_pose(pose)
        self.arm_idle()

    def record_clicked(self):
        self.idle_activity()
        if self.capture is not None:
            return self.finish_capture()
        if self.busy:
            self.stop_turn()
        fmt = pcm_format(16000)
        device = QMediaDevices.defaultAudioInput()
        if device.isNull() or not device.isFormatSupported(fmt):
            return self.set_notice('默认麦克风不可用，或不支持 16 kHz 单声道录音')
        self.capture_data.clear()
        self.caption_text = ''
        self.capture = QAudioSource(device, fmt, self)
        self.capture_stream = self.capture.start()
        if self.capture.error() != QtAudio.Error.NoError or self.capture_stream is None:
            self.stop_capture()
            return self.set_notice('打开麦克风失败，请检查电脑权限')
        self.capture_stream.readyRead.connect(self.read_capture)
        self.record_limit.start()
        self.set_notice('正在录音…')
        self.update_controls()

    def read_capture(self):
        if self.capture_stream is not None:
            block = bytes(self.capture_stream.readAll())
            self.capture_data.extend(block[:MAX_CAPTURE - len(self.capture_data)])

    def stop_capture(self):
        self.record_limit.stop()
        if self.capture is not None:
            self.capture.stop()
            self.capture.deleteLater()
        self.capture = self.capture_stream = None
        self.update_controls()

    def finish_capture(self):
        self.read_capture()
        self.stop_capture()
        pcm = bytes(self.capture_data[:len(self.capture_data) & ~1])
        self.capture_data.clear()
        if len(pcm) < 8000:
            return self.set_notice('录音太短，请再说一次')
        self.start_turn(pcm)

    def transcript(self, text):
        self.heard = text
        self.caption_text = text
        self.set_notice('小鲸在想…')

    def reply(self, text, pose, keep_pose=False):
        self.pending_text, self.pending_pose = text, pose
        self.turn_keep_pose = keep_pose
        self.set_notice('正在合成语音…' if text else '')

    def start_turn(self, question):
        if self.busy:
            self.stop_turn()
        self.turn_number += 1
        self.turn_cancel = Event()
        self.busy, self.network_done, self.performing = True, False, False
        self.idle_activity()
        self.turn_pose = AvatarState(self.pose.copy(), self.face, frozenset(self.parts),
                                     self.motion, self.motion_loop)
        self.turn_keep_pose = False
        self.turn_used_pose = self.turn_changed_motion = False
        self.heard, self.pending_text, self.pending_pose = '', '', None
        self.caption_text = ''
        self.queue.clear()
        self.envelope = VoiceEnvelope()
        self.update_controls()
        self.set_notice('正在转写…' if isinstance(question, bytes) else '小鲸在想…')
        history, pose = self.history.copy(), self.pose.copy()
        options = self.tool_options
        appearance = {'表情': self.face, '外观': sorted(self.parts), '动作': self.motion,
                      '上次手势': self.last_gesture}
        autonomous = self.autonomous_enabled
        api, result, cancelled = self.api, self.result, self.turn_cancel
        turn = self.turn_number

        def work():
            def emit(kind, data):
                if not cancelled.is_set():
                    result.turn.emit(turn, kind, data)

            try:
                text = api.transcribe(question) if isinstance(question, bytes) else question
                emit('transcript', text)
                if cancelled.is_set():
                    return
                text, movement = api.chat(text, history, pose, options, appearance, autonomous)
                if cancelled.is_set():
                    return
                keep_pose = False
                if isinstance(movement, dict):
                    movement = movement.copy()
                    keep_pose = movement.pop('keep_pose', False)
                    loop = bool(movement.get('motion_loop') and movement.get('motion') != '自然站姿')
                    if loop or not text:
                        if 'motion' in movement:
                            movement['motion_loop'] = False
                        movement = AvatarPlan((PlanStage(text, movement, 0, loop, loop),), keep_pose)
                if isinstance(movement, AvatarPlan):
                    # Keep one segment playing and at most one ahead of it.
                    permits = Semaphore(2)
                    emit('plan', (permits, movement.keep_pose))
                    for stage in movement.stages:
                        while not cancelled.is_set() and not permits.acquire(timeout=0.1):
                            pass
                        if cancelled.is_set():
                            return
                        pcm = b''.join(api.speak(stage.speech, cancelled)) if stage.speech else b''
                        if stage.speech and not pcm and not cancelled.is_set():
                            raise ValueError('动作计划中的语音片段为空')
                        emit('stage', (stage, pcm))
                else:
                    emit('reply', (text, movement, keep_pose))
                    if text:
                        for block in api.speak(text, cancelled):
                            emit('audio', block)
                emit('finished', '')
            except Exception as error:
                message = str(error) if isinstance(error, (ValueError, RuntimeError)) else '语音服务返回异常，请重试'
                emit('finished', message)

        Thread(target=work, daemon=True).start()

    @Slot(int, str, object)
    def on_turn_event(self, turn, kind, data):
        if turn != self.turn_number or self.turn_cancel.is_set():
            return
        if kind == 'transcript':
            self.transcript(data)
        elif kind == 'reply':
            self.reply(*data)
        elif kind == 'audio':
            self.receive_audio(data)
        elif kind == 'plan':
            permits, self.turn_keep_pose = data
            self.plan = PlayingPlan(permits)
            self.set_notice('正在准备动作计划…')
        elif kind == 'stage':
            self.plan.queued.append(data)
        elif kind == 'finished':
            self.network_finished(data)

    def network_finished(self, error):
        self.network_done = True
        if self.plan:
            self.plan.error = error
        elif error:
            self.finish_turn(error)

    def receive_audio(self, block):
        self.queue.extend(block)
        self.envelope.feed(block)

    def set_voice_level(self, level):
        level = round(level, 3)
        if level == self.voice_level:
            return
        self.voice_level = level
        if self.ready:
            self.scene.page().runJavaScript(f'asterAvatar.setVoiceLevel({level})')

    def apply_reply_pose(self):
        if self.pending_pose:
            self.apply_turn_pose(self.pending_pose)
            self.pending_pose = None

    def apply_turn_pose(self, pose, sequence_loop=False):
        self.turn_used_pose = True
        self.turn_changed_motion |= 'motion' in pose
        self.set_pose(pose, sequence_loop=sequence_loop)

    def restore_turn_pose(self):
        state = self.turn_pose
        if not self.turn_used_pose or state is None:
            return
        if self.ready:
            self.scene.page().runJavaScript('asterAvatar.stopActions()')
        pose = {'duration_ms': 320}
        if self.pose != state.joints:
            pose['joints'] = state.joints
            pose['release'] = sorted(self.pose.keys() - state.joints.keys())
        if self.face != state.face:
            pose['expression'] = state.face
        if self.parts != state.parts:
            pose['parts'] = {**dict.fromkeys(self.parts - state.parts, False),
                             **dict.fromkeys(state.parts - self.parts, True)}
        if self.turn_changed_motion:
            pose.update(motion=state.motion, motion_loop=state.motion_loop)
        if len(pose) > 1:
            self.set_pose(pose, restore_motion=True)

    def begin_plan_stage(self):
        plan = self.plan
        stage = plan.stage
        plan.started = monotonic()
        plan.looping = stage.loop
        pose = stage.pose
        plan.minimum = stage.duration_ms / 1000
        if pose:
            plan.motion_before = (self.motion, self.motion_loop) if stage.loop and 'motion' in pose else None
            if stage.loop and 'motion' in pose:
                pose = dict(pose, motion_loop=True)
            self.apply_turn_pose(pose, sequence_loop=stage.loop)
            if not stage.loop:
                hold = pose['hold_ms']
                transition = pose['duration_ms'] * (2 if hold else 1) + hold
                if not stage.speech and not hold and (pose['joints'] or 'expression' in pose or 'parts' in pose):
                    transition += 320
                sequence_ms = sequence_duration(pose)
                clip = self.clip_durations.get(pose.get('motion'), 0)
                plan.minimum = max(plan.minimum, transition / 1000, clip,
                                   (sequence_ms + 370) / 1000 if sequence_ms else 0)
        self.caption_text = stage.speech
        self.set_notice(plan.error if not stage.speech else '')

    def end_plan_loop(self):
        plan = self.plan
        plan.looping = False
        release = {'stop_sequence': True, 'duration_ms': 260}
        if plan.motion_before is not None:
            name, loop = plan.motion_before
            release.update(motion=name, motion_loop=loop)
        self.set_pose(release, restore_motion=True)

    def advance_plan(self):
        plan = self.plan
        if plan.stage is not None:
            if plan.started is None:
                return
            ready = monotonic() - plan.started >= plan.minimum
            if plan.looping and not plan.stage.until_stopped:
                loop_finished = ready if plan.stage.duration_ms else plan.audio_done
                if loop_finished:
                    self.end_plan_loop()
            if not (ready and plan.audio_done and not plan.stage.until_stopped):
                return
            plan.stage = None
            plan.permits.release()
        if plan.queued:
            plan.stage, audio = plan.queued.popleft()
            plan.started = None
            plan.motion_before = None
            plan.audio_done = not audio
            self.envelope = VoiceEnvelope()
            if audio:
                self.receive_audio(audio)
            else:
                self.begin_plan_stage()
        elif self.network_done:
            self.finish_turn(plan.error)

    def finish_turn(self, error=''):
        if not self.plan and self.pending_pose:
            # If speech could not start, give the pending action its own
            # silent stage so it can still be seen before returning to rest.
            self.close_audio()
            self.plan = PlayingPlan(Semaphore(0), error=error)
            self.plan.queued.append((PlanStage('', self.pending_pose, 0, False, False), b''))
            self.pending_pose = None
            self.network_done = True
            self.turn_cancel.set()
            return
        if not self.turn_keep_pose or error:
            self.restore_turn_pose()
        spoken = ''.join(self.plan.spoken) if self.plan else ''
        self.remember_turn(spoken or self.pending_text)
        self.plan = None
        self.turn_cancel.set()
        self.stop_playback()
        self.set_notice(error)

    def remember_turn(self, text):
        if text:
            self.history = (self.history + [{'role': 'user', 'content': self.heard},
                {'role': 'assistant', 'content': text}])[-8:]

    def playback_error(self, message):
        if self.plan:
            self.stop_turn()
            self.set_notice(message)
            return
        self.network_done = True
        self.finish_turn(message)

    def stop_turn(self):
        if not (self.busy or self.motion_loop):
            return
        self.turn_cancel.set()
        self.turn_number += 1
        if self.plan:
            self.remember_turn(''.join(self.plan.spoken))
        self.plan = None
        self.pending_pose = None
        self.network_done = True
        if self.busy:
            self.restore_turn_pose()
        elif self.motion_loop:
            self.set_pose({'motion': '自然站姿', 'motion_loop': False}, restore_motion=True)
        if not self.busy and self.ready:
            self.scene.page().runJavaScript('asterAvatar.stopActions()')
        self.stop_playback()
        self.set_notice('')

    def play_audio(self):
        if not self.busy:
            return
        if self.plan:
            self.advance_plan()
            if not self.plan or self.plan.stage is None or self.plan.audio_done:
                return
        if self.playback is None and self.queue and (len(self.queue) >= 5760 or self.network_done):
            fmt = pcm_format(VOICE_RATE)
            device = QMediaDevices.defaultAudioOutput()
            if device.isNull() or not device.isFormatSupported(fmt):
                return self.playback_error('默认扬声器不可用，或不支持 24 kHz 单声道播放')
            self.playback = QAudioSink(device, fmt, self)
            self.playback_stream = self.playback.start()
            if self.playback_stream is None:
                return self.playback_error('打开默认扬声器失败')
        if self.playback is not None:
            if (self.playback.error() not in (QtAudio.Error.NoError, QtAudio.Error.UnderrunError) or
                    self.playback.state() == QtAudio.State.StoppedState):
                return self.playback_error('扬声器播放失败')
            available = min(self.playback.bytesFree(), len(self.queue)) & ~1
            if available and self.playback_stream is not None:
                block = bytes(self.queue[:available])
                written = self.playback_stream.write(block)
                if written < 0:
                    return self.playback_error('向扬声器写入失败')
                if written:
                    waiting = self.output_bytes / (2 * VOICE_RATE) - self.playback.processedUSecs() / 1_000_000
                    self.audio_written.emit(block[:written], monotonic() + max(0, waiting))
                    self.output_bytes += written
                del self.queue[:written]
            position = self.playback.processedUSecs()
            state = self.playback.state()
            if position > 0 and not self.performing:
                self.performing = True
                if self.plan:
                    self.begin_plan_stage()
                else:
                    self.apply_reply_pose()
                    self.caption_text = self.pending_text
                    self.set_notice('')
                if self.ready:
                    self.scene.page().runJavaScript('asterAvatar.setVoiceActive(true)')
            self.set_voice_level(self.envelope.at(position) if state == QtAudio.State.ActiveState else 0.0)
            if state != QtAudio.State.IdleState or not self.performing or self.queue:
                return
            if self.plan:
                self.plan.spoken.append(self.plan.stage.speech)
                self.plan.audio_done = True
                self.close_audio()
                self.publish_ui()
                return
        if self.network_done and not self.queue:
            self.finish_turn()

    def close_audio(self):
        if self.playback is not None:
            self.playback.stop()
            self.playback.deleteLater()
        self.playback = self.playback_stream = None
        self.output_bytes = 0
        self.queue.clear()
        self.set_voice_level(0.0)
        if self.performing and self.ready:
            self.scene.page().runJavaScript('asterAvatar.setVoiceActive(false)')
        self.caption_text = ''
        self.performing = False

    def stop_playback(self):
        self.close_audio()
        self.busy = not self.network_done
        self.update_controls()

    def closeEvent(self, event):
        self.cancelled.set()
        self.turn_cancel.set()
        QApplication.instance().removeEventFilter(self)
        self.idle_timer.stop()
        self.idle_effect_timer.stop()
        self.scene_timeout.stop()
        self.stop_capture()
        self.stop_playback()
        super().closeEvent(event)
