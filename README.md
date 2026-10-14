# aster-sim

Windows 上专门运行 Aster APP 的模拟器，名称 **aster-sim**（Aster Simulator）。
ABI 3.7.0；默认且目前仅执行 WASM。`.ast` 中的 Xtensa AOT 可以保留，但始终忽略；纯 `.aot` 不接受。
APP 可直接使用 SDK 编译产物，不需要移植成桌面应用。独立文件夹实现，没有修改 SDK 固定契约。
工程独立放置于 SDK 外，默认与 `aster-sdk` 同级。运行模拟器及自动测试无需 SDK；只有编译 APP / AOT 和设备部署需要 SDK 工具。

## 启动

开发环境需要 Windows x64、Node.js 22+ 和 Edge（没有 Edge 时手动用浏览器打开输出地址）。

```powershell
cd E:\个人项目资料\aster\aster-sim
npm ci
.\aster-sim.cmd ..\aster-sdk\dist\xtensa\your.app.ast --resolution 240x320
.\aster-sim.cmd ..\aster-sdk\dist\xtensa\your.app.ast --width 480 --height 800 --scale 1
```

`--resolution` 是屏幕像素；`--scale` 只改变窗口显示倍数。manifest 声明横屏/竖屏时会相应交换宽高。
分辨率选择窗口（玻璃）。没有请求 scale-fit 表面时，窗口像素就是应用绘图坐标。请求了 scale-fit 并给出自己的缓冲尺寸时，模拟器用与固件相同的 keep 公式把缓冲居中铺进窗口，左右或上下留黑边，触摸按该比例映回缓冲。WASM 内存上限来自包里声明的最大值，不按开发板预设。
关闭浏览器不会停止模拟器；使用界面“结束”或终端 Ctrl+C。暂停/恢复及重载遵循 APP 生命周期。

```powershell
# 无窗口自动验证，并保存最终画面
.\aster-sim.cmd your.app.ast --resolution 240x320 --headless --frames 120 --screenshot result.png
# 指定外设测试数据
.\aster-sim.cmd your.app.ast --wifi --camera photo.jpg --pcm-input stereo-s16le.pcm
# 加载 build 目录中的 app.wasm / manifest.json，或直接指定 wasm
.\aster-sim.cmd ..\aster-sdk\build\xtensa\your.app
.\aster-sim.cmd app.wasm --manifest manifest.json
```

裸 WASM 没有 manifest 时使用 `local.wasm` ID、空权限；资源请使用 `.ast` 打包加载。
`--pubkey public.pem` 校验签名包；没有公钥时拒绝带签名的 `.ast`。
`--help` 显示完整参数。无窗口模式默认 120 帧；WASM 卡住超过 `--watchdog` 秒会终止工作线程。
APP 日志和错误写入终端；初始化/执行失败使进程返回非零状态。

## Windows 便携版

```powershell
npm ci
npm run portable
.\out\aster-sim\aster-sim.exe your.app.ast --resolution 240x320
```

打包使用 Windows 自带 .NET Framework C# 编译器，生成 `out/aster-sim/aster-sim.exe`，并附带当前 Node 运行时和 Windows 绘图库。
分发整个 `out/aster-sim` 文件夹即可，用户不需要安装 Node/Python/Visual Studio；EXE 是控制台启动器，图形窗口使用 Edge app 模式。
源码使用 [@napi-rs/canvas](https://github.com/Brooooooklyn/canvas) 提供 Skia 绘图；发布文件夹保留其依赖许可证。Node 运行时再分发遵循 [Node.js 许可证](https://github.com/nodejs/node/blob/main/LICENSE)。

## 接口支持与差异

当前 SDK 公开的 **72 个 `aster_*` 导入均已注册**；这是名称覆盖，不代表硬件完全等价。未知导入在加载时报错，不伪造成功。

- 生命周期、FRAME/TOUCH/KEY/TIMER 事件、FPS、单点触摸轮询、键盘状态、定时器与退出：实现。
- display、RGB565 surface、panel canvas、acquire/present/flush、所有公开 gfx 命令、图片 probe/render、BMP/PNG/JPEG 精灵：实现。同步解码，源图限制 4096×4096 / 16 MiB。
- 中文文字使用 Windows 字体，字号吸附到契约发布的 12/14/16/18/20/24/28/32/40/48px 原生档位，基线遵循 ABI；背景框的行高、上升距离与 SDK 度量一致；字宽、抗锯齿与设备 SD 字形可能不同。字体同步可用，fonts_pending 返回 0。
- 文件/目录及 KV：实现，按 APP ID 隔离并检查权限、路径和 symlink；`/assets` 内存只读，`/data`、`/cache` 可写，`/music` 只读，`/sd` 另需 sd 权限。
- RTC：主机本地时钟；加速度/陀螺仪：可在界面设置的虚拟值，单位 m/s² 与 rad/s。ABI 3.7 的 `aster_imu_get_info` / `aster_imu_read` 提供同步六轴快照、单调时间戳和 u32 序号；10 ms 内重复读取复用同一快照，序号可回绕。旧 accel/gyro 接口继续可用。
- 相机：`--camera` 静态图片转 RGB565，保持比例缩小到 320×240；未指定时返回 ENODEV。
- 录音：`--pcm-input` 固定 44100 Hz 双声道 S16LE 文件输入，未指定时 ENODEV；不是物理麦克风采集。
- 音频输出：浏览器解码 WAV/MP3，支持背景播放、暂停、恢复、seek、音量、最多四个音效并混音。界面需点击“启用声音”解除浏览器播放限制。音效支持 8–192 kHz 双声道 S16LE WAV，由浏览器重采样至输出设备，缓存后即时混音；同一音效重放会重新开始。浏览器反馈 MP3 解码时长和自然播放结束状态，APP 可据此循环播放；录音与播放时序不模拟设备阻塞；lyrics 当前返回空。
- Wi-Fi：默认关闭；`--wifi` 开启固定扫描项和 station 状态模拟，仍检查 wifi 权限。返回测试地址 192.0.2.2，不操作 Windows Wi-Fi，不提供网络通信。
- appmgr：`--apps DIR` 加载额外包，支持查询、单 APP 切换；uninstall 只从本次模拟目录移除记录，不删除源 `.ast`，重启可重新加载。拒绝卸载当前 APP。
- 蓝牙、PSRAM 不声明可用；手册没有公开的 socket/HTTP/蓝牙通信接口，模拟器不添加这些 ABI。
- 常用 SDK libc imports 实现；C++ 异常等不受支持的 imports 明确拒绝。

虚拟设备存储默认全部放在内存中（包括 `/data`、`/cache`、KV、`/sd` 和 `/music`），不创建 `state` 目录，也不自动保存APP数据。重新加载或切换APP时保留当前模拟器会话的数据，退出模拟器后全部释放。APP包中的 `/assets` 直接读取，不解包到磁盘。

需要跨启动保存数据时，显式指定 `--state DIR`，此时才使用磁盘目录 `DIR/<app-id>/{data,cache,kv}` 和 `DIR/shared/{music,sd}`。截图仅在点击保存截图或指定 `--screenshot` 时写出。APP包直接从指定的外部路径读取，不复制到模拟器目录。
GUI 服务仅绑定 127.0.0.1，输入通道检查随机 token 和 Origin。WASM 在单独工作线程执行，防止无限循环冻结界面。
这是本地开发工具，不是运行不可信 APP 的安全边界。请仅运行自己的或可信的包。

## 构建与验证

代码库和便携版均不附带APP源码、APP包、运行存档或测试截图。构建脚本会清理便携输出中不属于模拟器的旧项目；不要将自己的文件存入输出目录。

```powershell
npm test
npm run portable
# 可选：直接引用外部SDK包进行2048集成测试，不复制包
$env:ASTER_SIM_2048_AST = 'E:\path\to\aster.game.2048.ast'
npm test
# 可选：ABI 3.7 IMU立方体集成测试，包仍放在SDK中
$env:ASTER_SIM_IMUCUBE_AST = 'E:\path\to\aster.imucube.ast'
# 可选：原生画布、触摸与暂停，覆盖 240×320、320×480、480×800
$env:ASTER_SIM_BREAKOUT_AST = 'E:\path\to\com.example.breakout.ast'
npm test
```
## 模拟通过 → AOT → 设备

模拟器不转换 AOT。保留同一份 APP 工程，完成模拟测试后使用 SDK：

```powershell
aster build PATH\your-app --aot
aster verify PATH\your.app.ast --target xtensa
aster deploy PATH\your.app.ast --target xtensa --port COM24 --run
```

端口替换为设备实际端口。新版固件通过同一串口提供日志、shell 和文件传输；执行前关闭独立串口监视器。旧双串口固件仍可显式指定 `--port COM22 --console COM24`。这是 APP 安装部署；不是整机固件烧录。设备 CPU、内存峰值、字体、外设及 AOT 执行还需真机验证。

## 运行 SDK 2048 例程

已实际验证 SDK `apps/game.2048` 的非 AOT 包能运行，鼠标滑动、合并计分和音频启用正常。模拟器接受 `ASTER_PIXEL_NATIVE`，在本机解析为 RGB565。
在模拟器目录执行：

```powershell
.\out\aster-sim\aster-sim.exe ..\aster-sdk\dist\xtensa\aster.game.2048.ast --resolution 240x320
```

包不存在时先使用与当前源码匹配的 SDK 编译：`aster build PATH\aster-sdk\apps\game.2048 --no-aot`，然后把实际输出的 `.ast` 路径传给模拟器。无需修改 2048 源码，也不要直接运行 C 源码或纯 `.aot`。点击“启用声音”可解除浏览器的自动播放限制。

## 跟随 SDK 更新（2026-10-12）

模拟器 0.2.0 已对照同级 SDK 的 ABI 3.7.0 契约。运行无需 SDK；`src/sdk-compat.json` 保存审核过的公开契约指纹。窗口大小只由分辨率决定，不读取包的 `target_id`，也没有 `--board` / `--target`。`--version` 报告模拟器版本、支持的 ABI、对照时的 SDK 提交和 API SHA256。SDK 工具发布版本与模拟器版本独立，提交不同不代表 APP 接口不兼容。

```powershell
# 在模拟器源码目录检查最新 SDK（默认同级 aster-sdk，也可传任意完整 SDK 路径）
npm run check-sdk
npm run check-sdk -- E:\path\to\aster-sdk
.\out\aster-sim\aster-sim.exe --version
# 使用 SDK 开发板原始显示尺寸；应用横竖屏声明仍然生效
.\out\aster-sim\aster-sim.exe APP.ast --resolution 240x320
.\out\aster-sim\aster-sim.exe APP.ast --resolution 320x480
```

默认窗口为 240×320；`--resolution 240x320` 与 `--resolution 320x480` 分别用于验证立创和微雪的竖屏布局。APP 可根据查询到的尺寸创建原生画布并选择实际字号。SDK 的 CPU 目标不包含屏幕尺寸；模拟器不提供开发板预设或板级内存上限。

SDK 更新后先运行 `check-sdk`。它检查真实契约文件与 lock 校验值、公开头文件/API 指纹、72 个 APP 导入处理函数、原生字号度量与 CPU 平台配置。即使 ABI 版本号相同，公开结构或签名改变也会报告失败；需要先审查并适配实现，再更新快照，不能只修改支持版本字符串。此检查覆盖接口一致性，不证明硬件行为完全等价。

模拟器执行包中的 WASM，忽略 Xtensa AOT。SDK 共享串口、主机便携打包和多开发板工具链更新不改变 APP ABI，因此不需要为这些主机更新增加模拟器导入。最新版 APP 应先用当前 SDK 编译，再在 Windows 上执行 `npm test` 及外部 APP 集成测试，最后 `npm run portable` 刷新整个 `out/aster-sim`。发布时仍分发整个模拟器目录。

修正了大屏面板画布的内存预算：完整 panel canvas 使用平台画布，不扣 APP 堆配额；非完整面板的请求退回普通 surface 并按 APP 堆预算检查。这样 IMU 立方体在 320×480 下不会因误扣一帧 307200 字节而返回 ENOMEM。

本次验证：Linux Node 20 与 Windows 原生 Node 24 下均完成 37 项测试，全部通过，包含外部 SDK 2048、IMU 及打砖块包。打砖块集成测试覆盖 240×320、320×480、480×800 原生画布、拖动球拍、发球与暂停；Windows 下两种开发板尺寸的截图已核查；新版便携 EXE 在 480×800 下运行打砖块 60 帧正常退出。霓虹对决使用新 xtensa 路径构建，Windows 本地磁盘运行 60 帧正常。未以此代替真机外设或 GUI 手动测试。

本次更新保持 WASM 执行策略：设备包中的 Xtensa AOT 仍被忽略，纯 WASM 包也可运行。固件的 SD 字形缓存和 PSRAM 生命周期属于硬件实现，模拟器使用主机字体服务，不把主机缓存占用当作设备 PSRAM 测量结果。

## 候选发布集成

完整发布由固件 `tools/release_check.py` 读取 `contract/release-matrix.json`，固定 SDK/模拟器提交和工具链，再构建 2048、IMU 与打砖块必需包并运行全部测试。缺包即失败；`ASTER_SIM_REQUIRE_PACKAGES=1` 也令模拟器测试拒绝缺失输入。普通 `npm test` 没有外部包时的 skip 仅用于单元测试，不能当作发布通过。入口与验收范围见 [发布验证](https://github.com/hello-myj/aster-firmware/blob/main/docs/release-validation.md)。

## 回放与诊断

`node src/cli.js APP.ast --replay scenario.json --diagnostics report.json --screenshot final.png` 使用固定时钟、种子和输入；支持无空间、分配失败及缺少能力场景。网页同时显示 APP、Trap、内存、句柄、ABI 调用数和帧处理耗时。格式、可复现条件及与真机的边界见 [回放与故障诊断](docs/replay.md)。


## G7 Scene 辅助层

当前工作区支持帧事务的可选 CLIP 和 FONT_EPOCH 能力，沿用 ABI 3.7 imports。Scene、布局、按钮和滚动状态由 SDK 的 APP C 库管理；模拟器只实现事务裁剪。模拟器字体常驻，epoch 默认0；异步字体完成的回归由固件/SDK测试覆盖。旧普通 surface 的零尺寸请求现在按契约采用实际 APP 空间，与固件一致。

构建 SDK 的 `apps/scene-settings`、`apps/scene-sprites` 后，可在 PowerShell 执行真实 WASM 集成测试（240×320 和 320×480）：

```powershell
$env:ASTER_SIM_SCENE_SETTINGS_AST = 'E:\path\to\aster.scene.settings.ast'
$env:ASTER_SIM_SCENE_SPRITES_AST = 'E:\path\to\aster.scene.sprites.ast'
$env:ASTER_SIM_REQUIRE_SCENE_PACKAGES = '1'
npm test
```

此标志保证缺包时报错，不能把跳过当通过。检查静态页零重复发布、按钮点击/滚动防误触、多精灵超过240次更新的重建、暂停恢复。具体 APP API 见配套 SDK 手册第13节。本轮代码尚未发布；`src/sdk-compat.json` 已固定到包含 G7 的 SDK 提交，CI 构建两个 Scene 示例并强制执行相关集成测试，不能仅依据相同 ABI 号宣称配套。远端固定版本 CI 需在相关提交推送后执行。
