from io import BytesIO
import json
import struct
import unittest
from unittest.mock import patch

from avatar_voice import (LEVEL_WINDOW_SAMPLES, TOOL, AvatarPlan, DeepSeek, VoiceEnvelope,
                          check_pose, idle_reply, reply)


def tool_reply(arguments):
    return {'tool_calls': [{'function': {'name': TOOL, 'arguments': json.dumps(arguments)}}]}


class AvatarVoiceTests(unittest.TestCase):
    def test_idle_decision_supports_skip_and_rejects_speech_and_persistent_changes(self):
        self.assertIsNone(idle_reply(tool_reply({'result': 'idle'})))
        for invalid in ({'speech': '你好'}, {'parts': {'黑框眼镜': True}}, {'hold_ms': 0},
                        {'expression': '未加载'}, {'motion_loop': True}, {'gesture': '跳舞', 'repeat': 2}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                idle_reply(tool_reply({'result': 'pose', 'joints': {'head_pitch': -0.2}, **invalid}))

    def test_idle_composes_joints_sequence_and_expression_in_one_temporary_pose(self):
        steps = [{'duration_ms': 800, 'joints': {'tail_6': 0.4}},
                 {'duration_ms': 900, 'joints': {'tail_6': -0.4}}]
        pose = idle_reply(tool_reply({'result': 'pose', 'joints': {'head_pitch': -0.2},
                                     'steps': steps, 'expression': '脸红'}), ('脸红',))
        self.assertEqual(pose['joints'], {'head_pitch': -0.2})
        self.assertEqual(pose['steps'], steps)
        self.assertEqual(pose['expression'], '脸红')
        self.assertEqual(pose['duration_ms'] + pose['hold_ms'], 1700)

    def test_idle_request_reuses_the_pose_tool_and_sends_only_avatar_state(self):
        api = DeepSeek('dummy-local-test')
        answer = {'choices': [{'message': tool_reply({'result': 'pose', 'expression': '脸红'})}]}
        previous, held = {'gesture': '点头'}, {'left_elbow': 0.3}
        with patch.object(api, 'post', return_value=BytesIO(json.dumps(answer).encode())) as post:
            pose = api.choose_idle(('爱心眼', '脸红'), '爱心眼', previous, held)
        self.assertEqual(pose['expression'], '脸红')
        path, body = post.call_args.args
        self.assertEqual(path, '/chat/completions')
        self.assertEqual(json.loads(body['messages'][-1]['content']),
                         {'表情': '爱心眼', '关节': held, '上一次待机动作': previous})
        self.assertEqual(body['tools'][0]['function']['name'], TOOL)
        properties = body['tools'][0]['function']['parameters']['properties']
        self.assertEqual(properties['expression']['enum'], ['脸红'])
        self.assertIn('joints', properties)
        self.assertIn('steps', properties)
        self.assertNotIn('speech', properties)
        joints = properties['joints']['properties']
        self.assertNotIn('raised_left_shoulder', joints)
        self.assertEqual(joints['right_elbow']['minimum'], 0)
        self.assertIs(properties['steps']['items']['properties']['joints']['properties'], joints)

    def test_idle_arms_stay_within_the_visible_ranges(self):
        pose = idle_reply(tool_reply({'result': 'pose', 'joints': {'right_elbow': -.8, 'tail_1': -.8},
                                     'steps': [{'duration_ms': 300, 'joints': {'left_shoulder': .92}}]}))
        self.assertEqual(pose['joints'], {'right_elbow': 0, 'tail_1': -.8})
        self.assertEqual(pose['steps'][0]['joints'], {'left_shoulder': .42})
        with self.assertRaises(ValueError):
            idle_reply(tool_reply({'result': 'pose', 'joints': {'chest_right_elbow': .5}}))

    def test_dispatches_independent_joints_in_one_tool_call(self):
        pose = {'joints': {'left_elbow': -0.7, 'tail_6': 0.5}, 'duration_ms': 800}
        text, command = reply(tool_reply({'speech': '看这里。', 'result': 'pose', **pose}))
        self.assertEqual(text, '看这里。')
        self.assertEqual(command, {**pose, 'release': [], 'hold_ms': 0})
        self.assertNotIn('right_elbow', command['joints'])

    def test_keeps_temporary_hold_in_the_tool_arguments(self):
        movement = {'joints': {'left_elbow': -0.4}, 'hold_ms': 350, 'duration_ms': 280}
        text, command = reply(tool_reply({'speech': '好。', 'result': 'pose', **movement}))
        self.assertEqual(text, '好。')
        self.assertEqual(command, {**movement, 'release': []})

    def test_acknowledgement_without_a_command_cannot_report_an_action(self):
        for message in (
            {'content': '做好了。'},
            tool_reply({'speech': '做好了。', 'result': 'pose'}),
            tool_reply({'speech': '好。', 'result': 'speech', 'joints': {'left_elbow': -0.6}}),
        ):
            with self.subTest(message=message), self.assertRaises(ValueError):
                reply(message)
        self.assertEqual(reply(tool_reply({'result': 'speech', 'speech': '你好。'})), ('你好。', None))
        text = '这个模型还不能走路。'
        self.assertEqual(reply(tool_reply({'result': 'unsupported', 'speech': text})), (text, None))

    def test_expression_only_uses_the_loaded_catalog(self):
        command = tool_reply({'result': 'pose', 'speech': '换个表情。', 'expression': '换一个'})
        _, pose = reply(command, ('默认', '爱心眼', '换一个'))
        self.assertEqual(pose['expression'], '换一个')
        self.assertEqual(pose['joints'], {})
        with self.assertRaises(ValueError):
            reply(command, ('默认',))

    def test_combines_a_recorded_motion_and_an_appearance_switch(self):
        command = {'speech': '看这里。', 'result': 'pose', 'motion': '竖食指', 'parts': {'黑框眼镜': True}}
        _, pose = reply(tool_reply(command), motions=('竖食指',), parts=('黑框眼镜',))
        self.assertEqual(pose['motion'], '竖食指')
        self.assertFalse(pose['motion_loop'])
        self.assertEqual(pose['parts'], {'黑框眼镜': True})
        for limits in ({'motions': ('待机',), 'parts': ('黑框眼镜',)}, {'motions': ('竖食指',), 'parts': ()}):
            with self.subTest(limits=limits), self.assertRaises(ValueError):
                reply(tool_reply(command), **limits)

    def test_accepts_a_repeated_gesture_without_speech(self):
        text, pose = reply(tool_reply({'result': 'pose', 'speech': '',
                                      'gesture': '身体左右摇', 'repeat': 2}))
        self.assertEqual(text, '')
        self.assertEqual(pose['gesture'], '身体左右摇')
        self.assertEqual(pose['repeat'], 2)
        with self.assertRaises(ValueError):
            reply(tool_reply({'result': 'speech', 'speech': ''}))

    def test_checks_the_entire_sequence_and_rejects_conflicting_controls(self):
        steps = [{'duration_ms': 350, 'joints': {'head_yaw': -0.5}},
                 {'duration_ms': 400, 'joints': {'head_yaw': 0.5, 'tail_1': -0.3}}]
        self.assertEqual(check_pose({'steps': steps, 'repeat': 3})['steps'], steps)
        for command in (
            {'steps': steps, 'gesture': '点头'},
            {'steps': steps, 'stop_sequence': True},
            {'steps': steps, 'repeat': 7},
            {'repeat': 2, 'joints': {'head_yaw': 0.5}},
            {'steps': [{'duration_ms': 100, 'joints': {'head_yaw': 2}}]},
            {'steps': [{'duration_ms': 100, 'joints': {}}]},
            {'steps': [{'duration_ms': 3000, 'joints': {'jaw': 0}}] * 2, 'repeat': 4},
        ):
            with self.subTest(command=command), self.assertRaises(ValueError):
                check_pose(command)

    def test_plan_preserves_order_and_can_pair_speech_with_a_pose(self):
        text, plan = reply(tool_reply({'result': 'plan', 'stages': [
            {'speech': '你好呀。', 'pose': {'gesture': '点头'}},
            {'speech': '然后你听。', 'pose': {'expression': '爱心眼'}},
            {'pose': {'gesture': '跳舞'}, 'loop': True, 'duration_ms': 30000},
        ]}), expressions=('爱心眼',))
        self.assertEqual(text, '')
        self.assertIsInstance(plan, AvatarPlan)
        self.assertEqual([s.speech for s in plan.stages], ['你好呀。', '然后你听。', ''])
        self.assertEqual(plan.stages[0].pose['gesture'], '点头')
        self.assertEqual(plan.stages[1].pose['expression'], '爱心眼')
        self.assertTrue(plan.stages[2].loop)
        self.assertEqual(plan.stages[2].duration_ms, 30000)

    def test_plan_checks_stop_conditions_and_supports_silent_waits(self):
        forever = {'pose': {'gesture': '跳舞'}, 'loop': True, 'until_stopped': True}
        _, plan = reply(tool_reply({'result': 'plan', 'stages': [{'duration_ms': 1200}, forever]}))
        self.assertEqual(plan.stages[0].duration_ms, 1200)
        self.assertTrue(plan.stages[-1].until_stopped)
        for stages in (
            [forever, {'speech': '这一段永远无法到达。'}],
            [{'loop': True, 'duration_ms': 2000, 'pose': {'expression': '爱心眼'}}],
            [{'loop': True, 'pose': {'gesture': '跳舞'}}],
            [{'duration_ms': True}],
            [{'pose': {'gesture': '不存在'}}],
        ):
            with self.subTest(stages=stages), self.assertRaises(ValueError):
                reply(tool_reply({'result': 'plan', 'stages': stages}), expressions=('爱心眼',))

    def test_plan_normalizes_known_loop_controls_nested_by_the_model(self):
        motion = {'gesture': '跳舞', 'loop': True, 'until_stopped': True}
        _, plan = reply(tool_reply({'result': 'plan', 'stages': [{'pose': motion}]}))
        self.assertTrue(plan.stages[0].loop)
        self.assertTrue(plan.stages[0].until_stopped)
        self.assertNotIn('loop', plan.stages[0].pose)
        with self.assertRaises(ValueError):
            reply(tool_reply({'result': 'plan', 'stages': [{'pose': motion, 'loop': False}]}))

    def test_pose_retention_defaults_to_temporary_and_accepts_explicit_keep(self):
        raw = {'result': 'pose', 'speech': '来讲个笑话。', 'expression': '爱心眼'}
        _, temporary = reply(tool_reply(raw), expressions=('爱心眼',))
        _, held = reply(tool_reply({**raw, 'keep_pose': True}), expressions=('爱心眼',))
        self.assertFalse(temporary.get('keep_pose', False))
        self.assertTrue(held['keep_pose'])

        raw = {'result': 'plan', 'stages': [{'speech': '结束啦。', 'pose': {'expression': '爱心眼'}}]}
        self.assertFalse(reply(tool_reply(raw), expressions=('爱心眼',))[1].keep_pose)
        self.assertTrue(reply(tool_reply({**raw, 'keep_pose': True}), expressions=('爱心眼',))[1].keep_pose)
        with self.assertRaises(ValueError):
            reply(tool_reply({**raw, 'keep_pose': 'true'}), expressions=('爱心眼',))

    def test_recorded_motion_needs_an_explicit_loop_in_the_reply(self):
        raw = {'result': 'pose', 'speech': '', 'motion': '待机'}
        self.assertFalse(reply(tool_reply(raw), motions=('待机',))[1]['motion_loop'])
        self.assertTrue(reply(tool_reply({**raw, 'motion_loop': True}), motions=('待机',))[1]['motion_loop'])

    def test_rejects_unknown_out_of_range_and_conflicting_joints(self):
        for command in (
            {'joints': {'unknown_joint': 0}},
            {'joints': {'left_elbow': 1.1}},
            {'joints': {'left_elbow': True}},
            {'joints': {'left_eye': float('nan')}},
            {'joints': {'left_eye': 0}, 'release': ['left_eye']},
            {'joints': {'left_elbow': 0}, 'hold_ms': 5001},
            {'joints': {'left_elbow': 0}, 'hold_ms': True},
        ):
            with self.subTest(command=command), self.assertRaises(ValueError):
                check_pose(command)

    def test_voice_levels_follow_pcm_samples_across_partial_chunks(self):
        window = LEVEL_WINDOW_SAMPLES
        pcm = b'\0\0' * window + struct.pack('<h', 12000) * window + b'\0\0' * window
        envelope = VoiceEnvelope()
        for index in range(0, len(pcm), 277):
            envelope.feed(pcm[index:index + 277])
        self.assertEqual(envelope.at(0), 0.0)
        self.assertGreater(envelope.at(22000), 0.9)
        self.assertEqual(envelope.at(42000), 0.0)
        self.assertEqual(envelope.at(60000), 0.0)

    def test_voice_level_includes_the_final_short_pcm_block(self):
        envelope = VoiceEnvelope()
        envelope.feed(struct.pack('<h', 3000) * 240 + b'\x00')
        self.assertGreater(envelope.at(5000), 0.0)
        self.assertEqual(envelope.at(10000), 0.0)
