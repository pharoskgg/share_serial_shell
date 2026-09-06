# 协作终端 MCP

一个 VS Code 桌面插件，让你和 AI 操作**同一个 SSH、串口或本地 Shell 会话**。终端位于 VS Code 底部，可直接输入、选择、复制，AI 使用 MCP 接口发送输入和读取输出。

**人工输入不会暂停 AI，也不会拒绝 AI 的后续写入。** 插件不实现 agent 中断、接管锁或命令审批；需要停止 agent 时，在 agent 自身界面操作。双方的输入按到达顺序进入同一会话，因此应避免同时编辑同一行命令。

## 安装与开始

1. 在 VS Code 扩展页面右上角 `…` 选择 **从 VSIX 安装**，选择 `shared-terminal-mcp-0.3.1.vsix`。更新后重新加载窗口，使界面和后台代码一起更新。
2. 打开一个可信工作区。插件自动启动服务并接入 VS Code、本机 Codex，无需填写 MCP 配置、复制令牌、指定端口或安装 Node。底部出现 **协作终端** 面板。
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

自动接入范围是同一桌面用户、同一 Codex 主机上的客户端，以及采用 VS Code MCP 服务发现的 Agent。运行在 WSL、SSH 远端或云端的独立 Agent 有自己的配置和进程环境，不会被本机插件强行修改。其他厂商的独立 Agent 需要对应的集成，不能仅靠启动一个 MCP 服务就自动注册到所有客户端。

实现说明：注册遵循 `CODEX_HOME`，未设置时使用 `~/.codex/config.toml`。只维护带注释标记的 `mcp_servers.shared_terminal` 区块。稳定的 stdio 启动入口位于插件全局存储中，由 VS Code 自带运行时执行；令牌留在窗口发现文件中，不写进 Codex 配置。窗口记录每 20 秒更新、90 秒过期，正常关闭时移除。桥接器按会话 UUID 转发，多个窗口无法确定目标时要求 Agent 指定 `windowId`，不会随便选择另一个窗口。写入失败不自动重试。

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

| 工具 | 用途 |
| --- | --- |
| `list_sessions` | 列出共享会话及状态 |
| `list_ssh_profiles` | 列出 SSH 配置，不返回密码 |
| `list_serial_ports` | 枚举本机串口 |
| `open_local_terminal` | 创建可见的本地交互式 Shell |
| `open_ssh` | 使用保存的 `profile` 连接 SSH |
| `open_serial` | 使用 `path`、`baudRate` 等参数打开串口 |
| `write_session` | 向会话发送 UTF-8 或 base64 数据 |
| `read_session` | 按游标读取输出、双方输入与连接状态 |
| `show_session` | 用户明确要求时显示会话，可能切换底部标签；读写无需调用 |
| `close_session` | 关闭双方共享的连接 |
| `list_windows` | Codex 桥接器额外提供：列出窗口 ID 和项目路径 |

Codex 桥接器的工具额外接受可选 `windowId`；`list_sessions`、`list_ssh_profiles` 的结果包含窗口归属。所有窗口正常时保持数组结果；部分窗口暂时不可用时，返回 `sessions` / `profiles` 数组与 `unavailableWindows`，明确告知不完整结果。

示例流程：

```text
open_ssh({"profile":"开发板"})
→ 返回 id

write_session({"sessionId":"返回的 id","data":"uname -a\r"})
read_session({"sessionId":"返回的 id","after":0,"waitMs":1000})
→ 保存 nextCursor，下次读取时作为 after

open_serial({"path":"COM3","baudRate":115200})
write_session({"sessionId":"返回的 id","data":"help\r\n"})
write_session({"sessionId":"返回的 id","data":"AP8NCg==","encoding":"base64"})
```

- `write_session` 不自动附加换行：Shell 回车通常用 `\r`，设备要求 CRLF 时用 `\r\n`。每次最多发送 16 KiB。
- AI 读写已有会话不会切换你当前的底部标签或键盘焦点。你可以一直留在原生串口终端；只有明确调用 `show_session` 才会显示会话界面。
- 发送成功只表示输入已交给连接，不代表命令执行完成。使用 `read_session` 判断输出。
- `read_session` 默认最多返回 200 条事件，上限 500；`waitMs` 最长 30 秒。读取不消耗其他客户端的事件。
- 每个会话保留约 1 MiB 的内存历史。`truncated: true` 表示旧数据已淘汰。输出可能含 ANSI 控制码，二进制串口数据以 `base64` 字段为准；UTF-8 文本可能跨事件分片。
- 最多保留 64 个会话，优先淘汰已关闭会话的历史。重载窗口会关闭连接并清除历史。

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

收发区以 **RX** 标记设备接收、**TX** 标记人工发送、**AI** 标记 AI 发送。支持文本 / HEX 显示、时间戳、自动滚动、清空显示，以及多个串口会话之间切换。没有设备回显时仍能看到发送记录。界面最多保留 1000 条记录；清空显示不删除 MCP 的会话历史。

点击 **终端 ↗** 可切换到原生终端逐键输入；该终端与监视器、MCP 共用同一条连接。原生串口终端没有本地回显或行编辑。点击 **断开** 会释放串口，对双方同时生效。没有新增人工接管或 AI 写入锁。

## 开发与验证

```powershell
npm ci
npm test
npm run test:ui
npm run package
```

按 F5 启动独立的 Extension Development Host。源码为 TypeScript，入口 `src/extension.ts`，会话核心 `src/session.ts`，连接后端 `src/backends.ts`，MCP 服务 `src/mcp.ts`。

在 Windows 上执行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-vscode.ps1` 可使用已安装的 VS Code 运行独立宿主联调（先运行 `npm run compile`）。测试使用 `.test-results` 下的独立用户配置，完成后自动退出。

`npm test` 包含真实本地 PTY、回环 SSH 服务、官方 MCP SDK HTTP 客户端、串口原生模块加载以及 SerialPortMock 二进制收发测试。`src/integration/run.ts` 另提供真实 VS Code Extension Host 联调入口。模拟串口测试不替代实际硬件验证。

`npm run test:ui` 使用本机 Microsoft Edge 无头模式检查真实面板 HTML/CSS/JS，使用模拟设备消息，不连接硬件；界面截图保存到 `.test-results`。

主要面向 Windows x64 桌面 VS Code 1.102+。使用 `extensionKind: ui`：在 Remote SSH 窗口中仍连接桌面机器的串口、Shell 和回环 MCP。VS Code Web 不支持。其他平台需要在对应系统重新安装依赖和打包，尤其 Linux 的 node-pty 可能需要本机编译工具链。

## 实现参考

- [VS Code MCP 扩展 API](https://code.visualstudio.com/api/extension-guides/ai/mcp)
- [VS Code Pseudoterminal API](https://code.visualstudio.com/api/references/vscode-api#Pseudoterminal)
- [MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/server)
- [SerialPort 安装与原生模块](https://serialport.io/docs/guide-installation/)
- [ssh2](https://github.com/mscdex/ssh2) / [node-pty](https://github.com/microsoft/node-pty)
