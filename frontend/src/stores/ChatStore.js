import { makeAutoObservable, runInAction } from "mobx";

/**
 * ChatStore owns the visible chat state.
 *
 * It does NOT call any backend directly. Agent message events arrive from the
 * CopilotKit hook layer (hooks/useChatAgent.js), which calls the `append*`
 * actions below. This keeps view components free of any service knowledge.
 */
export class ChatStore {
  // List of rendered messages: { id, role: 'user'|'assistant'|'tool', text, tool }
  messages = [];
  // id of the message currently streaming assistant text into
  streamingMessageId = null;
  // whether an agent run is in flight
  isRunning = false;
  // last error message, if any
  error = null;

  constructor() {
    makeAutoObservable(this);
  }

  /** Add a fully-formed user message. */
  addUserMessage(text) {
    this.messages.push({
      id: `u-${Date.now()}`,
      role: "user",
      text,
    });
  }

  /** Begin (or continue) a streaming assistant message; returns its id. */
  beginAssistantMessage() {
    if (this.streamingMessageId == null) {
      this.streamingMessageId = `a-${Date.now()}`;
      this.messages.push({
        id: this.streamingMessageId,
        role: "assistant",
        text: "",
      });
    }
    return this.streamingMessageId;
  }

  /** Append a text delta to the streaming assistant message. */
  appendAssistantText(delta) {
    const id = this.streamingMessageId ?? this.beginAssistantMessage();
    const msg = this.messages.find((m) => m.id === id);
    if (msg) msg.text += delta;
  }

  /** Finalize the streaming assistant message. */
  endAssistantMessage() {
    this.streamingMessageId = null;
  }

  /** Add a tool-call entry (name + args + result). */
  addToolCall(toolCallId, name) {
    this.messages.push({
      id: `t-${toolCallId}`,
      role: "tool",
      toolCallId,
      name,
      args: "",
      result: null,
      done: false,
    });
  }

  /** Append streaming args to a tool call. */
  appendToolArgs(toolCallId, delta) {
    const msg = this.messages.find((m) => m.role === "tool" && m.toolCallId === toolCallId);
    if (msg) msg.args += delta;
  }

  /** Set a tool call's result and mark it done. */
  setToolResult(toolCallId, result) {
    const msg = this.messages.find((m) => m.role === "tool" && m.toolCallId === toolCallId);
    if (msg) {
      msg.result = result;
      msg.done = true;
    }
  }

  setRunning(running) {
    this.isRunning = running;
    if (running) this.error = null;
  }

  setError(message) {
    this.error = message;
    this.isRunning = false;
    this.streamingMessageId = null;
  }

  /** Replace the whole message list (e.g. when loading a past session). */
  setMessages(messages) {
    runInAction(() => {
      this.messages = messages;
      this.streamingMessageId = null;
    });
  }

  /** Reset chat state for a new conversation. */
  clear() {
    this.messages = [];
    this.streamingMessageId = null;
    this.isRunning = false;
    this.error = null;
  }
}
