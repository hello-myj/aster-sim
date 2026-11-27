# Python 系统模拟器

源码使用的 APP 契约固定在 [sdk-compat.json](../src/sdk-compat.json)，Windows 便携包的契约见[发行说明](../release/NOTES.md)。调试有独立资源的游戏时，使用与该 AST 同一版的资源目录；从其他板复制的素材可能与本次构建的屏幕布局不同。

从源码构建时，将 `aster-sim` 和 `aster-firmware` 放在同一父目录。便携包已包含桌面核心和运行依赖。

默认系统模拟使用 PySide6 原生窗口。Launcher、卡片动画、手势、下拉设置、Wi-Fi 设置页、启动画面和首次开机进度页直接编译固件 C/LVGL 源码，通过 `aster_device`、`aster_os`、`aster_services` 端口接入桌面。APP 继续由已有 Node/WASM 运行时执行，独立进程异常或超时后可返回桌面。APP 文本读取虚拟 SD 卡上的 CPFONT v4，与设备使用相同字形、整数宽度和基线。

## 安装与运行（Windows）

需要 Python 3.12、Node.js 22+、WSL Ubuntu-22.04，以及相邻的完整固件仓库（含 LVGL）。首次构建使用 WSL CMake 和 MinGW；构建后的界面核心是 Windows 原生 EXE。

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r desktop/requirements.txt
npm ci
wsl -d Ubuntu-22.04 -- sudo apt-get install cmake gcc-mingw-w64-x86-64-posix ffmpeg
.venv\Scripts\python.exe desktop/build_native.py
.\aster-desktop.cmd
```

完成上述构建后可双击 `aster-desktop.cmd`。FFmpeg 用于录屏：优先采用 Windows PATH 中的版本，否则使用 WSL FFmpeg。Node.js 构建时复制到忽略目录 `.tools/desktop/`；也可以用环境变量 `ASTER_SIM_NODE` 指定路径。

## 设备与虚拟 SD 卡

- P4：480×480、RISC-V 商城目录、最多五触点。
- lckfb：240×320、Xtensa 商城目录、最多两触点。APP 声明横屏时自动交换宽高，退出后恢复桌面方向。
- 可修改宽高后点“应用尺寸”，范围 240..1280；倍数 1×/2×/3×只影响窗口显示。准备完某个设备后，也可保留其设备配置修改尺寸来检查布局。

每个配置的卡独立保存在 `state/desktop/{p4,lckfb,custom}`，包含已安装程序、资源、存档、KV 和字体。支持 `--state <目录>` 隔离演示数据。安装使用独立目录保存新一代程序和资源，再原子替换注册表；更新保留应用数据。

空卡显示真实首次开机 UI。点“开始设置”后，在桌面输入资源服务器地址，默认源与 CA 读取固件 `config/distribution.json`。模拟器使用电脑网络；屏幕热点和二维码是模拟信息，不会创建电脑无线热点。下载支持断点续传、长度/SHA-256 检查和校验成功后替换文件；字体与商城完成后进入 Launcher。`--seed-local` 是开发捷径，复制本地固件字体并导入 APPS 已编译商城，不进行首次下载。

“安装 APP”可导入包含 WASM 的 `.ast`，并可指定配套外部资源目录；商城可以通过真实 HTTP(S) 下载。P4/lckfb 配置上报对应 board/arch，使商城选取对应硬件目录；桌面执行包中的 WASM，忽略硬件 AOT。纯 AOT 包无法在桌面运行。

本地导入会显示独立的安装进度窗口：检查包、读取资源、复制程序与资源、提交结果；显示百分比、已复制大小、当前文件和用时。成功后保留“安装成功”结果，可点“打开应用”或“完成”；失败显示具体错误，失败的新版本不会覆盖之前的注册表。

## 命令行快速调试

可以从任意工作目录执行启动脚本。传入已编译工程目录时，根据 `--profile` 查找 `dist/riscv/<id>.ast` 或 `dist/xtensa/<id>.ast`，并自动导入旁边的 `resources` 目录；成功后直接运行 APP：

```powershell
& 'G:\proj\aster\aster-sim\aster-desktop.cmd' --profile p4 --app 'G:\proj\aster\aster-apps\GoldMiner'
& 'G:\proj\aster\aster-sim\aster-desktop.cmd' --profile lckfb --app 'G:\proj\aster\aster-apps\GoldMiner'
```

也可以明确指定安装包和资源根目录（选到包含 `assets` 的那层）：

```powershell
& 'G:\proj\aster\aster-sim\aster-desktop.cmd' --profile p4 --app 'G:\proj\aster\aster-apps\GoldMiner\dist\riscv\aster.goldminer.ast' --resources 'G:\proj\aster\aster-apps\GoldMiner\dist\riscv\resources'
```

在 APP 工程当前目录，可写 `--app .`；仅含内嵌资源的包不需要 `--resources`。此命令使用已有构建产物，不自动调用 SDK 编译；修改源码后先重新编译，再执行同一命令会安装新产物。程序和资源会持久保存，更新保留存档。`--app` 调试模式会直接准备本地字体、跳过首次联网准备；不指定 `--app` 则保持正常首次开机流程。需要隔离调试数据时添加 `--state <目录>`。

## 小鲸助手

```powershell
.\aster-desktop.cmd --ai-avatar 'D:\路径\大肥鱼网页预览' --key-file 'D:\路径\deepseek_key.txt'
```

配置后，从 Aster 系统桌面打开「小鲸助手」，点模拟器「主页」返回。模型目录使用原版预览的 `model` 和 `deps` 子目录。模型路径和 Key 文件路径保存在本机模拟器状态目录，API Key 也可通过 `DEEPSEEK_API_KEY` 提供。

点击右上角「开始说话」使用电脑默认麦克风，点「说完了」提交给 DeepSeek 转写。识别文字和播报台词共用底部字幕区，文字自动换行，播报结束后字幕自动收起。合成音频从电脑默认输出设备播放。角色保持姿势时仍有轻微的呼吸、头部和尾部动作。「设置」内的「恢复姿势」释放已设置的关节。

「设置」菜单里的「AI 设置」会打开单独的配置页，可以开关联网对话或更换 DeepSeek Key 文件。模拟器只保存文件路径。「自主动作」和「待机自主」仍可从原菜单独立切换。

模拟器给 DeepSeek 注册一个 `set_avatar_pose` 工具。`result` 声明执行动作、普通回复或无法完成的动作，`speech` 提供台词。执行动作时可组合以下参数。

- `joints` 设定多个关节，取值 −1 到 1，0 为默认角度。`release` 让选中的关节回到模型动画控制。`duration_ms` 设置过渡时间。
- 手臂控制跟随原版模型的站姿、抚胸举手、竖食指和拿狗尾草姿势。举手或抚胸的专用关节在对应姿势下生效，待机摆臂保持在自然站姿的外侧范围。
- `expression` 选择表情，说「换个表情」会换成不同表情。`hold_ms` 对关节和表情有效，省略或为 0 会保持，正数表示停留后返回原状态。
- `motion` 播放素材目录登记的原版动作，`motion_loop` 控制是否循环。「自然站姿」清除正在播放的动作。任意切换原版动作时会平滑过渡。
- `parts` 分别开启或恢复眼镜、衣服、体型和道具等外观选项。同组外观会替换，脸部表情与外观可同时保持。
- 「前倾」是原版身体姿态，可与表情一起使用。在 `parts` 中开启「前倾」会驱动原版身体、头发和衣服的物理参数，关闭后回正。
- `gesture` 执行左右摇头、身体左右摇、摇尾巴、点头或跳舞。`steps` 可自编动作，逐步指定关节目标和到达时间。`repeat` 控制次数，`stop_sequence` 平滑停止。序列结束后回到原姿势，`speech` 可留空执行无声动作。

长回复和连续动作可用 `result=plan`。`stages` 按顺序执行，每个阶段可把 `speech` 和 `pose` 放在一起。语音从扬声器开始输出时，启动该段动作和表情。当前段播放时会预合成下一段。下一阶段等当前段的播报和动作条件完成后开始。只有 `duration_ms` 的阶段可用于停顿。

日常回答、笑话和故事的手势与表情在整轮结束后恢复到对话前的姿势。显式用顶层 `keep_pose` 指定时，才将最终姿势或外观设为新的常驻状态。中途停止会恢复开始前的状态。未能播出的单次动作仍可静默完成后恢复。

阶段中的 `loop` 可以循环播放手势、关节步骤或原版动作。阶段的 `duration_ms` 设定循环时长，或让循环跟随本段播报。最后一个循环阶段还可用 `until_stopped` 持续到手动停止。点「停止」或在播放中点「开始说话」，会取消当前播报和后续阶段。

分段语音与动作的协议参考 [AIAvatarKit](https://github.com/uezo/aiavatarkit/blob/main/documents/avatar.md)，连续动作排队参考 [Reachy Mini 的 MovementManager](https://github.com/pollen-robotics/reachy_mini_conversation_app/blob/main/src/reachy_mini_conversation_app/moves.py#L1912)。

勾选「自主动作」时，DeepSeek 可在普通对话中自行挑选配合语境的手势和表情。待机的呼吸、眨眼和轻微摆动在本地运行。

「待机自主」默认关闭，可在「设置」开启，或用 `--idle-autonomy` 在启动时开启。窗口可见且连续 10 秒没有交互时，DeepSeek 使用同一个 `set_avatar_pose` 工具，选择继续待机或组合关节、表情和短动作。动作静默播放，结束后恢复原姿势和表情。空闲期间约每 10 秒发起一次请求，以发出时间为基准，等待中的请求结束前只保留这一轮。请求只包含当前表情、已保持的关节值和上一次待机动作摘要。开始录音或操作窗口会中断待机动作，并忽略此前尚未返回的决策。最小化、正在录音或对话时会暂停定时。网络请求失败时隔约五分钟再试。

口型以 20 毫秒为一段测量合成音频的响度，跟随扬声器播放进度和停顿。AI 直接设置下颌姿势时，采用该姿势。合成或输出失败时，已收到的台词和关节指令会继续显示。口型与语音降级的思路参考 [DeepFish-voice](https://github.com/ICEAXEMAN/DeepFish-voice)，在 Aster 中独立实现。

左侧半透明滑条连续调节 60% 到 560% 的取景倍率，放大时逐渐对准头部。角色画布贴合设备屏幕，字幕叠在画面底部。WebGL 从 Live2D 贴图重新绘制模型。存在轻量预览配置时，默认用它更快出画面。「设置」里的「原图」可加载完整分辨率素材，保留取景倍率及当前的关节设置。加载超时或渲染失败时可点「重试」。角色渲染器只读取本机模型素材，语音请求由 Python 发出。

用鼠标左键按住头部并滑动，或用一根手指在头部滑动，可触发蹭头、眯眼和脸红。触摸范围跟随原版头部网格与缩放。松开后，触摸反应渐渐消退，原有的表情或播报动作继续生效。摸头在本地完成，操作时会让待机动作让位。

原版表情文件中的「加载」也可显式选择。眯眼笑、惊讶、皱眉和嘟嘴由原模型的五官参数组合，模型具备相应参数时才出现。

## 操作和导出

鼠标模拟单指；Windows 触屏提供多指事件。松手、失焦时释放触点。Launcher 的滑动、拉开应用和下拉设置沿用固件手势逻辑。工具栏“主页”或 Escape 可退出 APP；“日志”显示运行错误和 APP 输出。

“截图”导出原始屏幕分辨率 PNG；“录屏”导出 30 FPS H.264 + AAC 立体声 MP4，仅录制屏幕内容，不含工具栏。快捷键 Ctrl+Shift+S / Ctrl+Shift+R。音轨包含模拟器内的系统提示音、APP 音效和背景音乐，遵循系统音量、音乐暂停和跳转；不会采集麦克风或电脑其他程序的声音。没有声音输出设备时也可录制内部音频。

音频按视频使用的单调时钟写入临时 PCM 文件，空闲时补静音，内存不随录像时长增长。结束后后台合成为 48 kHz / 192 kbps AAC，界面显示“正在导出…”，完成后替换目标 MP4；失败保留临时目录供恢复。切换尺寸前应结束录像；APP 改变屏幕方向时自动结束当前片段。推荐偶数宽高，以满足 YUV420 编码要求。

## 验证和边界

```powershell
node --test test/*.test.js
.venv\Scripts\python.exe -m unittest discover -s desktop -p "test_*.py" -v
```

窗口集成测试在 Qt offscreen 环境启动真实 EXE 和 APP 子进程，验证 P4/lckfb 卡隔离、TouchTest 第五触点、返回桌面、自定义尺寸、PNG 和 MP4 导出。音频测试同时播放背景音乐和原生混音器音效，验证重采样、暂停/恢复、导出 AAC 音轨、两路测试频率以及音画时长；还检查静音间隔、音量和时间轴。产物在 `build/desktop-artifacts/`。首次下载测试验证续传、损坏拒绝和 HTTPS 降级拒绝。

这是系统 UI 与 APP 行为模拟器，不是 ESP32 CPU/内核模拟器。电脑 FPS、内存和下载速度不能代表实机；Wi-Fi、IMU、相机及引脚时序也不属于硬件仿真。Wi-Fi 页展示虚拟状态，真实请求使用电脑网络；音频输出设备和系统字体之外的自带位图、解码结果也可能存在平台差异。安装事务使用桌面文件系统，本地导入的进度和结果使用 Qt 窗口，商城内发起的安装阶段仍显示在工具栏状态栏，尚未复用实机的完整安装详情页。首次开机下载页则复用实机 UI。

2026-11-14：配套接口固件已分别在 P4/IDF、lckfb/Zephyr 烧录，自检和 OBS 商城目录加载通过，用户确认两块板的画面、文字和触摸正常。


板型配置使用 `--profile osptek-p4`（鱼鹰光电 P4C5，ST7102，480×480）与 `--profile lckfb-s3`（立创 ESP32-S3 实战派，240×320）。旧 `p4`、`lckfb` 参数仍是这些具体板型的兼容别名，不能用于代表同芯片的新板。
共享 Launcher 的可选电源接口由桌面后端链接；桌面尚未实现的电源/蓝牙能力不对界面宣称支持。
