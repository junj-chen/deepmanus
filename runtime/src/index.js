/**
 * Express middleware layer hosting CopilotKit v2 Runtime.
 *
 * This is the "proxy/runtime" service between the React frontend and the
 * Python deepagents backend. It registers a LangGraphHttpAgent that points at
 * the Python AG-UI endpoint, and exposes the CopilotKit runtime under
 * /api/copilotkit/* for the frontend's <CopilotKit runtimeUrl> to consume.
 *
 *   Frontend (vite proxy)  -->  this Express (CopilotRuntime)  -->  Python AG-UI
 */

import "dotenv/config";
import express from "express";
import { CopilotRuntime } from "@copilotkit/runtime/v2";
import { createCopilotExpressHandler } from "@copilotkit/runtime/v2/express";
import { LangGraphHttpAgent } from "@copilotkit/runtime/langgraph";

// Where the Python deepagents backend is listening.
const AGENT_URL =
  process.env.AGENT_URL || "http://127.0.0.1:8000/agents/main";
const PORT = Number(process.env.PORT || 4000);

// Register the Python agent as the "default" agent. CopilotKit resolves the
// agent by name from the frontend; "default" is what <CopilotKit> uses when no
// explicit agent is requested.
const agent = new LangGraphHttpAgent({
  name: "default",
  description: "deepopen coding agent (deepagents)",
  url: AGENT_URL,
});

const runtime = new CopilotRuntime({
  agents: { default: agent },
});

const app = express();

// DEBUG: log every request the frontend makes, so we can see the exact path +
// body shape CopilotKit expects.
app.use((req, res, next) => {
  if (req.url.startsWith("/api/copilotkit")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const preview = body ? body.slice(0, 300) : "(empty)";
      console.log(`[req] ${req.method} ${req.url} body=${preview}`);
    });
  }
  next();
});

// Mount the CopilotKit runtime under a stable prefix. The frontend sets
// runtimeUrl="/api/copilotkit" and vite proxies it here in dev.
// CopilotKit v2 <CopilotChat> uses a SINGLE-ENDPOINT RPC protocol: every
// request is POSTed to the runtimeUrl root with a `method` field in the body
// (e.g. {"method":"info"} or {"method":"agent/run",...}). So we MUST use
// mode="single-route", which serves all methods from the basePath itself.
// (multi-route would expect /agent/<id>/run sub-paths and 404 the root POST.)
app.use(
  createCopilotExpressHandler({
    runtime,
    basePath: "/api/copilotkit",
    mode: "single-route",
    cors: true,
  }),
);

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[deepopen-runtime] CopilotKit v2 runtime on http://127.0.0.1:${PORT}`);
  console.log(`[deepopen-runtime] agent -> ${AGENT_URL}`);
  console.log(`[deepopen-runtime] frontend runtimeUrl = /api/copilotkit`);
});
