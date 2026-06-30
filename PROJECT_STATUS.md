# OpenManus 项目记忆文档

> 最后更新：2026-06-29 | 仓库：https://github.com/w00199552/deepmanus.git (main 分支)
> 这份文档是项目的"长期记忆"，记录架构决策、实现现状、待办与已知问题。每次会话开始时优先读它恢复上下文。

---

## 1. 项目定位

**OpenManus** = opencode 风格的 AI 编码 Agent 克隆。

- 后端：**Python FastAPI + deepagents (LangChain/LangGraph)**，自解析 AG-UI SSE 协议
- 前端：**vite + react (JS/JSX) + mobx + tailwindcss v4 + shadcn/ui**
- 模型：双 provider 模式（Anthropic 协议 / OpenAI 兼容协议）
- 数据流：view → store (mobx) → service → backend（严格单向）
- 仓库目录：`deepagents-opencode/`（含 backend/、frontend/）

**关键架构演进**：早期基于 CopilotKit v2 + Express 中间件，后因 CopilotKit message state 绑定内部 Provider、self-render 不可行而**彻底弃用**，改为前端直连 FastAPI 自解析 AG-UI SSE。

---

## 2. 核心架构

### 2.1 Agent 三态路由模型（核心）

入口 default agent 是**纯路由器**（不写代码），三态决策：

| 用户输入 | 路径 | 工具 |
|---|---|---|
| 普通聊天/简单问题（问候、概念、读文件） | default 自己答（只用只读工具） | ls/read_file/grep/glob |
| 单一明确专业任务（实现算法、改代码） | `dispatch_single` → 单个 coder/researcher | dispatch_single |
| 复杂多步任务（需多角色协作） | `dispatch_to_team` → teamleader 编排 | dispatch_to_team |

**硬约束（关键）**：`ToolGuardMiddleware`（`backend/src/openmanus/middleware/tool_guard.py`）在 model-request 和 tool-execution **双层**拦截 `write_file/edit_file/execute/write_todos/task` 工具。default 物理上无法写代码，只能派活。

**为什么双层**：deepagents 的 `_ToolExclusionMiddleware` 只过滤 model request 的 tools 列表，但模型可幻觉出工具调用，FilesystemMiddleware 的 wrap_tool_call 照样执行。ToolGuard 加了 wrap_tool_call 层才彻底堵死。

**重要陷阱**：
- deepagents 默认注入 general-purpose subagent + `task` 工具（即使不传 subagents 参数）。早期 default 用内置 task 自己干活绕过我们的 dispatch 体系。**已用 ToolGuard 把 task 也禁掉**。
- 这个版本的 `create_deep_agent` **没有** `general_purpose_subagent` 参数（注释提到但实际签名没有，传了会 TypeError 启动崩溃）。禁 task 只能靠 ToolGuardMiddleware。

### 2.2 三个 dispatch 工具

| 工具 | 调用者 | 创建会话 | 执行方式 | 文件 |
|---|---|---|---|---|
| `dispatch_single` | default | subagent (kind=subagent, parent=default) | **异步** asyncio.create_task，single_runner astream 流式 | tools/dispatch_single.py |
| `dispatch_to_team` | default | team (kind=team, name=teamleader) | **异步** asyncio.create_task，team_runner 后台跑 teamleader | tools/dispatch_to_team.py |
| `dispatch_task` | teamleader | subagent (kind=subagent, internal=True) | **同步** ainvoke（阻塞 teamleader 直到子 agent 完成） | tools/dispatch_task.py |

**dispatch_single vs dispatch_task 的区别**：
- dispatch_single：default → 单 agent，异步后台，独立会话（TASKS 区显示），single_runner 流式
- dispatch_task：teamleader → 团队内子 agent，同步阻塞，标记 `internal=True`（列表隐藏）

**子 agent 跑在哪个 graph 上**：dispatch_single 的 agent_ref 指向 **teamleader 的 graph**（完整文件工具），不是 default 的（被 ToolGuard 剥光）。否则 coder 没工具用。

### 2.3 会话数据模型（图结构）

SQLite 两表（`backend/data/sessions.db`）：
- `sessions`：id, kind(root/team/subagent), name, status(active/running/done/error), title, model, workdir, metadata(JSON), created_at, updated_at
- `message_links`：id, from_session_id, to_session_id, direction(chat/dispatch/result), content, created_at

**default 是单例**：固定 id=`"default"`（前端 `DEFAULT_ID="default"`），不可删、永远在列表。历史无限累积的问题用 **NewChat 重置**（后端 `adelete_thread` 清 checkpointer，session 行保留）解决。

**checkpointer**：LangGraph 的 AsyncSqliteSaver（`backend/data/checkpoints.db`），按 thread_id=session_id 持久化对话历史。`GET /sessions/:id` 从 checkpointer 重建历史为扁平时间线。

### 2.4 AG-UI SSE 协议

前端自解析 SSE（弃了 CopilotKit）。后端产标准 AG-UI 事件帧（`data: {...}\n\n`）：
- `TEXT_MESSAGE_START/CONTENT/END`：文本流式
- `TOOL_CALL_START/ARGS/RESULT/END`：工具调用
- `RUN_STARTED/FINISHED`、`STEP_*`、`RUN_ERROR`

**关键坑（已解）**：deepagents 把整个 turn 的文本**复用同一个 messageId**，只在开头 START 一次、结尾 END 一次。前端必须按"时间线尾部是否开放文本段"判断，不能靠 messageId 区分段（否则工具后的文本被丢弃）。

**群聊特殊帧**：team 用自定义 `GROUP_MESSAGE`（带 speaker 字段），前端单独渲染发言人气泡。

---

## 3. 后端实现现状（backend/src/openmanus/）

| 文件 | 职责 |
|---|---|
| `main.py` | FastAPI app，lifespan 启动时 init_db + ensure_default + build_agents。挂路由 |
| `config.py` | Settings（.env）：model_provider/model/各 provider key/ssl_verify/workdir/database_url/port=8999 |
| `agent_factory.py` | 构 default + teamleader agent。_build_model 按 provider 切 ChatAnthropic/ChatOpenAI（注入 httpx client 支持 ssl_verify）。DEFAULT_PROMPT/TEAMLEADER_PROMPT |
| `agui_bridge.py` | AGUIBridge：agent.astream chunk → AG-UI 帧映射。_handle_chunk/_handle_ai_chunk/_extract_text |
| `db.py` | SessionStore CRUD + ensure_default(固定 id，每次启动刷 title="Manus") + ensure_exists + graph 查询 |
| `store.py` | get_checkpointer：SQLite（AsyncSqliteSaver）/ Postgres |
| `single_runner.py` | SingleRegistry(队列) + launch_single + _run_single_agent(astream 流式到队列 + checkpointer) |
| `team_runner.py` | TeamRegistry(队列) + launch_team + _run_teamleader + _push_group_message |
| `middleware/tool_guard.py` | **ToolGuardMiddleware**：双层硬约束（model-request + tool-execution）禁工具 |
| `api/run.py` | POST /agents/main（AG-UI SSE）。_ensure_session（按 sessionId/header 创建会话）。run 期间 status=running→active |
| `api/sessions.py` | CRUD + GET /:id(扁平时间线历史) + POST /:id/preview + POST /:id/reset(adelete_thread) + GET /:id/stream(subagent SSE) + GET /:id/graph |
| `api/teams.py` | GET /teams/:id/stream(team SSE drain) + messages + POST message |
| `tools/dispatch_single.py` | 异步单 agent 派活（default 用） |
| `tools/dispatch_to_team.py` | 异步团队派活（default 用），创建 team + launch_teamleader，metadata.members=[teamleader,researcher,coder] |
| `tools/dispatch_task.py` | 同步团队内派活（teamleader 用），创建 internal subagent，检测 team 上下文 push GROUP_MESSAGE |
| `tools/roles.py` | ROLES 字典（researcher/coder 的 prompt + allowed_tools） |

**模型 provider 切换**：
```python
# config.py
model_provider: str = "anthropic"  # 或 "openai"
# agent_factory._build_model 按 provider 切 ChatAnthropic / ChatOpenAI
# OpenAI 模式注入 verify=ssl_verify 的 httpx client（公司自签证书跳过）
```

**端口**：后端 **8999**（config.py port=8999），前端 5173，vite proxy → 8999。

---

## 4. 前端实现现状（frontend/src/）

### 4.1 数据流（mobx view→store→service）

| 层 | 文件 | 说明 |
|---|---|---|
| view | views/Workspace.jsx | 4 panel 布局（左: list\|chat，右: Playground），react-resizable-panels，layout 存 localStorage(已迁移 openmanus.*) |
| view | views/SessionList.jsx | 微信式列表：搜索框 + DEFAULT/TASKS 标题栏分组 + 头像脉冲点 |
| view | views/ChatPane.jsx | 中间聊天列：单 agent(team外) 或 team 群聊切换，loadHistory/subscribeLive |
| view | views/Playground.jsx | 右侧：Sandbox + CodeEditor 工具平铺（占位） |
| store | stores/SessionStore.js | **核心**：DEFAULT_ID 单例 + rootSessions(始终含default) + taskSessions(隐藏internal) + bumpActivity + resetDefault + newConversation + markRunning/markStatus |
| store | stores/ChatStore.js | 扁平时间线(items: user/assistant-text/tool) + send(流式) + loadHistory + subscribeLive + _handleEvent(AG-UI reducer) + _afterDelegation(列表diff自动切换) |
| store | stores/TeamStore.js | team 群聊：open(load+subscribe) + _appendGroup + _handleFrame |
| service | services/agentService.js | streamAgent(POST /agents/main fetch+SSE) + subscribeSession(GET /sessions/:id/stream EventSource) |
| service | services/sessionService.js | CRUD + setPreview + resetHistory |
| service | services/teamService.js | subscribeTeam(GET /teams/:id/stream EventSource) |
| hook | hooks/useChat.js | view 适配层：send(无active时lazy create) + items/isLoading/stop |

### 4.2 头像系统（components/Avatar.jsx）

DiceBear adventurer 风格，HTTP API 零依赖 `<img>`：
- `avatarUrl(seed)`：加 skinColor（浅/米肤色池按 seed 哈希选，避免全深肤色）
- `Avatar`：单头像；`TeamAvatar`：2×2 网格徽章（最多4个小脸）；`SessionAvatar`：按 session.kind 选
- **Manus 专属 seed**："manus-open"（default 会话固定这张脸）
- subagent 用 session.id 做 seed（每次派活不同脸，刷新稳定）
- 聊天窗 ChatMessages.assistantSeed 和 SessionAvatar 逻辑一致（列表=聊天窗同张脸）

### 4.3 聊天渲染（components/chat/）

- `ChatMessages.jsx`：扁平时间线，每段是 observer（immutable-replace 修 mobx 渲染）。DiceBear 头像 + thinking 占位 + 自动滚动(stickToBottom)
- `ChatInput.jsx`：ZCode 风格大 textarea + 工具栏(+新对话仅root/📎/⚙️/@) + Radix tooltip
- `TeamMessages.jsx`：群聊，DiceBear 头像(seeded by speaker) + 角色色 + 折叠 + 自动滚动

### 4.4 设计系统

- 深色"quiet dark cinematic"（omma.build 风），token 在 index.css `@theme`（Tailwind v4 必须 @theme 不是 config）
- 完整语义 token：background/card/sidebar/popover + 各自 -foreground + accent/destructive/border/muted + role-*(teamleader绿/researcher蓝/coder橙)
- 脉冲点 keyframes（animate-pulse-dot）

---

## 5. 关键实现决策（防遗忘）

1. **mobx 渲染坑**：in-place 属性写（`last.text +=`）在 React19+mobx-react-lite 不可靠。所有 store 变更用 **immutable index replacement**（`this.items[i] = {...cur, text: ...}`）。
2. **default 单例**：id 固定 "default"，不可删，NewChat=reset（adelete_thread）。不是多实例（曾试过多实例后又改回单例，因为用户要"default 永远在、不可删、派活不消失"）。
3. **派活自动切换**：_afterDelegation 用**列表 diff**（对比 load 前后 session id 集合找新增），不依赖 parent 字段（parent 不可靠）。
4. **串台 bug（已解）**：ChatPane 切换 effect 必须**无条件先 _disposeLive**，否则子 agent SSE 继续喂 default 视图。
5. **localStorage 迁移**：deepopen.* → openmanus.* 有迁移代码（读旧 key 回填），用户状态不丢。
6. **deepagents task 工具**：必须禁掉（ToolGuard），否则 default 用内置 task 绕过 dispatch。
7. **包名改名**：deepopen→openmanus，目录/import/品牌全改。import 都是相对的（from .xxx），改名后自动适配。

---

## 6. 当前 Todo（待办）

### 高优先级（team 群聊打磨，进行中）
- [ ] **[L-2]** team_runner：teamleader 文本增量走 GROUP_MESSAGE（现在只在开始/结束 push，中间思考文本走标准帧无 speaker）
- [ ] **[L-4]** TeamStore._handleFrame 改进（TOOL_CALL 显示更友好）
- [ ] **用户验证** team 群聊 4 个问题（speaker 区分/工作可见/头像/滚动）

### 中优先级
- [ ] 前端模型配置 UI（输入框 ⚙️ 按钮做面板：选 provider/base_url/key/model，运行时切换不用改 .env）
- [ ] Playground 实时化（Sandbox 显示真实目录、Code 显示 agent 编辑的文件）—— 当前是占位假数据
- [ ] Playground frontendTool 动态工具接入
- [ ] thinking 渲染（GLM-anthropic 不分离 thinking，需换协议/模型；优先级低）

### 低优先级
- [ ] 历史会话恢复的旧 root 显示（当前隐藏，后续可加历史回看入口）
- [ ] 团队子 agent speaker 在群聊完全区分（researcher/coder 工作流更清晰）

---

## 7. 已知 Bug / 问题

### 已解决（记录避免重犯）
- ✅ CopilotKit headless empty messages → 弃 CopilotKit 自解析 SSE
- ✅ mobx 渲染不流式 → immutable-replace + observer
- ✅ 文本/工具不交替（工具后文本丢失）→ 弃 _cursor 改时间线尾部判断（根因：messageId 复用）
- ✅ default 自己干活 → ToolGuardMiddleware 双层禁 + 禁 task 工具
- ✅ create_deep_agent 无 general_purpose_subagent 参数 → 用 ToolGuard 禁 task
- ✅ message 串台 → ChatPane effect 无条件先 disposeLive
- ✅ 后端 502 → 包名/import 错误，改名后修复
- ✅ default 标题不刷新 → ensure_default 每次启动强制 update title
- ✅ 公司内网 SSL → SSL_VERIFY=false + httpx client 注入

### 待观察 / 未定位
- ⚠️ **前端轮询 404**：前端代码无任何 /health 轮询（已确认）。疑似 vite/浏览器/端口冲突。换端口 8999 后观察。需 Network 面板的 Initiator 列确认来源。
- ⚠️ **SSL_VERIFY 对 ChatAnthropic 无效**：ChatAnthropic 不支持 http_client 注入（参数被转 model_kwargs）。公司用 OpenAI 模式不受影响，Anthropic 模式靠环境变量兜底。
- ⚠️ **team 群聊 teamleader 中间思考不可见**：teamleader token 走标准 AG-UI 帧无 speaker，TeamStore._handleFrame 忽略文本帧。只有开始/结束 GROUP_MESSAGE。这是 [L-2] 待修。
- ⚠️ **公司环境未实测**：公司模型连接、SSL 跳过、功能完整性需公司机器验证。

---

## 8. 启动 / 配置

### 启动
- Windows：双击 `restart.bat`（杀旧 python/node → 起后端 8999 + 前端 5173）
- 手动：`cd backend && uv run uvicorn openmanus.main:app --port 8999` + `cd frontend && yarn dev`

### 模型配置（backend/.env）

**Mode A（OpenAI 兼容，公司内网/自建模型）**：
```env
MODEL_PROVIDER=openai
MODEL=公司模型名
OPENAI_API_KEY=公司key
OPENAI_BASE_URL=公司模型地址/v1
SSL_VERIFY=false   # 自签证书才加这行
```

**Mode B（Anthropic/GLM）**：
```env
MODEL_PROVIDER=anthropic
MODEL=GLM-5.2
ANTHROPIC_API_KEY=bigmodel-key
ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic
```

### 关键端口/路径
- 后端：8999，health：`http://127.0.0.1:8999/agents/main/health`
- 前端：5173
- 前端 proxy：/agents、/sessions、/teams、/workdir → 8999

---

## 9. Git 状态

- 仓库：https://github.com/w00199552/deepmanus.git（main 分支）
- 最新 commit：`a6f5018`（SSL 证书跳过支持）
- push 网络不稳定（github 偶尔连不上），失败时多重试
- .env 在 .gitignore（API key 不泄露）
- agent 测试产物（bfs/dfs/workspace/Z 等）已加 .gitignore 排除
