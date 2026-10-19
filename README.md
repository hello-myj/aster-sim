# aster-sim

在电脑上运行 Aster 应用包。当前 ABI 为 4.0.0。模拟器执行 WASM，忽略包里的 Xtensa AOT，并拒绝主版本不是 4 的包。

需要 Node.js 22。

```bash
npm ci
node src/cli.js <应用>.ast --resolution 240x320
```

`--resolution` 是屏幕像素，`--scale` 只改变窗口倍数。立创竖屏用 `240x320`，微雪竖屏用 `320x480`。应用声明横屏时会交换宽高。

```bash
node src/cli.js <应用>.ast --headless --frames 120 --screenshot result.png
node src/cli.js <应用>.ast --wifi --network
node src/cli.js <应用目录>
node src/cli.js app.wasm --manifest manifest.json
```

`--network` 打开真实 IPv4，包括 TCP、UDP、HTTP、MQTT 和 WebSocket。`--wifi` 只模拟无线状态。关闭窗口不会停止进程，用界面上的结束或 Ctrl+C。

`--state <目录>` 把 `/data`、`/cache` 和 KV 写到磁盘。不传这个参数时，数据只留在本次进程里。

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
