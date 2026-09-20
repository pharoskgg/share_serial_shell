# 协作终端 MCP

一个 VS Code 桌面插件，让你和 AI 操作**同一个 SSH、串口或本地 Shell 会话**。终端位于 VS Code 底部，可直接输入、选择、复制，AI 使用 MCP 接口发送输入和读取输出。

**人工输入不会暂停 AI，也不会拒绝 AI 的后续写入。** 插件不实现 agent 中断、接管锁或命令审批；需要停止 agent 时，在 agent 自身界面操作。双方的输入按到达顺序进入同一会话，因此应避免同时编辑同一行命令。

## 安装与开始

1. 在 VS Code 扩展页面右上角 `…` 选择 **从 VSIX 安装**，选择 `shared-terminal-mcp-<平台>-0.4.0.vsix`。更新后重新加载窗口，使界面和后台代码一起更新。
2. 打开一个可信工作区。插件自动启动服务并接入 VS Code、本机 Codex，无需填写 MCP 配置、复制令牌、指定端口或安装 Node。底部出现 **协作终端** 面板。使用 Claude 时，运行 `协作终端: 一键接入 Claude CLI 和桌面应用`，完成后重启已运行的 Claude 客户端。
3. 在面板工具栏或命令面板运行：
   - `协作终端: 打开本地终端`
   - `协作终端: 连接 SSH`（首次使用会引导添加配置）
   - `协作终端: 打开串口`
4. SSH / Shell 在原生 **终端** 标签中直接输入；串口在 **协作终端 → 串口监视器** 中选择设备、配置和收发。**全部会话** 视图用于管理已有连接。
5. 运行 `协作终端: 查看 AI 输入记录`，在底部 **输出 → 协作终端 · AI 输入记录** 查看 AI 发送的内容。

输入记录采用 JSON 转义，例如 `"ls\r"` 表示输入 `ls` 并回车，`"\u0003"` 表示 Ctrl+C；同时记录 base64，便于核对二进制数据。记录的是发送尝试，写入失败会出现在 **协作终端 · 服务** 中。AI 发送的敏感内容也会出现在记录中。

## 连接 MCP 客户端

**0.3.0 启动即接入：** 插件激活时自动向 VS Code 注册服务，并在本机 Codex 配置中注册 `shared_terminal`。直接告诉 Agent“查看协作终端里的 SSH 设备”即可。状态栏显示 **等待 AI**；收到客户端的工具发现或调用请求后显示 **AI 已访问**，悬停可查看最近访问时间。它表示实际收到过请求，不表示 Agent 一直在线。

首次安装前已运行的 Codex 客户端可能需要重启，才能加载新增的工具。当前 Codex VS Code 扩展没有对其他插件公开刷新现有对话工具的命令，本插件不会强制重载窗口、断开终端或声称已经注入当前对话。之后桥接器可先于 VS Code 启动，窗口启动、端口变化后均自动发现，无需再配置。

接入异常时，点击状态栏或运行 **协作终端: 一键修复 AI 接入**，自动重做注册。无需编辑文件。已有 Codex 配置和其他 MCP 服务会保留；配置格式错误或存在用户自建的同名服务时，不会覆盖原文件，错误记录在 **协作终端 · 服务**。

Claude 一键接入会把同一个本地 stdio 桥接器安全合并到 Claude CLI 的用户级 `~/.claude.json`，并在 macOS / Windows 合并到 Claude Desktop 的 `claude_desktop_config.json`。它保留其他设置和 MCP 服务；若已有非本插件管理的同名 `shared_terminal`，会拒绝覆盖。Claude Desktop 官方仅支持 macOS 和 Windows，Linux 只配置 Claude CLI。Claude CLI 与 Desktop Chat 的配置彼此独立，因此命令会同时处理两处；已运行的客户端需要完全重启后加载新工具。

自动接入范围是同一扩展宿主用户、同一 Codex 主机上的客户端，以及采用 VS Code MCP 服务发现的 Agent。处于其他宿主（例如另一侧 Windows / WSL 或云端）的独立 Agent 有自己的配置和进程环境，不会被当前宿主插件自动注册。其他厂商的独立 Agent 需要对应的集成，不能仅靠启动一个 MCP 服务就自动注册到所有客户端。

实现说明：注册遵循 `CODEX_HOME`，未设置时使用 `~/.codex/config.toml`。只维护带注释标记的 `mcp_servers.shared_terminal` 区块。稳定的 stdio 启动入口位于插件全局存储中，由 VS Code 自带运行时执行；令牌留在窗口发现文件中，不写进 Codex 配置。串口节流期间工具调用最长等待 180 秒。窗口记录每 20 秒更新、90 秒过期，正常关闭时移除。桥接器按会话 UUID 转发，多个窗口无法确定目标时要求 Agent 指定 `windowId`，不会随便选择另一个窗口。写入失败不自动重试。

兼容旧客户端：项目 `.shared-terminal/mcp.json` 也在启动时自动生成并加入 Git 忽略。具有本机文件和命令工具的 AI 可读取它直接连接当前窗口。同一文件夹被多个窗口打开时，该兼容文件以最后写入的窗口为准；Codex 桥接器分别保留各窗口，不受这个限制。

插件运行一个绑定到 `127.0.0.1` 的 **Streamable HTTP MCP 服务**，使用 Bearer token。每个 VS Code 窗口拥有自己的会话和服务端口。VS Code 的 MCP 服务列表会自动发现 **协作终端 MCP**。

其他 MCP 客户端：运行 `协作终端: 查看 MCP 连接配置`，取得当前窗口的真实 URL 和 Authorization 请求头。配置会显示在一个未保存的编辑器中，不会写入项目。客户端需要支持 Streamable HTTP 和自定义请求头；外部客户端的配置文件结构可能不同，填入相同的 URL 和请求头即可。

下面只是结构示例，实际端口和令牌以插件生成的配置为准：

```json
{
  "servers": {
    "shared-terminal": {
      "type": "http",
      "url": "http://127.0.0.1:实际端口/mcp",
      "headers": { "Authorization": "Bearer 实际令牌" }
    }
  }
}
```

默认随机选择空闲端口。需要外部客户端长期使用固定地址时，设置 `sharedTerminal.mcpPort`（例如 `37891`）并重新加载窗口。多个窗口需要不同端口；占用固定端口时会明确报错，不会连接到其他窗口。令牌存于 VS Code SecretStorage，不应提交到 Git。

以下 HTTP 配置仅供其他客户端或开发调试使用，VS Code 和本机 Codex 用户无需操作。

## MCP 工具

0.4.0 将 HTTP 接口从 10 个工具收敛到 4 个；旧版 `open_*`、`show_session`、`close_session`、`list_ssh_profiles`、`list_serial_ports` 合并为 `session`。升级后重新加载插件并刷新 / 重启 Agent 的 MCP 连接。

| 工具 | 用途 |
| --- | --- |
| `list_sessions` | 列出会话 ID、类型、名称和状态 |
| `read_session` | 按游标读取双方输入、输出、状态，默认精简文本 |
| `write_session` | 执行命令或发送 UTF-8 / base64 精确字节；只发送请求内容，不向终端注入注释文本 |
| `session` | `action`: `profiles` / `ports` 枚举；`local` / `ssh` / `serial` 打开；`show` 显示；`close` 关闭 |

Codex 桥接器另有 `list_windows`，并支持可选 `windowId`。`list_sessions` 和 `session({action:"profiles"})` 可汇总多个窗口；部分窗口不可用时返回 `unavailableWindows`。跨窗口不明确时必须指定窗口，不会猜测目标。

```text
session({"action":"ssh","profile":"开发板"})
→ 返回 id
write_session({"sessionId":"返回的 id","data":"uname -a\r"})
read_session({"sessionId":"返回的 id","after":0,"waitMs":1000})
→ 保存 nextCursor，下次作为 after；hasMore 为 true 时继续读取

session({"action":"serial","serial":{"path":"COM3","baudRate":115200}})
write_session({"sessionId":"返回的 id","data":"help\r\n"})
write_session({"sessionId":"返回的 id","data":"AP8NCg==","encoding":"base64"})
read_session({"sessionId":"返回的 id","format":"raw"})
session({"action":"close","sessionId":"返回的 id"})
```

- 每次写入最多 16 KiB；Shell 回车通常用 `\r`。串口发送会等待全部字节发送及节流完成，成功不表示命令已执行完成。超时后先读取结果，禁止盲目重发。
- 当用户说“我共享了终端给你”“共享串口”或“共享 SSH 终端”时，Agent 应先调用 `list_sessions`，复用匹配的共享会话，再用 `write_session` 发送用户要求，最后用 `read_session` 读取结果；没有共享上下文时不强行调用本服务，也不自动新建连接。工具提示已明确写入这一判断；如果 Agent 仍不调用，刷新 MCP 工具列表或重启 Agent 客户端。
- 默认读取最多 50 条事件（上限 100），按约 8 KiB 的事件 JSON 预算分页；连续输出会合并到约 8 KiB，单条超过预算时仍完整返回一条以保证游标前进、不丢数据。省略重复的 base64、时间戳和会话 ID。`format:"raw"` 保留时间戳和原始字节，适合二进制分析；跨分包 UTF-8 会增量解码。
- `waitMs` 最长 30 秒；默认 `settleMs:120`，第一次等到新事件后再收集 120ms 内到达的串口分包。`settleMs` 可按设备调整到 0–1000ms。它只合并突发数据，不判断命令完成。读取不消耗其他客户端的历史，`truncated:true` 表示旧历史已淘汰。每会话最多保留约 30 MiB 文本，最多 64 个会话，重载窗口会关闭连接并清除历史。
- 日常读写不切换标签或键盘焦点；只有用户要求时才调用 `session({action:"show",sessionId:...})`。
- 原生终端只显示设备自身的正常回显，插件不会在终端数据流中插入 `[AI →]` 等注释。AI 输入仍会记录在串口监视器的 AI 行和“协作终端 · AI 输入记录”输出频道；设备不回显时，原生终端不会伪造本地回显。

## SSH

运行 `协作终端: 添加 SSH 配置`，输入主机、端口、用户名，选择密码、私钥或 SSH Agent。连接资料保存在用户设置，密码和私钥口令保存在 SecretStorage。AI 只需要配置名称。

首次连接会在 VS Code 显示主机 SHA256 指纹（十六进制）供确认；之后校验已保存指纹。指纹变更会拒绝连接。此版本使用独立的主机指纹存储，不读取 OpenSSH `known_hosts`；暂未提供更新已保存指纹的管理界面。直接 SSH 连接不解析 `~/.ssh/config`，暂不支持 ProxyJump、端口转发或 SFTP。

## 串口

**0.2.0 使用底部固定面板，取消顶部多步弹窗。** 布局参考 [微软 Serial Monitor](https://learn.microsoft.com/en-us/cpp/embedded/serial-monitor?view=msvc-170) 的连接工具栏、接收区和发送输入栏。

1. 运行 `协作终端: 打开串口`，进入底部 **协作终端 → 串口监视器**。
2. 在 **串口** 下拉框选择设备（显示 COM 口和可用的设备厂商信息）。刷新按钮重新枚举设备；面板可见时也会每 3 秒刷新，保留当前选择。
3. 设置 **波特率**，支持常用预设或直接输入。展开 **高级设置** 配置数据位、校验、停止位和 RTS/CTS。
4. 点击 **连接**。默认 `115200 / 8N1 / 无流控`，连接参数会记住。实际支持的格式由驱动决定。
5. 在底部输入框编辑内容，选择 **文本 UTF-8 / HEX 字节** 与 **CRLF / CR / LF / 无换行**，按 Enter 或点击 **发送**。选择 HEX 时行尾自动切为无换行，避免额外字节。

未检测到设备时，面板明确显示提示。请连接设备并检查驱动，或在串口下拉框选择 **手动输入设备路径…**，输入 `COM3`、`/dev/ttyUSB0` 等路径。修改界面不能使系统未识别的设备自动出现。

收发区以 **RX** 标记设备接收、**TX** 标记人工发送、**AI** 标记 AI 发送。支持文本 / HEX 显示、时间戳、自动滚动、清空显示、导出记录，以及多个串口会话之间切换。没有设备回显时仍能看到发送记录。界面最多显示 1000 条记录；清空显示不删除 MCP 的会话历史，点击 **导出** 可保存当前会话保留的完整文本记录。

点击 **终端 ↗** 可切换到原生终端逐键输入；该终端与监视器、MCP 共用同一条连接。原生串口终端显示 AI 输入记录；人工逐键输入仍依赖设备回显，不提供行编辑。点击 **断开** 会释放串口，对双方同时生效。人工和 AI 共用同一发送队列，不提供人工接管锁。

发送节奏统一在串口后端控制：每组最多 **4 个字节**，等待驱动 `drain` 后再等 **6ms**，下一组才开始；最后一组同样等待，所以跨调用也不会突发发送。按字节计数，不按字符计数。监视器、原生终端和 Agent 都使用这条队列。队列含正在发送的数据最多 16 KiB，满时明确拒绝新输入。关闭 / 拔出 / 发送失败停止后续队列，不自动重发部分命令。低波特率和操作系统调度会让实际发送更慢，6ms 不是硬实时保证。

## 开发与验证

```powershell
npm ci
npm test
npx playwright install chromium
npm run test:ui
npm run package
```

按 F5 启动独立的 Extension Development Host。源码为 TypeScript，入口 `src/extension.ts`，会话核心 `src/session.ts`，连接后端 `src/backends.ts`，MCP 服务 `src/mcp.ts`。

在 Windows 上执行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-vscode.ps1` 可使用已安装的 VS Code 运行独立宿主联调（先运行 `npm run compile`）。测试使用 `.test-results` 下的独立用户配置，完成后自动退出。

`npm test` 包含真实本地 PTY、回环 SSH 服务、官方 MCP SDK HTTP 客户端、串口原生模块加载以及 SerialPortMock 二进制收发测试。`src/integration/run.ts` 另提供真实 VS Code Extension Host 联调入口。模拟串口测试不替代实际硬件验证。

`npm run test:ui` 默认使用 Playwright Chromium 无头模式（可用环境变量 `PLAYWRIGHT_CHANNEL=chrome` 或 `msedge` 选择已安装浏览器）检查真实面板 HTML/CSS/JS，使用模拟设备消息，不连接硬件；界面截图保存到 `.test-results`。

支持 macOS、Windows、Linux，以及以 Linux 扩展宿主运行的 WSL；要求桌面 VS Code 1.102+，不支持 VS Code Web。原生模块需要按目标系统 / CPU 架构安装依赖并打包，不能把 macOS 的 VSIX 当作 Linux 包安装。CI 为 macOS arm64、Windows x64、Linux x64 分别构建并测试，其他架构需在对应机器构建：

```text
npm ci
npm test
npm run package -- --target darwin-arm64
# 其他示例：darwin-x64 / win32-x64 / win32-arm64 / linux-x64 / linux-arm64
```

扩展优先运行在工作区宿主（`extensionKind: ["workspace", "ui"]`）。在 Remote WSL 中将插件安装到 WSL，使用 Linux 构建、Linux Shell、WSL 内的 Agent 配置和设备路径；USB 串口须先透传给 WSL，Windows 的 COM 口不会自动变成 `/dev/ttyUSB0`。若希望在 WSL 窗口共享 Windows COM 口，则在本地安装 Windows 版本并配置 `"remote.extensionKind": {"local-tools.shared-terminal-mcp": ["ui"]}`，这时 Shell、串口和自动注册都属于 Windows 主机。两种模式不会自动桥接 Windows 与 WSL 中彼此独立的 Agent。

Remote SSH 同理：默认操作远程主机的 Shell、串口和 Agent；可显式设为 UI 宿主以操作桌面机器。这一宿主选择遵循 [VS Code 远程扩展机制](https://code.visualstudio.com/api/advanced-topics/remote-extensions)。macOS 默认使用登录 Shell（回退 zsh），Linux / WSL 回退 `/bin/sh`，Windows 默认 PowerShell；可在 `sharedTerminal.shell` 中指定程序路径。Linux 串口权限由系统管理，账号需有设备访问权限。

安装及打包时会修复 node-pty POSIX `spawn-helper` 的可执行位，避免 macOS 出现 `posix_spawnp failed`。本次本机验证范围见 `VALIDATION.md`，CI 配置不代表已在所有平台实测。

## 实现参考

- [VS Code MCP 扩展 API](https://code.visualstudio.com/api/extension-guides/ai/mcp)
- [VS Code Pseudoterminal API](https://code.visualstudio.com/api/references/vscode-api#Pseudoterminal)
- [MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/server)
- [SerialPort 安装与原生模块](https://serialport.io/docs/guide-installation/)
- [ssh2](https://github.com/mscdex/ssh2) / [node-pty](https://github.com/microsoft/node-pty)
