# weflow-workorder-bridge

> WeFlow（本机微信消息源）→ work-order-system（远端工单系统）的 **Windows 托盘消息转发代理**。

本程序与 WeFlow 部署在同一台 Windows、同一用户会话下：通过 WeFlow 的本机 SSE 接收新消息，
文本类直通、媒体类「两步式上传后引用」，再以信封 `{event, data, file}` 调用下游工单系统的
`receiveMessage` 接口；断连用「拉取补偿」兜底，周期「心跳」上报链路健康。
目标是 **不丢消息、媒体可达、可观测、易排错**。

> ⚠️ **当前处于骨架（脚手架）阶段**：基础设施（状态目录、凭据加密、启动流程、托盘 + 主界面）已落地并有单元测试覆盖；
> 真正的业务模块（SSE 接入、转发、媒体上传、心跳、补偿等）目前为占位，详见文末「项目进度」。

完整需求见 [docs/weflow-工单消息转发代理-需求规格说明书.md](docs/weflow-工单消息转发代理-需求规格说明书.md)（SRS v1.3）。

---

## 目录

- [技术栈](#技术栈)
- [目录结构](#目录结构)
- [架构与数据流](#架构与数据流)
- [环境准备](#环境准备)
- [如何开发](#如何开发)
- [如何测试](#如何测试)
- [如何上线（发布与部署）](#如何上线发布与部署)
- [本地状态目录](#本地状态目录)
- [项目进度](#项目进度)
- [相关文档](#相关文档)

---

## 技术栈

| 维度 | 选型 | 说明 |
|------|------|------|
| 语言 / 运行时 | **C# / .NET 8** | 目标框架 `net8.0-windows` |
| 桌面框架 | **WPF** | Windows 原生桌面 UI 框架（XAML 描述界面 + C# 写逻辑） |
| 界面外观 | **WPF UI（lepoco）** `4.3.0` | Fluent / Win11 风格控件（`FluentWindow`、`Card` 等） |
| 系统托盘 | **Hardcodet.NotifyIcon.Wpf** `2.0.1` | 托盘图标 + 右键菜单 |
| 凭据加密 | **Windows DPAPI**（`System.Security.Cryptography.ProtectedData` `10.0.9`） | 密钥绑定「当前用户 + 本机」，换机自动失效（用作换机识别信号） |
| 本地存储 | LiteDB / SQLite（规划） | 断点 / 去重表 / 队列 / 死信 |
| 单元测试 | **xUnit** `2.5.3` | 配 `Microsoft.NET.Test.Sdk`、`coverlet`（覆盖率） |
| 交付形态 | **自包含单文件免安装绿色版** | 首次运行写 `HKCU\…\Run` 自启（仅需当前用户权限） |

> **新手提示**：`net8.0-windows` 是「目标框架（TFM）」——告诉编译器这套代码跑在 .NET 8、且用到 Windows 专有 API（WPF）。
> 三个项目都开启了 `Nullable`（可空检查）和 `ImplicitUsings`（隐式 using，自动帮你 `using` 常用命名空间）。

---

## 目录结构

解决方案 `WeflowAgent.sln` 把代码分成「核心库 / 应用 / 测试」三个项目，职责清晰、便于单独测试核心逻辑：

```text
webflow-workorder-bridge/
├─ WeflowAgent.sln                         # 解决方案文件：把下面三个项目组织在一起（VS 双击即打开全部）
├─ README.md                               # 本文档
├─ .gitignore                              # Git 忽略规则（bin/obj/发布产物，以及绝不可提交的本地状态：secrets.dat/state.db/logs）
│
├─ docs/                                   # 设计文档（开发/测试/验收的依据）
│  ├─ weflow-工单消息转发代理-需求规格说明书.md          # 主需求文档 SRS（v1.3）★最重要
│  ├─ weflow-对接接口规格说明书（work-order-system侧）.md # 下游接口契约
│  └─ http-api.md                          # HTTP API 速查
│
├─ src/                                    # 源代码
│  │
│  ├─ WeflowAgent.Core/                    # 【核心库】纯逻辑、无 UI 依赖 → 可被单元测试直接覆盖
│  │  ├─ WeflowAgent.Core.csproj           #   项目文件：目标框架、依赖（ProtectedData）
│  │  ├─ AppPaths.cs                       #   解析本地状态目录与各文件路径（%LocalAppData%\WeflowAgent）
│  │  ├─ StartupStatus.cs                  #   AgentHealth 健康度枚举(绿/黄/红) + 由凭据状态推导启动态
│  │  ├─ Security/                         #   安全 / 凭据
│  │  │  ├─ DpapiCredentialProtector.cs    #     基于 Windows DPAPI 的加解密（绑定当前用户+本机）
│  │  │  └─ CredentialStore.cs             #     凭据集合 → JSON → DPAPI 加密 → secrets.dat 存取
│  │  └─ Persistence/                      #   持久化 / 迁移
│  │     └─ SchemaMigrator.cs              #     本地存储 schemaVersion 逐级迁移（升级平滑、失败不静默覆盖）
│  │
│  └─ WeflowAgent.App/                     # 【WPF 应用】界面 + 程序入口（引用 Core）
│     ├─ WeflowAgent.App.csproj            #   项目文件：WinExe、UseWPF、依赖 WPF-UI / Hardcodet
│     ├─ App.xaml                          #   应用级定义：主题（深色 Fluent）、全局资源
│     ├─ App.xaml.cs                       #   程序入口：跑启动胶水 → 建托盘 + 主界面（关闭=最小化到托盘）
│     ├─ AgentBootstrapper.cs              #   启动胶水：串起 状态目录→迁移→读凭据→推导绿/黄/红
│     ├─ MainWindow.xaml                   #   主界面布局：状态概览 / 配置 / 日志 / 测试 四区 Tab
│     ├─ MainWindow.xaml.cs                #   主界面逻辑：填充状态、关闭拦截为最小化到托盘
│     ├─ TrayIcon.cs                       #   托盘图标工厂：绿/黄/红状态点 + 右键菜单
│     └─ AssemblyInfo.cs                   #   程序集元信息（WPF 主题定位等）
│
└─ tests/                                  # 测试
   └─ WeflowAgent.Core.Tests/             # 【xUnit 测试】针对 Core 的单元测试（共 13 条，全绿）
      ├─ WeflowAgent.Core.Tests.csproj     #   测试项目文件：xunit、Test.Sdk、coverlet
      ├─ AppPathsTests.cs                  #   路径拼接 / 目录创建 / %LocalAppData% 定位
      ├─ DpapiCredentialProtectorTests.cs  #   加密→解密 往返一致
      ├─ CredentialStoreTests.cs           #   Missing / Loaded / Undecryptable 三种加载状态
      ├─ SchemaMigratorTests.cs            #   迁移按序执行 / 失败停止并抛 SchemaMigrationException
      └─ StartupStatusTests.cs             #   凭据状态 → 托盘绿/黄/红 映射
```

> **为什么分 Core 和 App 两个项目？** WPF 界面代码很难自动化测试，而 `Core` 不引用任何 UI，
> 可以被测试项目直接 `new` 出来逐个验证。这种「把可测的纯逻辑抽到独立库」的分层，是本项目能做到
> 13 条单元测试全绿的前提。

---

## 架构与数据流

```text
        ┌───────────── 同一台 Windows · 同一用户会话 ─────────────┐
        │                                                          │
  WeFlow 本机 SSE  ──►  本程序（托盘代理）  ──HTTPS──►  work-order-system（远端）
  127.0.0.1:5031        · SSE 连接管理                  · uploadMedia → file_id+可达url
  /push/messages        · 按 event+rawid 去重           · receiveMessage → code==1 视为成功
  /messages（补偿）      · 媒体两步式上传                · heartbeat
  /health               · 信封转发 + 重试               │
        │              · 拉取补偿 / 心跳 / 队列死信      │
        └──────────────────────────────────────────────┘
```

关键约定（细节见 SRS）：
- **成功判定**：下游所有响应均 HTTP 200，成败看 body —— **成功 = `HTTP 200 且 body.code == 1`**。
- **幂等去重键**：`event + rawid`（`rawid == serverId`）。
- **媒体**：先 `uploadMedia` 拿 `file_id` + 远端可达 `url`，再在消息体 `file` 引用（WeFlow 媒体是 `127.0.0.1`，远端不可达）。
- **下游鉴权**：`task_white_token`（AES-128-ECB/PKCS7 + base64，作为 URL 查询参数，每次实时生成）。

---

## 环境准备

| 需要 | 说明 |
|------|------|
| **Windows** | WPF 仅支持 Windows；开发与运行都需在 Windows 上。 |
| **.NET 8 SDK** | 必须是 SDK（含编译/发布工具），不是仅 Runtime。装好后命令行 `dotnet --version` 应输出 8.x。 |
| **NuGet 源** | 首次还原依赖需能访问 `https://api.nuget.org/v3/index.json`。若没有源：`dotnet nuget add source https://api.nuget.org/v3/index.json -n nuget.org`。 |
| IDE（任选） | Visual Studio 2022 / JetBrains Rider / VS Code（装 C# Dev Kit）。命令行用 `dotnet` 也可。 |

> 下面命令均假设 `dotnet` 已在 PATH。若你的机器把 SDK 装在非默认位置而未加入 PATH，请用 `dotnet` 的完整路径替换命令里的 `dotnet`。

---

## 如何开发

> 所有命令在仓库根目录（含 `WeflowAgent.sln` 的目录）执行。

```bash
# 1) 还原依赖（首次或改了 csproj 后；build/run 通常会自动还原，单独跑也可）
dotnet restore WeflowAgent.sln

# 2) 编译整个解决方案（Debug 配置）
dotnet build WeflowAgent.sln -c Debug

# 3) 运行托盘程序（启动后窗口居中显示，关闭窗口=最小化到托盘，托盘菜单「退出」才真正结束）
dotnet run --project src/WeflowAgent.App
```

开发约定：
- **改界面** 看 `*.xaml`（布局/外观），**改逻辑** 看对应的 `*.xaml.cs`。两者是同一个类的两半（`partial class`）。
- **加纯逻辑** 优先放进 `WeflowAgent.Core`，并在 `tests/` 补单元测试——保持「可测逻辑与 UI 分离」。
- 项目开启了 `Nullable`（可空引用类型检查）。看到带 `?` 的类型表示「允许为 null，用前请判空」。
- 代码里有大量面向新手的中文注释，逐个解释了 C#/WPF 的语法与框架概念，可对照阅读。

> ⚠️ **XAML（XML）注释有两条硬规则**，编辑 `*.xaml` 时务必注意，否则编译报 `MC3000`：
> 1. 注释不能插在某个开始标签的「属性之间」，只能放在标签**之间**；
> 2. 注释**内部**不能出现连续两个连字符 `--`（含字面写出 `<!-- -->` 示例也会触发）。

---

## 如何测试

```bash
# 运行全部单元测试（当前 13 条，预期全绿）
dotnet test WeflowAgent.sln

# 只跑某个测试项目
dotnet test tests/WeflowAgent.Core.Tests

# 按名称筛选（例如只跑迁移相关）
dotnet test --filter "FullyQualifiedName~SchemaMigrator"

# 顺带收集代码覆盖率（已配置 coverlet）
dotnet test --collect:"XPlat Code Coverage"
```

测试说明：
- 测试针对 `WeflowAgent.Core`（纯逻辑），不依赖界面，跑得快、稳定。
- 涉及真实文件/目录的测试（如 `AppPaths`、`CredentialStore`）会写到系统**临时目录**并在结束后清理，不污染你的环境。
- `DpapiCredentialProtectorTests` 依赖「运行测试的 Windows 用户与本机」一致（DPAPI 特性），这是被测类的设计前提。
- 本项目按 **TDD（测试驱动开发）** 推进，测试同时也是「这些 Core 类怎么用」的最佳示例。

---

## 如何上线（发布与部署）

交付形态：**.NET 8 自包含（self-contained）单文件免安装绿色版**——目标机器**无需预装 .NET 运行时**，
拷贝一个 `.exe` 即可运行；首次运行写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 实现当前用户自启（规划中，见进度）。

### 发布单文件 EXE

```bash
dotnet publish src/WeflowAgent.App/WeflowAgent.App.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true
```

参数含义：

| 参数 | 作用 |
|------|------|
| `-c Release` | Release 配置（优化、无调试符号） |
| `-r win-x64` | 运行时标识（RID）：64 位 Windows。如需 ARM64 用 `win-arm64` |
| `--self-contained true` | 自包含：把 .NET 运行时一起打包，目标机免装 .NET |
| `-p:PublishSingleFile=true` | 打成单个可执行文件，便于绿色分发 |
| `-p:IncludeNativeLibrariesForSelfExtract=true` | 原生库也并入单文件（运行时自解压到临时目录），产物更干净 |

产物默认在：
`src/WeflowAgent.App/bin/Release/net8.0-windows/win-x64/publish/WeflowAgent.App.exe`

> **不要对 WPF 开启 `PublishTrimmed`（裁剪）**：WPF 依赖反射，裁剪易导致运行时缺类/崩溃。

### 部署

1. 把发布出的 `.exe` 拷贝到目标机器**任意有写权限的目录**（绿色版，无需安装、无需管理员）。
2. 与 **WeFlow 同机、同一 Windows 用户**下运行（凭据 DPAPI 绑定该用户，且要访问 `127.0.0.1` 的 WeFlow）。
3. 首次运行：在「配置」页录入 WeFlow Token、下游 Base URL / site key / AES 密钥（DPAPI 加密存本地）。
4. **二进制与状态分离**：程序状态不写在 EXE 旁，而在 `%LocalAppData%\WeflowAgent`（见下节）。

### 升级与换机

- **版本升级**：直接用新 EXE 覆盖旧 EXE，本地状态原地续用；启动时 `SchemaMigrator` 按 `schemaVersion` 平滑迁移。
- **换机**：DPAPI 凭据跨机无法解密 → 程序识别为「疑似换机」（托盘转**红**），在新机重新录入凭据即可；
  历史消息不回灌，靠下游 `event+rawid` 幂等避免重复工单。

---

## 本地状态目录

程序状态统一存于 **`%LocalAppData%\WeflowAgent`**（如 `C:\Users\<你>\AppData\Local\WeflowAgent`），与 EXE 分离、免提权：

| 文件 / 目录 | 用途 | 是否可移植 |
|------------|------|-----------|
| `config.json` | 普通配置 | 可移植 |
| `secrets.dat` | DPAPI 加密的敏感凭据 | **不可移植**（换机需重录） |
| `state.db` | 断点 / 去重表 / 队列 / 死信（LiteDB，规划） | 可移植 |
| `logs/` | 分级日志 | — |

> `secrets.dat`、`state.db`、`logs/` 已在 `.gitignore` 中排除，**切勿提交到仓库**。

---

## 项目进度

**已落地（骨架，含单元测试，构建 0 警告 0 错误、13 测试全绿）**
- 解决方案三项目分层：`Core`（库）/ `App`（WPF）/ `Core.Tests`（xUnit）。
- `Core`：`AppPaths`、`DpapiCredentialProtector`、`CredentialStore`（含换机信号 `Undecryptable`）、`SchemaMigrator`、`StartupStatus`。
- `App`：`AgentBootstrapper`（启动胶水）、`TrayIcon`（绿/黄/红 + 右键菜单）、`MainWindow`（四区界面 + 关闭最小化到托盘）。首跑无凭据 → 黄色「需配置」。

**尚为占位（待按 SRS 各模块实现）**
- SSE 接入与连接管理、`receiveMessage` 信封转发、媒体两步式上传、`task_white_token` 加密生成。
- 心跳上报、拉取补偿 / 主动同步、配置录入界面、日志 / 审计、测试 / 诊断面板。
- 首次运行写 `HKCU\…\Run` 自启。

---

## 相关文档

- [需求规格说明书（SRS v1.3）](docs/weflow-工单消息转发代理-需求规格说明书.md) — 最权威，开发/测试/验收依据。
- [下游对接接口规格说明书](docs/weflow-对接接口规格说明书（work-order-system侧）.md) — work-order-system 侧契约。
- [HTTP API 速查](docs/http-api.md)
