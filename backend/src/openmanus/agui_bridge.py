"""Bridge deepagents/LangGraph streaming to AG-UI events.

This is the heart of the backend: we drive ``agent.astream(...)`` and re-emit
its chunks as standard AG-UI protocol events, which CopilotKit's runtime and
the React UI consume verbatim.

Mapping (LangGraph stream_mode=v2 chunk -> AG-UI event):

  run begin            -> RunStartedEvent
  messages / AIMessageChunk text token   -> TextMessage{Start,Content,End}
  messages / AIMessageChunk tool_call    -> ToolCall{Start,Args,End}
  messages / ToolMessage (result)        -> ToolCallResultEvent
  updates / node step                   -> Step{Started,Finished}
  exception                              -> RunErrorEvent
  run end                                -> RunFinishedEvent

A new assistant ``message_id`` and per-tool ``tool_call_id`` are generated when
the LLM first emits them and tracked so the matching End events can be emitted.
"""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import AsyncIterator
from typing import Any

from ag_ui.core import (
    EventType,
    RunErrorEvent,
    RunFinishedEvent,
    RunFinishedSuccessOutcome,
    RunStartedEvent,
    StepFinishedEvent,
    StepStartedEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
    ToolCallStartEvent,
)
from ag_ui.encoder import EventEncoder
from langchain_core.messages import AIMessageChunk, ToolMessage
from langgraph.graph.state import CompiledStateGraph

logger = logging.getLogger(__name__)


def _new_id() -> str:
    return uuid.uuid4().hex


def _extract_text(content: Any) -> list[str]:
    """Pull text deltas out of a streamed message ``content`` field.

    Handles both shapes produced by different providers:
      * ``str``  — OpenAI-style streaming (returned as a single-element list)
      * ``list`` — content blocks, e.g. ``[{"text": "Hi", "type": "text"}]``
        (Anthropic / GLM streaming); we collect the ``text`` of each
        ``text``-typed block in order.
    """
    if content is None:
        return []
    if isinstance(content, str):
        return [content]
    if isinstance(content, list):
        out: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                t = block.get("text")
                if t:
                    out.append(t)
            elif isinstance(block, str):
                out.append(block)
        return out
    return []


class _StreamState:
    """Tracks ids emitted so far so we can close them with End events."""

    def __init__(self) -> None:
        # assistant text message that is currently open (if any)
        self.assistant_message_id: str | None = None
        # tool_call_id -> whether we've emitted its ToolCallStart
        self.open_tool_calls: set[str] = set()
        # node names with an open StepStarted
        self.open_steps: set[str] = set()


class AGUIBridge:
    """Converts a deepagents run into an AG-UI SSE byte stream."""

    def __init__(self, agent: CompiledStateGraph) -> None:
        self._agent = agent
        self._enc = EventEncoder()

    async def run(
        self,
        *,
        thread_id: str,
        run_id: str,
        user_text: str,
    ) -> AsyncIterator[str]:
        """Yield SSE frames (``data: {...}\\n\\n``) for one assistant turn."""
        st = _StreamState()

        yield self._frame(
            RunStartedEvent(thread_id=thread_id, run_id=run_id)
        )

        config = {"configurable": {"thread_id": thread_id}}
        input_state = {"messages": [{"role": "user", "content": user_text}]}

        try:
            async for chunk in self._agent.astream(
                input_state,
                config=config,
                stream_mode=["messages", "updates"],
                subgraphs=True,
                version="v2",
            ):
                for frame in self._handle_chunk(chunk, st):
                    yield frame
        except Exception as exc:  # noqa: BLE001 - surface to the UI
            logger.exception("agent run failed")
            yield self._frame(RunErrorEvent(message=str(exc)))
            return
        finally:
            # Close anything still open.
            for frame in self._close_open(st):
                yield frame

        yield self._frame(
            RunFinishedEvent(
                thread_id=thread_id,
                run_id=run_id,
                outcome=RunFinishedSuccessOutcome(),
            )
        )

    # -- chunk dispatch ---------------------------------------------------

    def _handle_chunk(
        self, chunk: dict[str, Any], st: _StreamState
    ) -> list[str]:
        """Return the AG-UI frames for one LangGraph stream chunk.

        Pure/synchronous: it only constructs event strings, never awaits.
        """
        ctype = chunk.get("type")

        if ctype == "updates":
            return self._handle_updates(chunk.get("data") or {})

        if ctype != "messages":
            return []

        data = chunk.get("data")
        if not isinstance(data, tuple) or len(data) != 2:
            return []
        msg, _meta = data

        if isinstance(msg, AIMessageChunk):
            return self._handle_ai_chunk(msg, st)
        if isinstance(msg, ToolMessage):
            return self._handle_tool_message(msg, st)
        return []

    # -- AI text + tool-call streaming -----------------------------------

    def _handle_ai_chunk(
        self, msg: AIMessageChunk, st: _StreamState
    ) -> list[str]:
        frames: list[str] = []
        # Streaming tool-call fragments emitted by the model as it parses args.
        for tc in msg.tool_call_chunks or []:
            name = tc.get("name") if isinstance(tc, dict) else getattr(tc, "name", None)
            args = tc.get("args") if isinstance(tc, dict) else getattr(tc, "args", None)
            tcid = tc.get("id") if isinstance(tc, dict) else getattr(tc, "id", None)

            if name:  # first fragment carries the tool name -> start
                tcid = tcid or _new_id()
                st.open_tool_calls.add(tcid)
                frames.append(
                    self._frame(ToolCallStartEvent(tool_call_id=tcid, tool_call_name=name))
                )
            if args:
                # args may arrive as a partial JSON string across fragments.
                if not tcid:
                    tcid = next(iter(st.open_tool_calls), None) or _new_id()
                frames.append(
                    self._frame(ToolCallArgsEvent(tool_call_id=tcid, delta=str(args)))
                )

        # Plain assistant text. The content may be:
        #   - a str (OpenAI-style streaming chunks), or
        #   - a list of content blocks, e.g. [{"text": "Hi", "type": "text",
        #     "index": 0}] (Anthropic/GLM streaming). We extract the text from
        #     any text blocks and emit it as TEXT_MESSAGE_CONTENT deltas.
        for text in _extract_text(msg.content):
            if not text:
                continue
            if st.assistant_message_id is None:
                st.assistant_message_id = _new_id()
                frames.append(
                    self._frame(TextMessageStartEvent(message_id=st.assistant_message_id))
                )
            frames.append(
                self._frame(
                    TextMessageContentEvent(
                        message_id=st.assistant_message_id, delta=text
                    )
                )
            )
        return frames

    def _handle_tool_message(self, msg: ToolMessage, st: _StreamState) -> list[str]:
        # A finished tool call -> result. tool_call_id links back to the start.
        tcid = getattr(msg, "tool_call_id", None) or _new_id()
        try:
            content = str(msg.content)
        except Exception:  # noqa: BLE001
            content = "<tool result>"
        # Mark it closed so _close_open doesn't emit a duplicate END.
        st.open_tool_calls.discard(tcid)
        return [
            self._frame(
                ToolCallResultEvent(
                    message_id=_new_id(),
                    tool_call_id=tcid,
                    content=content,
                    role="tool",
                )
            ),
            # Close the matching tool call start.
            self._frame(ToolCallEndEvent(tool_call_id=tcid)),
        ]

    # -- updates / steps -------------------------------------------------

    def _handle_updates(self, data: dict[str, Any]) -> list[str]:
        frames: list[str] = []
        for node_name in data.keys():
            if not node_name:
                continue
            frames.append(self._frame(StepStartedEvent(step_name=node_name)))
            frames.append(self._frame(StepFinishedEvent(step_name=node_name)))
        return frames

    # -- cleanup & helpers ----------------------------------------------

    def _close_open(self, st: _StreamState) -> list[str]:
        frames: list[str] = []
        if st.assistant_message_id is not None:
            frames.append(
                self._frame(TextMessageEndEvent(message_id=st.assistant_message_id))
            )
            st.assistant_message_id = None
        for tcid in list(st.open_tool_calls):
            frames.append(self._frame(ToolCallEndEvent(tool_call_id=tcid)))
            st.open_tool_calls.discard(tcid)
        return frames

    def _frame(self, event: Any) -> str:
        try:
            return self._enc.encode(event)
        except Exception:  # noqa: BLE001 - never break the stream
            logger.exception("failed to encode event %s", event)
            payload = json.dumps({"type": EventType.RAW.value, "data": str(event)})
            return f"data: {payload}\n\n"
