# 回放

用固定时钟、种子和输入运行一个包，并写出诊断。当前 ABI 为 4.0.0。回放执行 WASM，不连接真实网络。

```bash
node src/cli.js <应用>.ast --replay scenario.json --diagnostics report.json --screenshot final.png
```

不能同时使用 `--state` 或 `--apps`。`--frames` 可以提前停止，不能超过场景长度。

```json
{
  "version": 1,
  "frames": 120,
  "step_ms": 34,
  "seed": 2048,
  "epoch_ms": 1767225600000,
  "faults": {
    "storage_bytes": 4096,
    "allocation_fail_at": 20,
    "missing_features": ["wifi"]
  },
  "events": [
    {"frame": 2, "type": "touch", "x": 70, "y": 180, "action": 1},
    {"frame": 8, "type": "pause", "paused": true}
  ]
}
```

事件类型：`touch`（action 1/2/3）、`key`、`sensor`、`pause`、`sensor-noise`。

`storage_bytes` 限制内存存储。`allocation_fail_at` 让第 N 次宿主分配失败。`missing_features` 去掉对应能力位。

诊断 JSON 包含应用 ID、Trap、内存、句柄和帧回调耗时。同一 Node、同一模拟器和同一场景下，状态哈希应一致。耗时字段会变化。
