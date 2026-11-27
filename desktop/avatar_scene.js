/* SPDX-License-Identifier: MIT */
(() => {
    const find = name => document.getElementById(name);
    const buttons = ['record', 'stop', 'retry', 'original', 'autonomous', 'idle', 'reset',
                     'ai-settings', 'ai-back', 'ai-toggle', 'ai-key'];
    const zoom = find('zoom');
    let bridge;
    const content = (element, value) => {
        if (element.textContent === value) return;
        element.textContent = value;
        element.hidden = !value;
        element.scrollTop = 0;
    };
    window.asterUI = {
        update(state) {
            find('record').textContent = state.recording ? '说完了' : '开始说话';
            find('record').disabled = !state.ready || !state.aiEnabled;
            find('record').setAttribute('aria-pressed', String(state.recording));
            find('stop').hidden = !state.stoppable;
            find('retry').hidden = !state.failed;
            find('original').hidden = !state.has_lightweight;
            find('original').disabled = state.busy || state.recording;
            find('reset').disabled = !state.ready || state.busy || state.recording;
            find('ai-key').disabled = state.busy || state.recording;
            find('ai-toggle').textContent = state.aiEnabled ? '已开启' : '已关闭';
            find('ai-toggle').setAttribute('aria-pressed', String(state.aiEnabled));
            find('ai-settings-page').hidden = !state.aiSettingsOpen;
            content(find('ai-setting-notice'), state.aiSettingNotice);
            for (const key of ['original', 'autonomous', 'idle']) {
                find(key).setAttribute('aria-pressed', String(state[key]));
            }
            if (zoom.valueAsNumber !== state.zoom) {
                zoom.value = state.zoom;
                window.asterAvatar?.setZoom(state.zoom / 100);
            }
            find('zoom-label').textContent = `${state.zoom}%`;
            content(find('notice'), state.ready || state.failed ? state.notice : '');
            content(find('caption'), state.caption);
        },
    };
    zoom.addEventListener('input', () => {
        const value = zoom.valueAsNumber;
        find('zoom-label').textContent = `${value}%`;
        window.asterAvatar?.setZoom(value / 100);
        bridge?.zoomChanged(value);
    });
    for (const name of buttons) {
        find(name).addEventListener('click', () => {
            if (name === 'ai-settings') find('settings').open = false;
            bridge?.control(name);
        });
    }
    if (window.qt?.webChannelTransport && window.QWebChannel) {
        new QWebChannel(window.qt.webChannelTransport, channel => {
            bridge = channel.objects.avatar;
            find('voice-controls').hidden = false;
            bridge.connected();
        });
    }
})();

(async function () {
    const loading = document.getElementById('loading');
    const stage = document.getElementById('avatar-stage');
    const options = new URLSearchParams(location.search);
    function show(state, message) {
        document.body.dataset.ready = state;
        loading.textContent = message;
        document.title = 'aster-avatar:' + JSON.stringify([Number(options.get('attempt')), state, message]);
    }
    try {
        show('loading', '正在初始化角色引擎…');
        if (!globalThis.purismReady || !globalThis.PIXI?.live2d) throw new Error('角色引擎文件缺失或读取失败');
        await globalThis.purismReady;
        const [jointResponse, faceResponse] = await Promise.all([fetch('/joints.json'), fetch('/expressions.json')]);
        if (!jointResponse.ok || !faceResponse.ok) throw new Error('关节或表情配置读取失败');
        const [names, config] = await Promise.all([jointResponse.json(), faceResponse.json()]);
        const {faces, parts, motions: clips} = config;
        let app;
        try {
            app = new PIXI.Application({
                width: stage.clientWidth, height: stage.clientHeight, resolution: devicePixelRatio,
                autoDensity: true, antialias: true, backgroundAlpha: 0,
            });
        } catch {
            throw new Error('WebGL 渲染器无法启动');
        }
        const original = options.get('quality') === 'original';
        const file = original ? 'preview-original.model3.json' : 'preview.model3.json';
        app.view.addEventListener('webglcontextlost', () => {
            app.ticker.stop();
            if (!loading.isConnected) stage.append(loading);
            show('failed', '显卡渲染已中断，请重试或关闭原图模式');
        });
        show('loading', original ? '正在读取原图贴图…' : '正在读取轻量贴图…');
        let actor;
        try {
            actor = await PIXI.live2d.Live2DModel.from('/source/model/' + file, {autoInteract: false, autoUpdate: false});
        } catch (error) {
            console.error(error.message);
            throw new Error('模型或贴图读取失败，请检查素材目录');
        }
        stage.append(app.view);
        app.stage.addChild(actor);
        const model = actor.internalModel;
        const core = model.coreModel;
        const raw = core._model;
        const p = raw.parameters;
        const indices = new Map(p.ids.map((id, index) => [id, index]));
        // The model's front face, head and maid headdress form the touch area.
        const headParts = new Set(['Part99', 'Part15', 'Part161'].map(id => raw.parts.ids.indexOf(id)));
        headParts.delete(-1);
        const headMeshes = raw.drawables.ids.map((_, i) => i)
            .filter(i => headParts.has(raw.drawables.parentPartIndices[i]));
        const pet = {pointer: null, lastX: 0, lastY: 0, moved: 0, strength: 0,
            amount: 0, x: 0, y: 0, leanX: 0, leanY: 0};
        const blush = indices.get('key7');
        const eyeSmile = indices.get('EyeSmile');
        const joints = Object.fromEntries(Object.entries(names).map(([name, id]) => [name, indices.get(id)]));
        const jointIndices = Object.values(joints);
        const entries = Object.entries(joints);
        if (jointIndices.includes(undefined)) throw new Error('角色缺少所需的关节参数');
        const faceChannels = [...new Set(Object.values(faces).flatMap(Object.keys))]
            .map(id => [id, indices.get(id)]).filter(([, index]) => index !== undefined);
        const faceJoints = faceChannels.filter(([, index]) => jointIndices.includes(index));
        const faceExtras = faceChannels.filter(([, index]) => !jointIndices.includes(index));
        const partChannels = [...new Set(Object.values(parts).flatMap(Object.keys))]
            .map(id => indices.get(id)).filter(index => index !== undefined);
        const leanInput = indices.get('LeanInput');
        const leanJoints = partChannels.includes(leanInput)
            ? new Set([joints.body_pitch, joints.shoulder_height]) : new Set();
        let leanValue = 0;
        const clipTracks = Object.fromEntries(Object.entries(clips).map(([name, clip]) => [name, {
            duration: clip.duration, tracks: Object.entries(clip.curves).map(([id, values]) => [indices.get(id), values])
                .filter(([index]) => index !== undefined),
        }]));
        const set = (index, value) => core.setParameterValueByIndex(index, value);
        const neutral = index => p.defaultValues[index];
        const held = new Map();
        const motions = new Map();
        const faceHeld = new Map();
        const faceMotions = new Map();
        const faceValues = new Map();
        const basePose = new Map();
        const rendered = new Map();
        let clipFrame = new Map(), activeClip;
        let partFrame = new Map();
        let sequence;
        const standingArm = /^(left|right)_(shoulder|elbow|wrist|fingers|finger_detail)$/;
        const armMode = ['Movement1', 'Movement2', 'Movement3'].map(name => indices.get(name));
        const modeWeight = index => Math.max(0, Math.min(1, p.values[index] ?? 0));
        const sequenceReturnMs = 370;
        const blend = (from, to, t) => from + (to - from) * t * t * (3 - 2 * t);
        function jointTarget(index, position) {
            const center = neutral(index);
            const distance = position >= 0 ? p.maximumValues[index] - center : center - p.minimumValues[index];
            return center + position * distance;
        }

        function armWeight(name, raised, chest, pointing) {
            if (name === 'raised_left_index') return pointing;
            if (name.startsWith('raised_left_')) return raised;
            if (name.startsWith('chest_right_')) return chest;
            if (standingArm.test(name)) return 1 - (name.startsWith('left_') ? raised : chest);
            return 1;
        }

        function headBounds() {
            let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
            for (const index of headMeshes) {
                if (raw.drawables.opacities[index] < 0.05) continue;
                const area = model.getDrawableBounds(index);
                left = Math.min(left, area.x);
                top = Math.min(top, area.y);
                right = Math.max(right, area.x + area.width);
                bottom = Math.max(bottom, area.y + area.height);
            }
            if (right > left && bottom > top) {
                return {x: (left + right) / 2, y: (top + bottom) / 2,
                    radiusX: (right - left) * 0.54, radiusY: (bottom - top) * 0.55};
            }
            return null;
        }

        function catchHead(event) {
            const area = headBounds();
            if (!area) return null;
            const rect = app.view.getBoundingClientRect();
            const point = actor.toModelPosition(new PIXI.Point(
                (event.clientX - rect.left) * app.screen.width / rect.width,
                (event.clientY - rect.top) * app.screen.height / rect.height,
            ));
            return {x: (point.x - area.x) / area.radiusX, y: (point.y - area.y) / area.radiusY};
        }

        function endPet(event) {
            if (event.pointerId === pet.pointer) pet.pointer = null;
        }

        app.view.addEventListener('pointerdown', event => {
            if (pet.pointer !== null || (event.pointerType === 'mouse' && event.button !== 0)) return;
            const point = catchHead(event);
            if (!point || Math.hypot(point.x, point.y) > 1) return;
            pet.pointer = event.pointerId;
            pet.lastX = event.clientX;
            pet.lastY = event.clientY;
            pet.strength = 0;
            if (event.isTrusted) app.view.setPointerCapture(event.pointerId);
            event.preventDefault();
        });
        app.view.addEventListener('pointermove', event => {
            const point = catchHead(event);
            const distance = point ? Math.hypot(point.x, point.y) : Infinity;
            if (pet.pointer !== event.pointerId) {
                if (event.pointerType === 'mouse') app.view.style.cursor = distance <= 1 ? 'grab' : '';
                return;
            }
            if (distance > 1.4) return endPet(event);
            const dx = event.clientX - pet.lastX;
            const dy = event.clientY - pet.lastY;
            const travelled = Math.hypot(dx, dy);
            if (travelled < 2) return;
            pet.lastX = event.clientX;
            pet.lastY = event.clientY;
            pet.x = Math.max(-1, Math.min(1, point.x + dx * 0.018));
            pet.y = Math.max(-1, Math.min(1, point.y));
            pet.strength = Math.min(1, pet.strength + Math.min(travelled * 0.045, 0.5));
            pet.moved = performance.now();
            event.preventDefault();
        });
        for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
            app.view.addEventListener(event, endPet);
        }
        window.addEventListener('blur', () => { pet.pointer = null; });

        function applyPet(now, dt) {
            const active = pet.pointer !== null && now - pet.moved < 520;
            const target = active ? pet.strength : 0;
            pet.amount += (target - pet.amount) * (1 - Math.exp(-dt / (active ? 75 : 245)));
            const follow = 1 - Math.exp(-dt / 105);
            pet.leanX += ((active ? pet.x : 0) - pet.leanX) * follow;
            pet.leanY += ((active ? pet.y : 0) - pet.leanY) * follow;
            if (pet.amount < 0.002) return;
            function react(index, value) {
                set(index, value);
                rendered.set(index, p.values[index]);
            }
            const amount = pet.amount;
            react(joints.head_yaw, p.values[joints.head_yaw] - pet.leanX * amount * 10);
            react(joints.head_roll, p.values[joints.head_roll] + pet.leanX * amount * 12);
            react(joints.head_pitch, p.values[joints.head_pitch] + (pet.leanY * 7 - 2) * amount);
            for (const index of [joints.left_eye, joints.right_eye]) react(index, p.values[index] * (1 - 0.36 * amount));
            if (eyeSmile !== undefined) react(eyeSmile, Math.max(p.values[eyeSmile], 0.68 * amount));
            if (blush !== undefined) react(blush, Math.max(p.values[blush], amount));
        }
        // Subtle offsets around the current pose, using the model's own ranges.
        // Arms follow the shoulder and body without changing individual elbows or wrists.
        const sway = {
            head_yaw: [0.027, 0.0011, 0.4], head_pitch: [0.042, 0.0017, 0.9],
            head_roll: [0.021, 0.0011, 2.2], body_pitch: [0.030, 0.0017, 0],
            body_roll: [0.021, 0.0011, 1.6], left_shoulder: [0.027, 0.0017, 0.5],
            right_shoulder: [0.024, 0.0017, 2.9], tail_1: [0.052, 0.00135, 0],
            tail_2: [0.020, 0.00135, -0.4], tail_4: [0.031, 0.00135, -0.8],
            tail_6: [0.046, 0.00135, -1.2],
        };

        function sample(index, automatic, now, targets = held, transitions = motions) {
            const rest = targets.get(index) ?? automatic;
            const motion = transitions.get(index);
            if (!motion) return rest;
            const elapsed = now - motion.start;
            const target = motion.to ?? rest;
            if (elapsed < motion.duration) return blend(motion.from, target, elapsed / motion.duration);
            const returning = elapsed - motion.duration - motion.hold;
            if (returning < 0) return target;
            if (motion.hold && returning < motion.duration) {
                return blend(target, rest, returning / motion.duration);
            }
            transitions.delete(index);
            return rest;
        }

        function stageSequence(steps, repeat, now) {
            const members = new Set(steps.flatMap(step => Object.keys(step.joints).map(name => joints[name])));
            const initial = new Map([...members].map(index => [index, basePose.get(index) ?? neutral(index)]));
            const period = steps.reduce((ms, step) => ms + step.duration_ms, 0);
            const materialize = start => {
                let from = start;
                return steps.map(step => {
                    const to = new Map(from);
                    for (const [name, position] of Object.entries(step.joints)) {
                        const index = joints[name];
                        to.set(index, jointTarget(index, position));
                    }
                    const frame = {from, to, duration: step.duration_ms};
                    from = to;
                    return frame;
                });
            };
            const first = materialize(initial);
            const repeated = materialize(first.at(-1).to);
            sequence = {members, start: now, period, repeat, first, repeated,
                end: (repeat > 1 ? repeated : first).at(-1).to};
        }

        function sequenceFrame(now) {
            if (!sequence) return;
            const {start, period, repeat, first, repeated, end} = sequence;
            const elapsed = now - start;
            const after = elapsed - period * repeat;
            if (after >= sequenceReturnMs) {
                sequence = undefined;
                return;
            }
            if (after >= 0) return {from: end, progress: after / sequenceReturnMs};
            let position = elapsed % period;
            for (const frame of (elapsed < period ? first : repeated)) {
                if (position < frame.duration) return {...frame, progress: position / frame.duration};
                position -= frame.duration;
            }
        }

        const cubic = (a, b, c, d, t) => {
            const s = 1 - t;
            return s * s * s * a + 3 * s * s * t * b + 3 * s * t * t * c + t * t * t * d;
        };
        function curveAt(track, time) {
            let [start, value] = track;
            if (time <= start) return value;
            for (let i = 2; i < track.length;) {
                const kind = track[i++];
                const end = i + (kind === 1 ? 4 : 0);
                const next = track[end], target = track[end + 1];
                if (time < next) {
                    if (kind === 2) return value;
                    if (kind === 3) return target;
                    if (kind === 0) return value + (target - value) * ((time - start) / (next - start));
                    let low = 0, high = 1;
                    for (let j = 0; j < 10; j++) {
                        const mid = (low + high) / 2;
                        if (cubic(start, track[i], track[i + 2], next, mid) < time) low = mid;
                        else high = mid;
                    }
                    return cubic(value, track[i + 1], track[i + 3], target, (low + high) / 2);
                }
                start = next;
                value = target;
                i = end + 2;
            }
            return value;
        }

        function applyClip(now) {
            if (activeClip) {
                const {clip, start, loop, previous, restored} = activeClip;
                const elapsed = (now - start) / 1000;
                const time = loop ? elapsed % clip.duration : restored ? clip.duration : Math.min(elapsed, clip.duration);
                const target = new Map(clip.tracks.map(([index, track]) => [index, curveAt(track, time)]));
                const progress = Math.min(1, elapsed / 0.18);
                for (const [index, value] of previous) {
                    if (progress < 1) target.set(index, blend(value, target.get(index) ?? p.values[index], progress));
                }
                for (const [index, value] of target) {
                    if (progress < 1 && !previous.has(index)) target.set(index, blend(p.values[index], value, progress));
                }
                clipFrame = target;
                if (!loop && time >= clip.duration && progress >= 1) activeClip = undefined;
            }
            for (const [index, value] of clipFrame) set(index, value);
        }

        // The original preview hides two unused marker meshes around the nose.
        const update = raw.update.bind(raw);
        const markers = ['ArtMesh246', 'ArtMesh682'].map(id => raw.drawables.ids.indexOf(id)).filter(i => i >= 0);
        raw.update = () => {
            update();
            for (const index of markers) {
                raw.drawables.opacities[index] = 0;
                raw.drawables.dynamicFlags[index] = 0;
            }
        };
        model.eyeBlink = undefined;
        let voiceActive = false, voiceLevel = 0, mouthOpening = 0, lastFrame = performance.now();
        const breath = indices.get('ParamBreath');
        const jawHinge = indices.get('JawOpen');
        if (partChannels.includes(leanInput)) {
            model.on('afterMotionUpdate', () => {
                // LeanInput drives Cubism physics; beforeModelUpdate is too
                // late for that frame, and Cubism restores its parameters.
                leanValue = sample(leanInput, neutral(leanInput), performance.now());
                set(leanInput, leanValue);
            });
        }
        model.on('beforeModelUpdate', () => {
            const now = performance.now();
            for (const index of jointIndices) {
                if (!leanJoints.has(index)) set(index, neutral(index));
            }
            const blink = (now % 4900 - 2900) / 95;
            const openness = 1 - Math.max(0, 1 - Math.abs(blink));
            for (const eye of [joints.left_eye, joints.right_eye]) set(eye, neutral(eye) * openness);
            if (breath !== undefined) set(breath, (Math.sin(now / 680) + 1) / 2);
            const dt = now - lastFrame;
            const smoothing = voiceLevel > mouthOpening ? 22 : 55;
            mouthOpening = voiceLevel + (mouthOpening - voiceLevel) * Math.exp(-dt / smoothing);
            lastFrame = now;
            applyClip(now);
            // Appearance toggles such as "竖食指开" share these selectors
            // with the authored clips. Resolve the active arm before applying
            // manual targets to either version of that arm.
            for (const index of partChannels) {
                const value = index === leanInput ? leanValue : sample(index, p.values[index], now);
                basePose.set(index, value);
                set(index, value);
                rendered.set(index, p.values[index]);
            }
            const pointing = modeWeight(armMode[2]);
            const raised = Math.max(modeWeight(armMode[0]), pointing);
            const chest = modeWeight(armMode[1]);
            const gesture = sequenceFrame(now);
            if (voiceActive || mouthOpening > 0.002) {
                set(joints.jaw, neutral(joints.jaw) + mouthOpening * (p.maximumValues[joints.jaw] - neutral(joints.jaw)));
                const manualJaw = held.has(joints.jaw) || motions.get(joints.jaw)?.to !== undefined ||
                    sequence?.members.has(joints.jaw);
                if (jawHinge !== undefined) {
                    const amount = manualJaw ? 0 : mouthOpening * 0.4;
                    set(jawHinge, neutral(jawHinge) + amount * (p.maximumValues[jawHinge] - neutral(jawHinge)));
                }
            }
            for (const [name, index] of entries) {
                const authored = p.values[index];
                let value = sample(index, authored, now);
                if (gesture && sequence.members.has(index)) {
                    value = blend(gesture.from.get(index), gesture.to?.get(index) ?? value, gesture.progress);
                }
                const weight = armWeight(name, raised, chest, pointing);
                value = authored + (value - authored) * weight;
                basePose.set(index, value);
                const wave = sway[name];
                const offset = wave ? (p.maximumValues[index] - neutral(index)) * wave[0] *
                    Math.sin(now * wave[1] + wave[2]) : 0;
                set(index, value + offset * weight);
                // Cubism restores motion inputs after updating the mesh.
                rendered.set(index, p.values[index]);
            }
            for (const [, index] of faceExtras) {
                const value = sample(index, p.values[index], now);
                basePose.set(index, value);
                set(index, value);
                rendered.set(index, p.values[index]);
            }
            for (const [, index] of faceJoints) {
                const offset = sample(index, 0, now, faceHeld, faceMotions);
                faceValues.set(index, offset);
                // Explicit joint commands and spoken lip sync take priority.
                if (held.has(index) || motions.get(index)?.to !== undefined || sequence?.members.has(index) ||
                    (index === joints.jaw && voiceActive)) continue;
                set(index, p.values[index] + offset);
                rendered.set(index, p.values[index]);
            }
            applyPet(now, dt);
        });

        const bounds = actor.getLocalBounds();
        let headFocus;
        let zoom = 1.6;
        function camera() {
            const w = app.screen.width, h = app.screen.height;
            const fit = Math.min((w - 12) / bounds.width, (h - 12) / bounds.height);
            const scale = fit * zoom;
            const focus = bounds.height * 0.20;
            const y = bounds.y + focus;
            actor.scale.set(scale);
            const defaultX = w / 2 - (bounds.x + bounds.width / 2) * scale;
            const defaultY = (h - bounds.height * fit) / 2 + focus * fit - y * scale;
            const closeup = headFocus ? Math.max(0, Math.min(1, (zoom - 2.45) / 2.15)) : 0;
            actor.position.set(blend(defaultX, w / 2 - (headFocus?.x ?? 0) * scale, closeup),
                blend(defaultY, h * 0.47 - (headFocus?.y ?? 0) * scale, closeup));
        }
        window.asterAvatar = {
            setZoom(value) { zoom = value; camera(); },
            setVoiceActive(value) { voiceActive = value; },
            setVoiceLevel(value) { voiceLevel = Math.max(0, Math.min(1, value)); },
            hasMotion() { return !!activeClip || !!sequence?.members.size || pet.pointer !== null || pet.amount > 0.02; },
            stopActions() {
                const now = performance.now();
                const affected = new Set([...motions.keys(), ...(sequence?.members ?? [])]);
                sequence = undefined;
                for (const index of affected) {
                    motions.set(index, {from: basePose.get(index) ?? neutral(index), hold: 0,
                        start: now, duration: 240});
                }
                for (const index of faceMotions.keys()) {
                    faceMotions.set(index, {from: faceValues.get(index) ?? 0, hold: 0, start: now, duration: 240});
                }
            },
            setPose(command) {
                const now = performance.now();
                const transition = (index, to, hold) => {
                    const from = basePose.get(index) ?? neutral(index);
                    motions.set(index, {from, to, hold, start: now, duration: command.duration_ms});
                };
                const move = (index, target) => {
                    if (!command.hold_ms) held.set(index, target);
                    transition(index, target, command.hold_ms);
                };
                if (sequence) {
                    if (command.steps || command.stop_sequence) {
                        for (const index of sequence.members) transition(index, undefined, 0);
                        sequence = undefined;
                    } else {
                        // A new direct command can take over one joint while
                        // the remaining joints finish their current animation.
                        for (const name of [...command.release, ...Object.keys(command.joints)]) {
                            sequence.members.delete(joints[name]);
                        }
                    }
                }
                for (const name of command.release) {
                    const index = joints[name];
                    held.delete(index);
                    transition(index, undefined, 0);
                }
                for (const [name, value] of Object.entries(command.joints)) {
                    const index = joints[name];
                    move(index, jointTarget(index, value));
                }
                if (command.steps) stageSequence(command.steps, command.sequence_loop ? Infinity : command.repeat, now);
                if (command.expression && Object.hasOwn(faces, command.expression)) {
                    const face = faces[command.expression];
                    for (const [id, index] of faceExtras) {
                        if (command.expression === '默认' && !command.hold_ms) {
                            held.delete(index);
                            transition(index, undefined, 0);
                        } else move(index, neutral(index) + (face[id] ?? 0));
                    }
                    for (const [id, index] of faceJoints) {
                        const to = face[id] ?? 0;
                        if (!command.hold_ms) faceHeld.set(index, to);
                        faceMotions.set(index, {from: faceValues.get(index) ?? 0, to,
                            hold: command.hold_ms, start: now, duration: command.duration_ms});
                    }
                }
                if (command.parts) {
                    const target = new Map();
                    for (const name of command.parts) {
                        for (const [id, value] of Object.entries(parts[name])) {
                            const index = indices.get(id);
                            if (index !== undefined) target.set(index, value);
                        }
                    }
                    for (const index of partFrame.keys()) {
                        if (!target.has(index)) {
                            held.delete(index);
                            transition(index, undefined, 0);
                        }
                    }
                    for (const [index, value] of target) {
                        const destination = neutral(index) + value;
                        held.set(index, destination);
                        transition(index, destination, 0);
                    }
                    partFrame = target;
                }
                if (command.motion && Object.hasOwn(clipTracks, command.motion)) {
                    const clip = clipTracks[command.motion];
                    activeClip = {clip, start: now, loop: !!(command.motion_loop && clip.duration),
                        previous: clipFrame, restored: command.motion_restored};
                }
            },
            readPose() {
                const pose = Object.fromEntries(entries.map(([name, index]) => [name, rendered.get(index)]));
                pose.face = Object.fromEntries(faceChannels.map(([name, index]) => [name, rendered.get(index)]));
                pose.parts = Object.fromEntries(partChannels.map(index => [p.ids[index], rendered.get(index)]));
                pose.motion = Object.fromEntries([...clipFrame].map(([index, value]) => [p.ids[index], value]));
                pose.sequenceActive = !!sequence?.members.size;
                pose.petting = {active: pet.pointer !== null, amount: pet.amount};
                return pose;
            },
        };
        function resizeStage() {
            const w = stage.clientWidth, h = stage.clientHeight;
            if (!w || !h || (w === app.screen.width && h === app.screen.height &&
                app.renderer.resolution === devicePixelRatio)) return;
            app.renderer.resolution = devicePixelRatio;
            app.renderer.resize(w, h);
            camera();
        }
        const stageSize = new ResizeObserver(resizeStage);
        stageSize.observe(stage);
        window.addEventListener('resize', resizeStage);
        show('loading', '正在绘制角色…');
        // Readiness includes a complete render. Textures may be uploaded to
        // the GPU only here, after the model promise already resolved.
        actor.update(1000 / 60);
        const head = headBounds();
        if (head) headFocus = model.localTransform.apply(new PIXI.Point(head.x, head.y));
        camera();
        app.render();
        if (document.body.dataset.ready === 'failed') return;
        app.ticker.add(() => actor.update(Math.min(65, app.ticker.elapsedMS)));
        show('yes', '');
        loading.remove();
    } catch (error) {
        show('failed', error instanceof Error ? error.message : '角色加载失败');
        console.error(error.message);
    }
})();
