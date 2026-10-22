# aster-sim

在电脑上运行 Aster 应用包。当前 ABI 为 4.1.0。模拟器执行 WASM，忽略包里的 Xtensa AOT，并拒绝主版本不是 4 的包。

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

## 双触点输入（feature/multitouch）

触屏浏览器支持两个 Pointer ID，映射为稳定 slot 0/1；鼠标仍是单指输入。丢失捕获、取消或窗口失焦会释放对应触点，暂停/恢复和停止会清空触点。事件保留 `u.touch.slot`；轮询每点12字节（x/y/action），不包含slot。

确定性回放的touch事件可增加 `"slot": 1`，省略时保持slot0；同一frame可按数组顺序记录两个触点。示例为 SDK `apps/neon-duel/tests/two-touch.replay.json`。键盘组合不能替代双指验证；实体屏能力须分别在两款开发板验收。多指保持 ABI 4.0 事件布局。当前连续音效版本为 ABI 4.1；快照绑定 SDK 公开契约提交，随 `sdk-v4.1.0` 正式开发包提供；最终打包元数据提交见 SDK 的 release.json。

连续音效实现循环、音高/音量平滑、独立停止、暂停和晚连接浏览器状态回放。浏览器重新连接会从循环引入段重启，不保证与后台相位对齐。Windows 使用独立进程承载 APP 和原生画布，避免异常退出时线程隔离环境的访问异常，并保留 Trap 报告及看门狗强制终止能力。完整限制见 [音频说明](docs/continuous-audio.md)。
