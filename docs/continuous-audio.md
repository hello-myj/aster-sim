# 桌面模拟器的音效与录屏

源码按 ABI 4.5.0 链接应用。游戏可以使用 `audio-effects` 和 `audio-effects-memory` 播放音效；关闭音频的运行模式会影响设备上报的能力。旧的 `sim-v1.0.0` 便携包使用 ABI 4.3。[接口快照](../src/sdk-compat.json) · [发布说明](../release/NOTES.md)

Python / PySide6 桌面把音频送往系统默认输出设备。录制 MP4 时，模拟器将生成的 PCM 音频与屏幕帧一起交给录制流程。要验证游戏音效，先在桌面运行带音频的应用，再录制包含可听操作的一段。[桌面运行与录屏](../desktop/README.md)

命令行回放适合检查触摸、帧事件和音效状态；实机 I²S 输出、蓝牙接收和蓝牙音箱延迟需在相应开发板验证。源码模拟器未提供 `audio-stream` 或 `media-player` 后端。应用声明其为必需能力时会在启动检查阶段收到不支持结果。[回放](replay.md)
