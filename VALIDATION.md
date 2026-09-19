# 0.4.0 本次验证

环境：macOS arm64，Node.js 23。`npm test` 34 项全部通过，包括真实 PTY、回环 SSH、HTTP MCP、stdio 桥接器、SerialPortMock，以及新增的发送节流 / 排队 / 断开取消、非回显终端 AI 输入显示、精简读取分页、串口分包合并、跨分包 UTF-8、平台 Shell 和 WSL 路径测试。

串口面板浏览器测试通过（本机 Chrome）：空设备、手动设备路径、连接参数、AI 输入记录、HEX、断开、XSS 和窄窗口布局。未运行本次 VS Code Extension Host 联调。

已添加 `.github/workflows/ci.yml`：macOS arm64、Windows x64、Linux x64 分别安装、测试、浏览器验证并打包。该 CI 尚未在本次本地工作中执行，不能据此宣称 Windows / Linux / WSL 实机通过。未连接真实嵌入式设备，需在目标设备上确认 4 字节 / 6ms 节奏。

WSL 手动验收：在 Remote WSL 安装 Linux VSIX；确认扩展运行在 WSL，打开本地会话后执行 `uname -a`；确认当前工作目录为远程工作区、WSL 内 Agent 能发现会话；透传 USB 串口后确认 `/dev/ttyUSB*` 或 `/dev/ttyACM*` 可收发；在原生终端内检查 `[AI →]` 记录；发送途中断开，确认后续字节停止。Windows COM 模式应切回 UI 宿主并使用 Windows VSIX。

下方为 0.3.x 历史验证记录，不代表新版本已重新执行这些平台验证。

---

# 验证记录

验证日期：2026-09-06；版本 0.3.0。

## 0.3.1 补充验证

TypeScript 编译通过；`node --test dist/test/mcp.test.js` 两项测试通过。新增回归用真实 MCP HTTP 客户端分别读写串口、SSH 和本地模拟会话，覆盖 UTF-8 / base64、人工继续输入和 AI 输入记录，并断言读写过程中界面显示回调调用次数为零；明确调用 `show_session` 时才触发显示。没有连接用户当前物理串口或切换其界面。

下列完整测试与宿主联调记录来自 0.3.0。

环境：Windows x64、Node.js 20.20.0、VS Code 1.136.1。

## 已通过

`npm test`：21 项测试全部通过。

- Codex 配置注释及其他服务保留、幂等注册、路径转义、并发窗口注册、版本升级入口更新。
- 错误 TOML、用户自建同名服务和损坏的管理区块不会被覆盖。
- 多窗口歧义拒绝、精确会话路由、工作目录匹配，以及端口和令牌改变后的恢复。
- stdio 桥接进程可在 VS Code 尚未启动时提供工具，之后自动发现窗口；窗口退出后列表更新。
- 过期窗口和非本机 HTTP 地址不会被桥接器采用。

- 原生 PTY 启动 PowerShell，并实际执行人工和 AI 两种来源的输入。
- 回环 SSH 服务器认证、主机指纹校验回调、PTY、双方输入及输出。
- 串口原生模块加载与设备枚举。
- SerialPortMock 经实际串口适配层进行二进制收发，保留 0x00、0xFF、CR/LF。
- 官方 MCP SDK 客户端通过真实 HTTP 进行发现、创建、读写、关闭；检查鉴权、Origin 拒绝和错误响应。
- 人工输入不拦截后续 AI 输入。
- 历史游标、独立读取、历史淘汰、长轮询与已关闭会话写入错误。
- 连接过程中关闭会话时释放随后到达的后端。
- 单次写入大小限制与会话数量上限。
- 本机连接配置的 Git 忽略与重启刷新。
- 串口监视器 UTF-8 / HEX 精确字节、行尾和输入限制；界面与 MCP 共用参数验证。
- 已解析视图直接显示、focus 命令缺失回退、注册期间命令消失回退、缺少视图时重新加载恢复。

独立 VS Code Extension Host 联调通过：插件激活、底部面板、原生终端创建、连接配置生成、MCP 连接、`Terminal.sendText` 人工输入路径、AI 输入路径、两种输入的 Shell 实际执行、Electron 环境串口模块、输入记录命令与关闭会话。

串口底部 Webview 在真实 VS Code 内完成 ready 消息握手。面板的 HTML/CSS/JS 另外通过 Edge / Playwright 检查：无设备提示、手动端口、下拉选择、高级参数、刷新后保留选择、文本和 HEX 发送、断开、输出文本转义、清空显示与窄面板布局。已检查空状态、连接状态和窄面板截图，数据为模拟数据。

0.3.0 通过 `scripts/test-vscode.ps1` 和 `scripts/test-installed-vscode.ps1`，后者将实际 VSIX 安装到独立配置。使用独立项目、独立 `CODEX_HOME`，没有覆盖用户正在使用的连接文件。验证无需点击接入命令即可注册 Codex、VS Code 自带 Code.exe 以 Node 模式启动 stdio 桥接器、桥接器访问真实原生终端、中文贡献项、首次打开串口面板及隐藏后重开，均通过。

本机 Codex CLI 0.153.0 实际读取生成的配置，发现启用的 `shared_terminal`。另启动独立 Codex App Server，通过 `mcpServerStatus/list` 确认其加载 `shared-terminal-agent` 0.3.0 及全部 11 个工具；没有调用模型或发起真实远程命令。

Webview HTML/CSS/JS 未在 0.3.0 修改；上文浏览器截图验证沿用 0.2.1 记录。

`npm install` 当次依赖审计报告 0 个漏洞；实际版本已锁定在 `package-lock.json`。

## 未验证

- 实际 USB/UART 硬件、驱动断线重连及特殊波特率。
- 用户远程 SSH 主机、私钥口令及不同 SSH Agent 环境。
- macOS、Linux、Windows ARM64。
- 已运行 Codex 对话的工具热更新：当前扩展没有对其他插件公开刷新命令；首次接入后可能需要重启客户端，不能把写入配置视为已注入当前上下文。
- WSL 内、远端主机或云端的独立 Agent 配置自动注册，以及其他厂商的独立 Agent 集成。
- 串口界面截图为浏览器中渲染相同 Webview 资源的预览，不是对用户 VS Code 窗口的截图。

测试使用独立本机 Shell 与回环 SSH 服务，没有连接用户远程主机，也没有向物理串口发送数据。
