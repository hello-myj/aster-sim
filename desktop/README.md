# Python 系统模拟器

分支：`feat/desktop-system-simulator`。配套固件分支为 `refactor/platform-adapter-api`，两仓库放在同一个父目录。

此入口使用 PySide6 原生窗口，不启动网页服务器或 WebView。Launcher、卡片动画、手势、下拉设置、Wi-Fi 设置页、启动画面和首次开机进度页直接编译固件 C/LVGL 源码，通过 `aster_device`、`aster_os`、`aster_services` 端口接入桌面。APP 继续由已有 Node/WASM 运行时执行，独立进程异常或超时后可返回桌面。APP 文本读取虚拟 SD 卡上的 CPFONT v4，与设备使用相同字形、整数宽度和基线。

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

已在当前工作区准备好依赖和构建产物，可直接双击 `aster-desktop.cmd`。FFmpeg 用于录屏：优先采用 Windows PATH 中的版本，否则使用 WSL FFmpeg。Node.js 构建时复制到忽略目录 `.tools/desktop/`；也可以用环境变量 `ASTER_SIM_NODE` 指定路径。

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
