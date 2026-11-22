# Aster Desktop Simulator 1.0.0

`sim-v1.0.0` 发行包对应 ABI 4.3，供配套 SDK 下载。源码主分支的 ABI 及构建步骤见[桌面说明](../desktop/README.md)。

Windows x64 原生桌面包，解压运行 aster-sim.exe。包含系统 Launcher、下拉设置、首次开机、APP 安装进度、P4/lckfb 配置和自定义分辨率。支持 PNG 截图、含音轨的 MP4 录屏，以及 --app/--resources 快速调试。

运行包内 WASM，实机继续使用各自 CPU 的 AOT。
