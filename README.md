# aster-sim

Windows 上专门运行 Aster APP 的模拟器，名称 **aster-sim**（Aster Simulator）。
ABI 3.7；默认且目前仅执行 WASM。`.ast` 中的 Xtensa AOT 可以保留，但始终忽略；纯 `.aot` 不接受。
APP 可直接使用 SDK 编译产物，不需要移植成桌面应用。独立文件夹实现，没有修改 SDK 固定契约。
工程独立放置于 SDK 外，默认与 `aster-sdk` 同级。运行模拟器及自动测试无需 SDK；只有编译 APP / AOT 和设备部署需要 SDK 工具。

## 启动

开发环境需要 Windows x64、Node.js 22+ 和 Edge（没有 Edge 时手动用浏览器打开输出地址）。

```powershell
cd E:\个人项目资料\aster\aster-sim
npm ci
.\aster-sim.cmd ..\aster-sdk\dist\lckfb-s3\your.app.ast --resolution 240x320
.\aster-sim.cmd ..\aster-sdk\dist\lckfb-s3\your.app.ast --width 480 --height 800 --scale 1
```

`--resolution` 是屏幕像素；`--scale` 只改变窗口显示倍数。manifest 声明横屏/竖屏时会相应交换宽高。
分辨率可以改变，但 APP 自己的最小尺寸限制、2 MiB WASM 内存和 surface heap 预算仍然生效。
关闭浏览器不会停止模拟器；使用界面“结束”或终端 Ctrl+C。暂停/恢复及重载遵循 APP 生命周期。

```powershell
# 无窗口自动验证，并保存最终画面
.\aster-sim.cmd your.app.ast --resolution 240x320 --headless --frames 120 --screenshot result.png
# 指定外设测试数据
.\aster-sim.cmd your.app.ast --wifi --camera photo.jpg --pcm-input stereo-s16le.pcm
# 加载 build 目录中的 app.wasm / manifest.json，或直接指定 wasm
.\aster-sim.cmd ..\aster-sdk\build\lckfb-s3\your.app
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

当前手册公开的 **72 个 `aster_*` 导入均已注册**；这是名称覆盖，不代表硬件完全等价。未知导入在加载时报错，不伪造成功。

- 生命周期、FRAME/TOUCH/KEY/TIMER 事件、FPS、单点触摸轮询、键盘状态、定时器与退出：实现。
- display、RGB565 surface、panel canvas、acquire/present/flush、所有公开 gfx 命令、图片 probe/render、BMP/PNG/JPEG 精灵：实现。同步解码，源图限制 4096×4096 / 16 MiB。
- 中文文字使用 Windows 字体，字号吸附 16/20，基线遵循 ABI；字宽、抗锯齿与设备烘焙字形可能不同。字体同步可用，fonts_pending 返回 0。
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
npm test
```
## 模拟通过 → AOT → 设备

模拟器不转换 AOT。保留同一份 APP 工程，完成模拟测试后使用 SDK：

```powershell
aster build PATH\your-app --aot
aster verify PATH\your.app.ast --target lckfb-s3
aster deploy PATH\your.app.ast --target lckfb-s3 --port COM22 --console COM24 --run
```

端口替换为设备实际端口。这是 APP 安装部署；不是整机固件烧录。设备 CPU、内存峰值、字体、外设及 AOT 执行还需真机验证。

## 运行 SDK 2048 例程

已实际验证 SDK `apps/game.2048` 的非 AOT 包能运行，鼠标滑动、合并计分和音频启用正常。模拟器接受 `ASTER_PIXEL_NATIVE`，在本机解析为 RGB565。
在模拟器目录执行：

```powershell
.\out\aster-sim\aster-sim.exe ..\aster-sdk\dist\lckfb-s3\aster.game.2048.ast --resolution 240x320
```

包不存在时先使用与当前源码匹配的 SDK 编译：`aster build PATH\aster-sdk\apps\game.2048 --no-aot`，然后把实际输出的 `.ast` 路径传给模拟器。无需修改 2048 源码，也不要直接运行 C 源码或纯 `.aot`。点击“启用声音”可解除浏览器的自动播放限制。