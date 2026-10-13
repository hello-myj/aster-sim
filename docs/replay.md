# 确定性回放、故障注入与诊断

当前 APP ABI 仍为 3.7。回放按 WASM 执行，忽略包里的 Xtensa AOT；它不代替 DMA、SPI、I2C、外设或目标设备 AOT 检查。

```bash
node src/cli.js APP.ast --replay scenario.json --diagnostics report.json --screenshot final.png
```

回放自动使用 headless、新的内存文件系统。不能同时传 --state 或 --apps，不接受浏览器/实时输入；进程 watchdog 仍按真实时间工作。Node 22.20.0、同一模拟器代码/依赖、字体、包和场景下，重复运行应产生相同 state（内存/截图/文件哈希）。诊断里的实际处理耗时会变化，不参与确定性判定。跨操作系统、字体/Skia 版本不承诺逐像素相同。

## 场景格式

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
    {"frame": 3, "type": "touch", "x": 180, "y": 180, "action": 2},
    {"frame": 4, "type": "touch", "x": 180, "y": 180, "action": 3},
    {"frame": 8, "type": "pause", "paused": true},
    {"frame": 10, "type": "pause", "paused": false},
    {"frame": 12, "type": "sensor-noise", "amplitude": 0.1}
  ]
}
```

`frames` 是回放步数，暂停也推进步数和虚拟时间，所以暂停场景不会卡在 --frames 限制上。第 k 步时间为 k×step_ms，输入按数组顺序先于该步帧事件交付；同一 frame 可有多项输入。APP 的定时事件按固定时钟触发，设置 framerate 不改变回放步长。--frames 可提前停止，不能超过场景长度。

支持 touch（action 1/2/3）、key（code、pressed）、sensor（accel/gyro 三个有限数）、pause（显式 paused 布尔值）和 sensor-noise。sensor-noise 用指定 u32 seed 的 LCG 生成三轴均匀陀螺仪扰动；种子控制模拟器刺激，不会改写 WASM 内部自己的 PRNG，应用自身若使用外部随机源仍需显式控制。普通 sensor 事件提供明确的六轴数据。

回放中单调时钟从 0 起，日历 API 使用 epoch_ms（默认 2026-01-01 UTC）加虚拟时间并返回 UTC 日历；普通交互模式仍使用主机当前本地时间。音频进度使用同一单调时钟，回放不接受浏览器播放反馈，因此不声称验证音频设备同步。

## 故障范围

- storage_bytes：内存存储的数据字节配额，0 模拟无空间。超额写入返回 ENOSPC/ASTER_ENOSPC，原内容不变；删除但仍打开的文件继续占配额，最后关闭后释放。不包含文件系统元数据，也不模拟真实 FAT 扇区写坏、掉电或部分短写。
- allocation_fail_at：第 N 次 Host 分配尝试返回 0，包括事件缓冲/表面等。只在这一尝试失败；不拦截 WASM 内部独立分配器或其直接 memory.grow。
- missing_features：使用 ABI 能力名称，移除对应位。硬 requires 在初始化之前被拒绝；可选能力查询返回缺失，对应模拟 Host 接口返回 ENODEV。不是模拟物理外设电气异常。

无 faults 时维持原来的行为；这些配置属于模拟器场景，不进入 APP 包或公开 ABI。

## 报告与界面

--diagnostics 可在普通运行和回放中使用。JSON 包含 APP ID/版本/ABI、当前回调、Trap、帧数、Guest 线性内存及峰值、Host 分配字节峰值、句柄分类/峰值、各 ABI 调用数和实际 frame 处理耗时。frameTiming 只计 frame 回调（不含此前的定时/输入回调），包含累计平均/最大和最近最多 512 帧 p95；它不是显示器扫描耗时或真实设备帧间隔。

报告记录 Node/主机平台、依赖 lock、模拟器源文件、输入包和回放文件的 SHA-256，便于确认复现条件。支持的 SDK commit 是兼容快照，不意味着 APP 来自该 SDK 提交；APP 自己的 abiTarget 另列。state 在 teardown 之前取样，之后 worker 退出；报告里的 Guest 字节不是释放后的系统内存基线。

阻塞回调由父进程 watchdog 终止，仍能记录最后 APP/回调与运行时信息；不会伪造最终截图或内存状态。加载失败可能没有 Guest 内存或 APP ID，报告明确保留 load 阶段错误。CLI 参数/场景校验失败输出明确错误并返回非零。

交互网页新增运行诊断栏，持续显示资源与性能摘要、异常信息。字体使用主机字体/Skia，音频、相机、Wi-Fi 为模拟行为；真机字号资源、时序和外设另行验收。
