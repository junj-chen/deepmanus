# deepopen

An [opencode](https://opencode.ai)-style AI coding agent clone, built with
**[deepagents](https://github.com/langchain-ai/deepagents)** (LangChain) on the
backend and **CopilotKit v2** + **AG-UI** on the frontend.

## Architecture

Three services, talking over the AG-UI protocol (Server-Sent Events):

```
① Frontend (vite + react, JS/JSX)        ② Express middleware             ③ Python backend
  CopilotKit v2 + shadcn/ui               CopilotRuntime v2                FastAPI + deepagents
  view → store → service (mobx)           createCopilotExpressHandler      AG-UI endpoint
  tailwindcss                             registers HttpAgent → Python     create_deep_agent
       │                                       │                              │
       │  runtimeUrl=/api/copilotkit            │ HTTP (AG-UI SSE)            │
       └────────────────────────────────►───────┴────────────────────────────►┘
           (vite dev proxy → :4000)            (LangGraphHttpAgent → :8000)
```

- **③ Backend (`backend/`)** — `deepagents` agent with an OpenAI-compatible
  model, operating on the **real local filesystem** (`LocalShellBackend`) and
  persisting conversation history in a SQLite/Postgres checkpointer. Exposed as
  a standard **AG-UI** endpoint at `/agents/main`.
- **② Runtime (`runtime/`)** — standalone **Express** service hosting
  CopilotKit's `CopilotRuntime` (v2). Registers a `LangGraphHttpAgent` that
  forwards to the Python AG-UI endpoint. This is the official
  "deploy-to-any-runtime" pattern from the CopilotKit ↔ deepagents docs.
- **① Frontend (`frontend/`)** — vite + react (JS/JSX) with CopilotKit v2,
  **mobx** (`view → store → service` one-way data flow), **tailwindcss**, and
  **shadcn/ui**. A terminal-style full-screen chat UI.

## Prerequisites

- Python 3.13+ with [`uv`](https://docs.astral.sh/uv/)
- Node.js 20+ with `yarn` (or `npm`)

## Quick start

### 1. Configure the backend

```bash
cd backend
cp .env.example .env
# edit .env: set OPENAI_API_KEY / OPENAI_BASE_URL / MODEL
# any OpenAI-compatible endpoint works (OpenAI, OpenRouter, Ollama, LiteLLM, …)
```

### 2. Start all three services (three terminals)

```bash
# terminal 1 — Python backend (port 8000)
cd backend
uv run uvicorn deepopen.main:app --reload --port 8000

# terminal 2 — Express CopilotKit runtime (port 4000)
cd runtime
cp .env.example .env
yarn dev

# terminal 3 — frontend (port 5173)
cd frontend
yarn install
yarn dev
```

Open http://localhost:5173 and chat. The agent reads/writes/runs files in
`backend/` (or `WORKDIR` from `.env`) and remembers the conversation across
restarts (SQLite at `backend/data/checkpoints.db`).

## Configuration

### Backend (`backend/.env`)

| Var | Default | Purpose |
|-----|---------|---------|
| `OPENAI_API_KEY` | — | API key for the model provider |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible base URL |
| `MODEL` | `gpt-4o-mini` | Model name |
| `WORKDIR` | server cwd | Directory the agent edits (real files) |
| `DATABASE_URL` | `sqlite:///./data/checkpoints.db` | History storage (or a postgres URL) |

### Runtime (`runtime/.env`)

| Var | Default | Purpose |
|-----|---------|---------|
| `AGENT_URL` | `http://127.0.0.1:8000/agents/main` | Python AG-UI endpoint |
| `PORT` | `4000` | Express listen port |

## How the AG-UI bridge works

`backend/src/deepopen/agui_bridge.py` drives `agent.astream(...)` (LangGraph v2
streaming, `stream_mode=["messages","updates"]`, `subgraphs=True`) and re-emits
each chunk as a standard AG-UI event:

| deepagents / LangGraph | AG-UI event |
|---|---|
| run start | `RUN_STARTED` |
| `AIMessageChunk` text token | `TEXT_MESSAGE_*` |
| tool call (streamed) | `TOOL_CALL_START` / `TOOL_CALL_ARGS` |
| `ToolMessage` (result) | `TOOL_CALL_RESULT` / `TOOL_CALL_END` |
| node step | `STEP_STARTED` / `STEP_FINISHED` |
| exception | `RUN_ERROR` |
| run end | `RUN_FINISHED` |

CopilotKit's runtime transparently proxies this SSE stream to the React UI,
which renders the streaming tokens and tool calls.

## Frontend data flow

Strict one-way flow (views never call backends directly):

```
view (observer) ──action──► store (mobx) ──call──► service ──fetch──► backend
     ▲                            │
     └──── observable state ◄─────┘
```

The live chat (streaming tokens + tool calls) is rendered by CopilotKit's
`<CopilotChat>`. The mobx store holds surrounding app state (sessions,
connection, UI).

## Project layout

```
deepagents-opencode/
├── backend/      # Python: FastAPI + deepagents + AG-UI endpoint
├── runtime/      # JS:     Express + CopilotKit CopilotRuntime v2
└── frontend/     # JS/JSX: vite + react + CopilotKit + mobx + tailwind + shadcn
```
