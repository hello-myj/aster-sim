# Aster 桌面模拟器 1.1.0

配套 SDK 4.5.0。桌面主机使用 ABI 4.5 加载 AST 中的 WASM，并按板型和必需能力检查应用。系统媒体播放器和经典蓝牙音频需要在支持的开发板上调试。

Windows x64 下载并完整解压 ZIP，运行 `aster-sim.exe`。也可在 SDK 中执行 `aster sim --profile osptek-p4 --app my-app`，打开已编译的工程；立创实战派使用 `--profile lckfb-s3`。独立资源目录可通过 `--resources` 指定。工具栏可导出 PNG 或带内部音频的 MP4。
