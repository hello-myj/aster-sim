"""DeepSeek voice transport and the joint tool shared by the desktop scene."""

from array import array
from dataclasses import dataclass
import io
import json
import math
import re
import sys
import wave
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import uuid4

JOINTS = {
    'head_yaw': 'ParamAngleX', 'head_pitch': 'ParamAngleY', 'head_roll': 'ParamAngleZ',
    'left_shoulder': 'LArm', 'left_elbow': 'LForearm', 'left_wrist': 'LWrist',
    'left_fingers': 'LHand', 'right_shoulder': 'RArm', 'right_elbow': 'RForearm',
    'right_wrist': 'RWrist', 'right_fingers': 'RHand',
    'left_finger_detail': 'LHand2', 'right_finger_detail': 'RHand2',
    'raised_left_shoulder': 'Param36', 'raised_left_shoulder_depth': 'Param39',
    'raised_left_elbow': 'Param41', 'raised_left_wrist': 'Param42', 'raised_left_index': 'Param43',
    'chest_right_shoulder': 'Param62', 'chest_right_shoulder_depth': 'Param59',
    'chest_right_elbow': 'Param60', 'chest_right_wrist': 'Param61',
    'left_eye': 'ParamEyeLOpen', 'right_eye': 'ParamEyeROpen', 'jaw': 'ParamMouthOpenY',
    'mouth_form': 'ParamMouthForm', 'jaw_hinge': 'JawOpen',
    'gaze_x': 'ParamEyeBallX', 'gaze_y': 'ParamEyeBallY',
    'body_yaw': 'ParamBodyAngleX', 'body_pitch': 'ParamBodyAngleY', 'body_roll': 'ParamBodyAngleZ',
    'body_shift': 'ParamBodyAngleRX', 'shoulder_height': 'ShoulderY', 'shoulder_roll': 'ShoulderZ',
    'hip_yaw': 'HipAngleX', 'legs_sway': 'LEGAngleZ2', 'legs_spread': 'Param33',
    'tail_flip': 'Param52',
    **{f'tail_{i + 1}': f'Param_Angle_Rotation{84 + i}' for i in range(6)},
}
TOOL = 'set_avatar_pose'
IDLE_MAX_STEPS = 6
IDLE_MAX_SEQUENCE_MS = 5000
IDLE_MAX_REPEAT = 2
# In the standing art, negative shoulder/elbow targets pull the hands into
# the skirt and hair. Keep automatically chosen poses near the visible side.
IDLE_ARM_RANGES = {
    f'{side}_{joint}': limits for side in ('left', 'right')
    for joint, limits in (('shoulder', (0, 0.42)), ('elbow', (0, 0.45)), ('wrist', (-0.3, 0.3)))
}
IDLE_JOINTS = tuple(name for name in JOINTS if not name.startswith(('raised_left_', 'chest_right_')))
FACE_EXPRESSIONS = ('爱心眼', '圈圈眼', '脸红', '屑屑眼', '流冷汗', '流泪', '＞＜', '黑脸', '兔牙', '加载')
# Extra presets combine parameters from the existing Live2D model.
FACE_PRESETS = {
    '眯眼笑': {'EyeSmile': 0.85, 'ParamEyeLOpen': -0.68, 'ParamEyeROpen': -0.68, 'ParamMouthForm': 0.85},
    '惊讶': {'BrowInnerUp': 0.8, 'ParamBrowLY': 0.48, 'ParamBrowRY': 0.48,
           'ParamEyeLOpen': 0.38, 'ParamEyeROpen': 0.38, 'ParamMouthOpenY': 0.55, 'MouthFunnel': 0.45},
    '皱眉': {'ParamBrowLY': -0.62, 'ParamBrowRY': -0.62, 'LEyeSquint': 0.38, 'REyeSquint': 0.38,
           'ParamEyeLOpen': -0.32, 'ParamEyeROpen': -0.32, 'ParamMouthForm': -0.72},
    '嘟嘴': {'Mouthpucker': 0.86, 'MouthFunnel': 0.48, 'ParamMouthForm': -0.46, 'ParamMouthOpenY': 0.12},
}
MAX_SPEECH = 480
MAX_SEQUENCE_MS = 20_000
MAX_SEQUENCE_STEPS = 12
MAX_PLAN_STAGES = 16
MAX_STAGE_MS = 600_000
GESTURES = {
    '左右摇头': [(320, {'head_yaw': -0.55}), (540, {'head_yaw': 0.55})],
    '身体左右摇': [
        (380, {'body_roll': -0.40, 'body_shift': -0.28, 'head_roll': 0.22, 'tail_1': 0.28}),
        (630, {'body_roll': 0.40, 'body_shift': 0.28, 'head_roll': -0.22, 'tail_1': -0.28}),
    ],
    '摇尾巴': [(300, {'tail_1': -0.27, 'tail_3': -0.24, 'tail_6': -0.35}),
             (510, {'tail_1': 0.27, 'tail_3': 0.24, 'tail_6': 0.35})],
    '点头': [(220, {'head_pitch': -0.37}), (300, {'head_pitch': 0.15})],
    '跳舞': [
        (390, {'body_roll': -0.47, 'head_roll': 0.21, 'shoulder_height': 0.28,
               'left_shoulder': 0.27, 'right_shoulder': 0.27,
               'left_elbow': 0.45, 'right_elbow': 0.05, 'legs_sway': -0.30, 'tail_2': 0.36}),
        (540, {'body_roll': 0.47, 'head_roll': -0.21, 'shoulder_height': -0.13,
               'left_elbow': 0.05, 'right_elbow': 0.45, 'legs_sway': 0.30, 'tail_2': -0.36}),
        (440, {'body_roll': 0.0, 'head_roll': 0.0, 'shoulder_height': 0.38,
               'left_elbow': 0.42, 'right_elbow': 0.42, 'legs_sway': 0.0, 'tail_2': 0.18}),
        (500, {'body_roll': -0.37, 'head_roll': 0.26, 'shoulder_height': -0.08,
               'left_elbow': 0.45, 'right_elbow': 0.12, 'legs_sway': -0.30, 'tail_2': 0.33}),
        (540, {'body_roll': 0.37, 'head_roll': -0.26, 'shoulder_height': 0.30,
               'left_elbow': 0.12, 'right_elbow': 0.45, 'legs_sway': 0.30, 'tail_2': -0.33}),
        (390, {'body_roll': 0.0, 'head_roll': 0.0, 'shoulder_height': 0.20,
               'left_elbow': 0.32, 'right_elbow': 0.32, 'legs_sway': 0.0, 'tail_2': 0.0}),
    ],
}
SYSTEM = (
    '你是 Aster 的小鲸语音助手，用用户的语言，一到两句话，不用 Markdown。'
    '每轮调用一次 set_avatar_pose。长回答、故事或连续动作使用 result=plan，把台词和动作拆成多个 stages。'
    '故事至少三段，每段 speech 写一两句，每段 pose 搭配剧情的手势或表情，阶段按顺序播。'
    '要求持续跳舞或连续动作时，在一个阶段设置 pose.gesture 或 pose.steps，loop=true。'
    '按时长循环填写阶段自己的 duration_ms（例如 30 秒为 30000）。要求一直做就设 until_stopped=true。'
    '例如一直跳到手动停止时，参数是 {"result":"plan","stages":[{"pose":{"gesture":"跳舞"},'
    '"loop":true,"until_stopped":true}]}。时长和停止条件只写在阶段里。'
    'loop=true 且有 speech 时，可跟随本段播报持续动作。阶段内播报和 pose 同时运行。'
    '笑话、故事或日常回答的手势和表情在整轮结束后恢复之前的待机姿势。'
    '只有用户明确要求持续保持某个姿势或外观时，顶层 keep_pose=true。'
    '用户要求恢复默认姿势时，也用 keep_pose=true 提交新的常驻姿势，避免结束后回到旧姿势。'
    '用户要求一直做动作时使用最后一个循环阶段的 until_stopped，停下后恢复原状态。'
    '短回答用顶层 speech。用户只要单次短动作时用 result=pose，'
    '可组合需要改变的关节、表情、外观或实际动作。'
    '左右来回摇要用 gesture，按部位选择“左右摇头”“身体左右摇”或“摇尾巴”，一个循环含左右两边。'
    '短舞可以用 gesture="跳舞"。不同部位按顺序动可使用 steps。'
    '用户要求停止正在做的临时动作时用 stop_sequence=true。只做动作不说话时 speech 可以为空。'
    '模型做不了的动作（如走路、背身或翻跟头）用 result=unsupported，'
    '简短解释限制。没有实际关节指令时，台词不得说自己已经做了动作。'
    '左右指角色自身。关节值为归一化位置 -1 到 1，0 为默认。'
    '“弯一下”“摆一下”等短动作使用 hold_ms 250 到 600，停留后自动回到动作前的姿势。'
    '用户说“保持”或“停在这个姿势”时，省略 hold_ms 或设为 0。'
    '用户说“换个表情”且未点名时，设置 expression="换一个"，点名则选择对应表情。'
    '原版录制动作优先用 motion，例如竖食指、抚胸举手、拿出或收回狗尾草。'
    '切换眼镜、体型、衣服、尾巴和道具用 parts，true 开启、false 恢复；一次可调整多项。'
    '身体前倾用 parts={"前倾":true}，直起身用 false，可以同时选择 expression。'
    '想闭眼可把对应 eye 设为 -1。恢复自然眨眼，把该眼加入 release。'
    '微笑可设 mouth_form 为正值。播报时嘴巴会自动跟声音开合。'
    '抬臂可同时设 shoulder 和 elbow，tail_1 是尾根，tail_6 是尾尖。'
    'raised_left_* 只在竖食指或拿狗尾草的姿势下控制举起的左手。'
    'chest_right_* 只在抚胸举手的姿势下控制右手，自然站姿用普通手臂参数。'
)

AUTONOMOUS = (
    '你可以自主操控身体。用户没指定动作时，遇到问候、感谢、开心的消息或情绪变化，'
    '主动选一个简短合适的手势、表情或动作来配合台词。问候可点头，庆祝可选短舞或换上开心的表情。'
    '动作要符合语境，不要所有回答都跳舞，严肃或技术类回答可以仅用 result=speech。'
)

VOICE_RATE = 24000
LEVEL_WINDOW_US = 20_000
LEVEL_WINDOW_SAMPLES = VOICE_RATE * LEVEL_WINDOW_US // 1_000_000


class VoiceEnvelope:
    """Measure speech level in consecutive windows on the PCM sample clock."""

    def __init__(self):
        self.levels = []
        self.pending = bytearray()

    @staticmethod
    def measure(pcm):
        samples = array('h', pcm)
        if sys.byteorder != 'little':
            samples.byteswap()
        rms = math.sqrt(sum(sample * sample for sample in samples) / len(samples)) / 32768
        return min(1.0, max(0.0, (rms - 0.012) * 6.0))

    def feed(self, pcm):
        self.pending.extend(pcm)
        window = LEVEL_WINDOW_SAMPLES * 2
        measured = len(self.pending) // window * window
        for offset in range(0, measured, window):
            self.levels.append(self.measure(self.pending[offset:offset + window]))
        del self.pending[:measured]

    def at(self, processed_us):
        index = processed_us // LEVEL_WINDOW_US
        if 0 <= index < len(self.levels):
            return self.levels[index]
        samples = len(self.pending) // 2
        sample = processed_us * VOICE_RATE // 1_000_000 - index * LEVEL_WINDOW_SAMPLES
        if index == len(self.levels) and sample < samples:
            return self.measure(self.pending[:samples * 2])
        return 0.0


def check_joints(joints):
    if not isinstance(joints, dict):
        raise ValueError('无效的关节指令')
    for name, value in joints.items():
        if (name not in JOINTS or type(value) not in (float, int) or
                not -1 <= value <= 1 or not math.isfinite(value)):
            raise ValueError('无效的关节或角度')


def sequence_duration(pose):
    steps = pose.get('steps')
    durations = [step['duration_ms'] for step in steps] if steps else [
        duration for duration, _ in GESTURES.get(pose.get('gesture'), ())]
    return sum(durations) * pose.get('repeat', 1)


def sequence_options(command):
    gesture, steps = command.get('gesture'), command.get('steps')
    repeat = command.get('repeat', 1)
    stop = command.get('stop_sequence', False)
    if type(stop) is not bool or type(repeat) is not int or not 1 <= repeat <= 6:
        raise ValueError('动作循环或停止参数有误')
    if 'gesture' in command and (not isinstance(gesture, str) or gesture not in GESTURES):
        raise ValueError('当前角色没有这个手势')
    if 'steps' in command and (not isinstance(steps, list) or not 1 <= len(steps) <= MAX_SEQUENCE_STEPS):
        raise ValueError('动作步骤数量超出范围')
    if (gesture and steps) or (stop and (gesture or steps)) or ('repeat' in command and not (gesture or steps)):
        raise ValueError('动作步骤和循环参数冲突')
    if steps:
        for step in steps:
            if (not isinstance(step, dict) or set(step) != {'duration_ms', 'joints'} or
                    type(step['duration_ms']) is not int or not 80 <= step['duration_ms'] <= 3000):
                raise ValueError('动作步骤格式或时长有误')
            check_joints(step['joints'])
            if not step['joints']:
                raise ValueError('动作步骤需要至少一个关节')
    if sequence_duration(command) > MAX_SEQUENCE_MS:
        raise ValueError('动作序列最长为 20 秒')
    if gesture:
        return {'gesture': gesture, 'repeat': repeat}
    if steps:
        return {'steps': steps, 'repeat': repeat}
    return {'stop_sequence': True} if stop else {}


def check_pose(command, expressions=(), motions=(), parts=()):
    fields = {'joints', 'release', 'duration_ms', 'hold_ms', 'expression', 'motion', 'motion_loop', 'parts',
              'gesture', 'steps', 'repeat', 'stop_sequence'}
    if not isinstance(command, dict) or set(command) - fields:
        raise ValueError('无效的关节指令')
    joints, release = command.get('joints', {}), command.get('release', [])
    duration = command.get('duration_ms', 500)
    hold = command.get('hold_ms', 0)
    expression = command.get('expression')
    motion = command.get('motion')
    switches = command.get('parts', {})
    loop = command.get('motion_loop', motion == '待机')
    sequence = sequence_options(command)
    if not isinstance(release, list) or not (joints or release or expression or motion or switches or sequence):
        raise ValueError('关节指令为空或格式有误')
    if 'expression' in command and (not isinstance(expression, str) or expression not in expressions):
        raise ValueError('当前角色没有这个表情')
    if 'motion' in command and (not isinstance(motion, str) or motion not in motions):
        raise ValueError('当前角色没有这个动作')
    if type(loop) is not bool or ('motion_loop' in command and not motion):
        raise ValueError('动作循环参数有误')
    if not isinstance(switches, dict) or any(name not in parts or type(value) is not bool for name, value in switches.items()):
        raise ValueError('当前角色没有这个外观部件，或开关格式有误')
    check_joints(joints)
    if any(not isinstance(name, str) or name not in JOINTS for name in release):
        raise ValueError('未知的待释放关节')
    if set(release) & joints.keys() or len(release) != len(set(release)):
        raise ValueError('同一关节收到重复或冲突的指令')
    if type(duration) is not int or not 80 <= duration <= 3000:
        raise ValueError('动作时长超出范围')
    if type(hold) is not int or not 0 <= hold <= 5000:
        raise ValueError('动作停留时长超出范围')
    pose = {'joints': joints, 'release': release, 'duration_ms': duration, 'hold_ms': hold, **sequence}
    if expression:
        pose['expression'] = expression
    if motion:
        pose.update(motion=motion, motion_loop=loop)
    if switches:
        pose['parts'] = switches
    return pose


@dataclass(frozen=True)
class PlanStage:
    speech: str
    pose: dict | None
    duration_ms: int
    loop: bool
    until_stopped: bool


@dataclass(frozen=True)
class AvatarPlan:
    stages: tuple[PlanStage, ...]
    keep_pose: bool = False


def check_plan(stages, expressions, motions, parts, keep_pose=False):
    if not isinstance(stages, list) or not 1 <= len(stages) <= MAX_PLAN_STAGES:
        raise ValueError('动作计划需要至少一个阶段，最多 16 个')
    validated = []
    for index, stage in enumerate(stages):
        if not isinstance(stage, dict) or set(stage) - {'speech', 'pose', 'duration_ms', 'loop', 'until_stopped'}:
            raise ValueError('动作计划阶段格式有误')
        stage = stage.copy()
        movement = stage.get('pose')
        if isinstance(movement, dict):
            # Some model replies group loop controls with the motion. Lift
            # those known controls before checking the ordinary pose fields.
            movement = movement.copy()
            embedded = movement.keys() & {'loop', 'until_stopped'}
            for name in embedded:
                value = movement.pop(name)
                if name in stage and stage[name] != value:
                    raise ValueError('动作计划阶段的循环条件冲突')
                stage[name] = value
            if embedded and 'duration_ms' in movement and 'duration_ms' not in stage:
                stage['duration_ms'] = movement.pop('duration_ms')
        speech = stage.get('speech', '')
        duration = stage.get('duration_ms', 0)
        loop = stage.get('loop', False)
        until_stopped = stage.get('until_stopped', False)
        if (not isinstance(speech, str) or len(speech) > MAX_SPEECH or
                type(duration) is not int or not 0 <= duration <= MAX_STAGE_MS or
                type(loop) is not bool or type(until_stopped) is not bool):
            raise ValueError('动作计划阶段的台词或时长有误')
        speech = speech.strip()
        pose = check_pose(movement, expressions, motions, parts) if 'pose' in stage else None
        if not (speech or pose or duration):
            raise ValueError('动作计划阶段为空')
        if pose and 'motion_loop' in movement:
            raise ValueError('计划中的循环由阶段的 loop 控制')
        if pose and 'motion' in pose:
            pose['motion_loop'] = False
        if loop and not (pose and (pose.get('gesture') or pose.get('steps') or
                                  pose.get('motion') not in (None, '自然站姿'))):
            raise ValueError('循环阶段需要可播放的动作')
        if until_stopped and (not loop or duration or index != len(stages) - 1):
            raise ValueError('持续到手动停止只能作为最后一个循环阶段')
        if loop and not (duration or speech or until_stopped):
            raise ValueError('循环需要时长、台词或手动停止条件')
        validated.append(PlanStage(speech, pose, duration, loop, until_stopped))
    return AvatarPlan(tuple(validated), keep_pose)


def pose_tool(expressions=(), motions=(), parts=()):
    joint_schema = {'type': 'object', 'additionalProperties': False, 'properties': {
        name: {'type': 'number', 'minimum': -1, 'maximum': 1} for name in JOINTS}}
    tool = {'type': 'function', 'function': {
        'name': TOOL,
        'description': '提交本轮回复，并在 result=pose 时执行实际的关节指令。',
        'parameters': {
            'type': 'object', 'additionalProperties': False, 'required': ['result'],
            'properties': {
                'speech': {'type': 'string', 'maxLength': MAX_SPEECH, 'description': '台词；纯动作可为空。'},
                'result': {'type': 'string', 'enum': ['pose', 'speech', 'plan', 'unsupported'],
                           'description': 'pose 执行动作，speech 聊天，plan 按顺序执行阶段，unsupported 说明限制。'},
                'joints': joint_schema,
                'release': {'type': 'array', 'items': {'type': 'string', 'enum': list(JOINTS)},
                            'uniqueItems': True},
                'duration_ms': {'type': 'integer', 'minimum': 80, 'maximum': 3000,
                                'description': '移动到目标姿势的时间，也是临时动作回程的时间。'},
                'hold_ms': {'type': 'integer', 'minimum': 0, 'maximum': 5000,
                            'description': '到达目标后停留的毫秒数。正数表示停留后恢复原状态，0 或省略表示保持。'},
            },
        },
    }}
    parameters = tool['function']['parameters']['properties']
    parameters['gesture'] = {'type': 'string', 'enum': list(GESTURES),
                             'description': '执行完整手势或舞蹈，然后平滑回到原姿势。'}
    parameters['steps'] = {'type': 'array', 'minItems': 1, 'maxItems': MAX_SEQUENCE_STEPS,
                           'description': '自编动作序列，逐步给关节目标。省略的关节保持上一阶段；和 gesture 二选一。',
                           'items': {'type': 'object', 'additionalProperties': False,
                                     'required': ['duration_ms', 'joints'], 'properties': {
                                         'duration_ms': {'type': 'integer', 'minimum': 80, 'maximum': 3000},
                                         'joints': joint_schema}}}
    parameters['repeat'] = {'type': 'integer', 'minimum': 1, 'maximum': 6,
                            'description': '手势或步骤的执行次数；总时长至多 20 秒。'}
    parameters['stop_sequence'] = {'type': 'boolean', 'description': '平滑结束当前临时动作序列。'}
    if expressions:
        parameters['expression'] = {
            'type': 'string', 'enum': list(expressions),
            'description': '模型表情。换一个表示从已加载的表情中选择与当前不同的一个。',
        }
    if motions:
        parameters['motion'] = {'type': 'string', 'enum': list(motions),
                                'description': '播放原版动作。自然站姿释放当前动作，停留时间不改变片段原速。'}
        parameters['motion_loop'] = {'type': 'boolean', 'description': '显式循环播放；待机默认循环。'}
    if parts:
        parameters['parts'] = {'type': 'object', 'additionalProperties': False, 'properties': {
            name: {'type': 'boolean'} for name in parts},
            'description': '保持或恢复指定外观选项，可和表情、动作一起使用。同类互斥外观会替换。'}
    pose_fields = {name: spec for name, spec in parameters.items() if name not in ('result', 'speech', 'motion_loop')}
    parameters['keep_pose'] = {'type': 'boolean', 'description': '仅在用户明确要求保持最终姿势或外观时开启。'}
    if 'motion' in pose_fields:
        pose_fields['motion'] = {**pose_fields['motion'], 'description': '播放原版动作；阶段 loop 控制持续播放。'}
    parameters['stages'] = {'type': 'array', 'minItems': 1, 'maxItems': MAX_PLAN_STAGES,
                            'description': '顺序阶段。每段 speech 与 pose 并行，段结束后继续下一段。',
                            'items': {'type': 'object', 'additionalProperties': False, 'properties': {
                                'speech': {'type': 'string', 'maxLength': MAX_SPEECH},
                                'pose': {'type': 'object', 'additionalProperties': False, 'properties': pose_fields},
                                'duration_ms': {'type': 'integer', 'minimum': 0, 'maximum': MAX_STAGE_MS},
                                'loop': {'type': 'boolean'},
                                'until_stopped': {'type': 'boolean'}}}}
    return tool


def pose_arguments(message):
    calls = message.get('tool_calls') or []
    if len(calls) != 1 or calls[0].get('function', {}).get('name') != TOOL:
        raise ValueError('DeepSeek 未返回可执行的回复指令')
    args = json.loads(calls[0]['function'].get('arguments', ''))
    if not isinstance(args, dict):
        raise ValueError('DeepSeek 返回了无效的动作指令')
    return args


def reply(message, expressions=(), motions=(), parts=()):
    args = pose_arguments(message)
    speech = args.pop('speech', None)
    result = args.pop('result', None)
    keep_pose = args.pop('keep_pose', False)
    if type(keep_pose) is not bool or (keep_pose and result not in ('pose', 'plan')):
        raise ValueError('保持姿势需要有效的动作或计划')
    if result == 'plan' and set(args) == {'stages'} and speech in (None, ''):
        return '', check_plan(args['stages'], expressions, motions, parts, keep_pose)
    if result == 'pose':
        pose = check_pose(args, expressions, motions, parts)
        if 'motion' in pose and 'motion_loop' not in args:
            pose['motion_loop'] = False
        if keep_pose:
            pose['keep_pose'] = True
    elif result in ('speech', 'unsupported') and not args:
        pose = None
    else:
        raise ValueError('DeepSeek 回复类型与关节指令不匹配')
    if not isinstance(speech, str) or len(speech) > MAX_SPEECH or (not speech.strip() and pose is None):
        raise ValueError('DeepSeek 返回了无效的台词')
    return speech.strip(), pose


def idle_tool(expressions):
    tool = pose_tool(expressions)
    function = tool['function']
    function['description'] = '选择继续待机，或组合一个临时的无声关节动作和表情。'
    parameters = function['parameters']
    parameters['required'] = ['result']
    properties = parameters['properties']
    fields = ('result', 'joints', 'expression', 'gesture', 'steps', 'repeat')
    parameters['properties'] = {name: properties[name] for name in fields if name in properties}
    properties = parameters['properties']
    properties['result'] = {'type': 'string', 'enum': ['idle', 'pose'],
                            'description': 'idle 继续待机；pose 执行无声临时动作或表情。'}
    # Both direct poses and sequence steps use this joint schema.
    idle_ranges = {name: IDLE_ARM_RANGES.get(name, (-1, 1)) for name in IDLE_JOINTS}
    properties['joints']['properties'] = {
        name: {'type': 'number', 'minimum': lower, 'maximum': upper}
        for name, (lower, upper) in idle_ranges.items()
    }
    properties['steps']['maxItems'] = IDLE_MAX_STEPS
    properties['repeat'].update(maximum=IDLE_MAX_REPEAT,
                                description='重复 1–2 次，整段序列不超过 5 秒。')
    if expressions:
        properties['expression']['description'] = '临时表情，和关节动作一起播放，结束后恢复。'
    return tool


def idle_reply(message, expressions=()):
    args = pose_arguments(message)
    result = args.pop('result', None)
    if result == 'idle' and not args:
        return None
    if result != 'pose' or set(args) - {'joints', 'expression', 'gesture', 'steps', 'repeat'}:
        raise ValueError('待机动作超出可选范围')
    pose = check_pose(args, expressions)
    sequence = sequence_duration(pose)
    if (len(pose.get('steps', [])) > IDLE_MAX_STEPS or pose.get('repeat', 1) > IDLE_MAX_REPEAT or
            sequence > IDLE_MAX_SEQUENCE_MS):
        raise ValueError('待机动作序列过长')
    moves = [pose['joints'], *(step['joints'] for step in pose.get('steps', []))]
    if any(name not in IDLE_JOINTS for joints in moves for name in joints):
        raise ValueError('待机动作不能使用举手或抚胸姿势的专用关节')
    for joints in moves:
        for name, position in joints.items():
            if name in IDLE_ARM_RANGES:
                lower, upper = IDLE_ARM_RANGES[name]
                joints[name] = min(upper, max(lower, position))
    pose['duration_ms'] = 280
    pose['hold_ms'] = max(900, sequence - pose['duration_ms'])
    return pose


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class DeepSeek:
    def __init__(self, key):
        if not re.fullmatch(r'[A-Za-z0-9_-]{12,128}', key or ''):
            raise ValueError('请用 --key-file 或 DEEPSEEK_API_KEY 提供 API Key')
        self.key = key
        self.http = build_opener(NoRedirect())

    def post(self, path, body, content_type='application/json'):
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False, allow_nan=False).encode()
        request = Request('https://api.deepseek.com' + path, data=body, headers={
            'Authorization': 'Bearer ' + self.key, 'Content-Type': content_type,
        })
        try:
            return self.http.open(request, timeout=22)
        except HTTPError as error:
            error.close()
            raise RuntimeError(f'DeepSeek 请求失败（HTTP {error.code}）') from None
        except (URLError, OSError):
            raise RuntimeError('连接 DeepSeek 失败，请检查电脑网络') from None

    def transcribe(self, pcm):
        output = io.BytesIO()
        with wave.open(output, 'wb') as wav:
            wav.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
            wav.writeframes(pcm)
        boundary = uuid4().hex
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
                'filename="microphone.wav"\r\nContent-Type: audio/wav\r\n\r\n').encode()
        body += output.getvalue() + f'\r\n--{boundary}--\r\n'.encode()
        with self.post('/v1/tools/asr', body, f'multipart/form-data; boundary={boundary}') as response:
            text = json.load(response)['text'].strip()
        if not text:
            raise ValueError('没有听清，请再说一次')
        return text

    def chat(self, question, history, pose, options=None, appearance=None, autonomous=True):
        options = options or {}
        prompt = SYSTEM + ' 当前已设置的关节：' + json.dumps(pose, ensure_ascii=False)
        prompt += AUTONOMOUS if autonomous else '没有明确动作请求时只用 result=speech。'
        if appearance:
            prompt += ' 当前的表情、动作和外观：' + json.dumps(appearance, ensure_ascii=False)
        body = {
            'model': 'deepseek-flash', 'thinking': {'type': 'disabled'}, 'max_tokens': 2400,
            'messages': [{'role': 'system', 'content': prompt}, *history,
                         {'role': 'user', 'content': question}],
            'tools': [pose_tool(**options)],
            'tool_choice': {'type': 'function', 'function': {'name': TOOL}},
        }
        for attempt in range(2):
            with self.post('/chat/completions', body) as response:
                message = json.load(response)['choices'][0]['message']
            try:
                return reply(message, **options)
            except ValueError as error:
                if attempt:
                    raise
                body['messages'][0]['content'] += (
                    f' 上一次返回的工具参数有误（{error}）。执行动作时必须提供工具支持的有效参数。'
                    'result=plan 时只提交 stages，台词放在各阶段的 speech。'
                    '普通回复或无法执行时只提交 result 和 speech。'
                )

    def choose_idle(self, faces, face, previous, pose):
        expressions = tuple(name for name in faces if name != face)
        context = json.dumps({'表情': face, '关节': pose, '上一次待机动作': previous}, ensure_ascii=False)
        with self.post('/chat/completions', {
            'model': 'deepseek-flash', 'thinking': {'type': 'disabled'}, 'max_tokens': 440,
            'messages': [
                {'role': 'system', 'content': '你是待机中的小鲸。自行决定是否活动。可以用一个 set_avatar_pose '
                 '组合表情和多个关节。例如低头、轻摆尾尖并短暂脸红。joints 取值为 -1 到 1。'
                 '待机手臂只做朝身体外侧的轻微动作，按工具规定的范围取值。'
                 '需要先后动作时填写 steps，每一步的 duration_ms 是毫秒。也可选预设 gesture。'
                 '动作会自动恢复，保持简短并避免重复上一次。想安静待着时填 result=idle。'},
                {'role': 'user', 'content': context},
            ],
            'tools': [idle_tool(expressions)],
            'tool_choice': {'type': 'function', 'function': {'name': TOOL}},
        }) as response:
            return idle_reply(json.load(response)['choices'][0]['message'], expressions)

    def speak(self, text, cancelled):
        with self.post('/v1/tools/tts', {'text': text, 'voice_id': 'stella', 'format': 'pcm'}) as response:
            size = 0
            while not cancelled.is_set():
                block = response.read1(8192)
                if not block:
                    break
                size += len(block)
                if size > VOICE_RATE * 2 * 90:
                    raise ValueError('语音回复过长')
                yield block
            if not cancelled.is_set() and (not size or size % 2):
                raise ValueError('语音回复不完整')
