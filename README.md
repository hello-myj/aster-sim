# aster-sim

桌面系统模拟器通过 Python / PySide6 显示固件的 Launcher、下拉设置和首次开机界面，应用由独立进程执行 WASM。它可以安装应用及独立资源、保存虚拟 SD 卡、导出截图和带声音的 MP4。

## 启动系统

使用已发布的 Windows x64 SDK 时，`aster sim --profile osptek-p4 --app 项目目录` 会下载配套模拟器并打开已构建的项目。公开的 `sim-v1.0.0` 使用 ABI 4.3。要运行源码版，先按 [桌面构建说明](desktop/README.md) 准备原生核心和依赖，再从仓库运行：

```powershell
.\aster-desktop.cmd --profile osptek-p4
.\aster-desktop.cmd --profile lckfb-s3 --app 路径/应用.ast --resources 路径/resources
```

桌面提供鱼鹰光电 P4C5（480×480）、立创实战派（240×320）和自定义尺寸。源码的 APP 契约是 ABI 4.5。板型与必需能力在启动时检查。系统播放器后端和经典蓝牙链路需在实机验证；更改模拟分辨率只会改变布局。

## 单独运行 APP

命令行主机需要 Node.js 22 及依赖。以下示例只执行包中的 WASM，并把第 120 帧写入 PNG，适合自动化验证：

```sh
npm ci
node src/cli.js app.ast --resolution 480x480 --headless --frames 120 --screenshot result.png
```

`--state` 指定持久化存储；`--wifi` 提供虚拟 Wi-Fi 状态，`--network` 允许使用主机网络。[输入回放与诊断](docs/replay.md)

## 检查

```bash
npm test
npm run check-sdk -- <SDK目录>
```

可选集成测试把包路径放进环境变量后再执行 `npm test`：

- `ASTER_SIM_2048_AST`
- `ASTER_SIM_IMUCUBE_AST`
- `ASTER_SIM_BREAKOUT_AST`
- `ASTER_SIM_SCENE_SETTINGS_AST`
- `ASTER_SIM_SCENE_SPRITES_AST`

`ASTER_SIM_REQUIRE_PACKAGES=1` 时，缺包会失败。

## 再到设备

```text
aster build <应用目录> --target xtensa --aot
aster deploy <应用>.ast --target xtensa --port <串口> --run
```

回放和诊断见 [docs/replay.md](docs/replay.md)。`--help` 列出全部参数。

## 输入与音频

确定性回放的 touch 事件可指定 `slot`，省略时使用 slot 0。桌面配置决定可用触点数量。系统提示音、APP 音效和背景音乐可随屏幕录制。连续音效、暂停和恢复的实现边界见 [音频说明](docs/continuous-audio.md)。
