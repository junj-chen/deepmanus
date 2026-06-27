#!/usr/bin/env bash
# Start all three deepopen services for local development.
#
#   backend  (Python, :8000)  deepagents AG-UI endpoint
#   runtime  (Express, :4000) CopilotKit CopilotRuntime v2
#   frontend (vite,   :5173)  React UI
#
# Logs go to .logs/. Stop everything with  Ctrl-C  (or kill the script).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$ROOT/.logs"
mkdir -p "$LOG_DIR"

if [ ! -f "$ROOT/backend/.env" ]; then
  echo "⚠️  backend/.env missing — copy backend/.env.example and set OPENAI_API_KEY"
fi

pids=()
cleanup() {
  echo
  echo "stopping services…"
  for pid in "${pids[@]:-}"; do kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM

echo "▶ starting backend  (logs: .logs/backend.log)"
( cd "$ROOT/backend" && uv run uvicorn deepopen.main:app --port 8000 ) \
  >"$LOG_DIR/backend.log" 2>&1 &
pids+=($!)

echo "▶ starting runtime  (logs: .logs/runtime.log)"
( cd "$ROOT/runtime" && node src/index.js ) \
  >"$LOG_DIR/runtime.log" 2>&1 &
pids+=($!)

# Give the runtime a moment so the frontend's first /info request succeeds.
sleep 2

echo "▶ starting frontend (logs: .logs/frontend.log)"
( cd "$ROOT/frontend" && yarn dev ) \
  >"$LOG_DIR/frontend.log" 2>&1 &
pids+=($!)

echo
echo "✅ deepopen is starting up."
echo "   frontend: http://localhost:5173"
echo "   runtime:  http://localhost:4000/api/copilotkit/info"
echo "   backend:  http://localhost:8000/agents/main/health"
echo "   (Ctrl-C to stop all)"
echo

wait
