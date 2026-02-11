"""
Archestra proxy addon for Claude Desktop.

Routes claude.ai chat completions through Archestra's LLM proxy,
giving you tool invocation policies, dual LLM defense, cost limits,
and full observability over Claude Desktop's interactions.

Usage:
    mitmdump -s proxy-addon.py \
        --set archestra_profile_id=<uuid> \
        --set anthropic_api_key=<key>
"""

import json
import re
import uuid as uuid_mod
from datetime import datetime, timezone

from mitmproxy import http, ctx

COMPLETION_RE = re.compile(
    r"/api/organizations/[^/]+/chat_conversations/([^/]+)/completion$"
)


class ArchestraRedirect:
    """Intercepts Claude Desktop completions and routes them through Archestra."""

    def __init__(self):
        self.host = "127.0.0.1"
        self.port = 9000
        self.profile_id = ""
        self.api_key = ""
        # Per-conversation message history (Anthropic Messages API format)
        self.conversations: dict[str, dict] = {}

    # ── mitmproxy lifecycle ───────────────────────────────────

    def load(self, loader):
        loader.add_option("archestra_host", str, "127.0.0.1", "Archestra host")
        loader.add_option("archestra_port", int, 9000, "Archestra port")
        loader.add_option("archestra_profile_id", str, "", "LLM Proxy profile ID")
        loader.add_option("anthropic_api_key", str, "", "Anthropic API key")

    def configure(self, updates):
        self.host = ctx.options.archestra_host
        self.port = ctx.options.archestra_port
        self.profile_id = ctx.options.archestra_profile_id
        self.api_key = ctx.options.anthropic_api_key

    # ── Request interception ──────────────────────────────────

    def request(self, flow: http.HTTPFlow) -> None:
        if flow.request.pretty_host != "claude.ai" or flow.request.method != "POST":
            return

        match = COMPLETION_RE.search(flow.request.path)
        if not match:
            return

        if not self.profile_id or not self.api_key:
            ctx.log.error("[archestra] profile_id or api_key not set — passing through")
            return

        conv_id = match.group(1)

        try:
            body = json.loads(flow.request.get_text())
        except (json.JSONDecodeError, ValueError):
            return

        messages = self._build_messages(conv_id, body)
        tools = self._extract_tools(body)
        model = body.get("model", "claude-sonnet-4-5-20250929")

        api_body: dict = {
            "model": model,
            "messages": messages,
            "stream": True,
            "max_tokens": 16384,
        }
        if tools:
            api_body["tools"] = tools

        # Enable extended thinking for models that support it
        api_body["thinking"] = {"type": "enabled", "budget_tokens": 10000}

        # ── Redirect to Archestra ─────────────────────────────
        flow.request.scheme = "http"
        flow.request.host = self.host
        flow.request.port = self.port
        flow.request.path = f"/v1/anthropic/{self.profile_id}/v1/messages"

        # Replace headers with what the Anthropic API expects
        for key in list(flow.request.headers.keys()):
            del flow.request.headers[key]

        flow.request.headers["host"] = f"{self.host}:{self.port}"
        flow.request.headers["x-api-key"] = self.api_key
        flow.request.headers["content-type"] = "application/json"
        flow.request.headers["anthropic-version"] = "2023-06-01"
        flow.request.headers["accept"] = "text/event-stream"

        flow.request.set_text(json.dumps(api_body))

        flow.metadata["archestra"] = True
        flow.metadata["conv_id"] = conv_id
        flow.metadata["parent_uuid"] = body.get("parent_message_uuid", "")

        ctx.log.info(
            f"[archestra] → {model} | {len(messages)} msgs | {len(tools)} tools | conv {conv_id[:8]}"
        )

    # ── Response streaming ────────────────────────────────────

    def responseheaders(self, flow: http.HTTPFlow) -> None:
        if not flow.metadata.get("archestra"):
            return

        if flow.response and flow.response.status_code != 200:
            ctx.log.error(
                f"[archestra] Archestra returned {flow.response.status_code} — "
                "sending error to Claude Desktop"
            )
            # Build an SSE error response that Claude Desktop can parse
            error_body = ""
            try:
                error_body = flow.response.get_text()
            except Exception:
                pass
            self._send_error_sse(flow, f"Archestra error ({flow.response.status_code}): {error_body[:200]}")
            return

        conv_id = flow.metadata["conv_id"]
        parent_uuid = flow.metadata.get("parent_uuid", "")
        msg_uuid = str(uuid_mod.uuid4())

        # Streaming state — shared across chunks via closure
        state = {
            "buf": b"",
            "assistant_blocks": [],   # content blocks for conversation history
            "current_text": "",       # accumulate text_delta
            "current_tool": None,     # current tool_use being built
            "current_tool_input": "", # accumulate input_json_delta
        }

        def transform(chunk: bytes) -> bytes:
            state["buf"] += chunk
            out = b""

            # SSE events are delimited by blank lines (\n\n)
            while b"\n\n" in state["buf"]:
                idx = state["buf"].index(b"\n\n") + 2
                raw_event = state["buf"][:idx]
                state["buf"] = state["buf"][idx:]
                out += self._transform_event(raw_event, conv_id, parent_uuid, msg_uuid, state)

            return out

        flow.response.stream = transform

        # Fix response headers for Claude Desktop
        if flow.response:
            flow.response.headers["content-type"] = "text/event-stream; charset=utf-8"
            flow.response.headers["access-control-allow-credentials"] = "true"
            flow.response.headers["access-control-allow-origin"] = "https://claude.ai"
            flow.response.headers["vary"] = "Origin"
            flow.response.headers["cache-control"] = "no-cache"
            # Remove content-length (incompatible with streaming)
            flow.response.headers.pop("content-length", None)
            # Remove content-encoding (mitmproxy already decompresses)
            flow.response.headers.pop("content-encoding", None)

    # ── Private: message building ─────────────────────────────

    def _build_messages(self, conv_id: str, body: dict) -> list:
        if conv_id not in self.conversations:
            self.conversations[conv_id] = {"messages": [], "pending_assistant": None}

        conv = self.conversations[conv_id]

        # Flush pending assistant message from last turn
        if conv["pending_assistant"]:
            conv["messages"].append(conv["pending_assistant"])
            conv["pending_assistant"] = None

        prompt = body.get("prompt", "")

        # Detect tool-result turn (empty prompt + tool results in body)
        tool_results = body.get("tool_results")
        if tool_results:
            content = []
            for tr in tool_results:
                result_content = tr.get("content", tr.get("output", ""))
                if isinstance(result_content, list):
                    # Already in content-block format
                    pass
                else:
                    result_content = str(result_content)
                content.append({
                    "type": "tool_result",
                    "tool_use_id": tr.get("tool_use_id", ""),
                    "content": result_content,
                })
            conv["messages"].append({"role": "user", "content": content})
        elif prompt:
            conv["messages"].append({"role": "user", "content": prompt})

        return conv["messages"][:]

    def _extract_tools(self, body: dict) -> list:
        tools = []
        for t in body.get("tools", []):
            if "input_schema" in t and "name" in t:
                tools.append({
                    "name": t["name"],
                    "description": t.get("description", ""),
                    "input_schema": t["input_schema"],
                })
        return tools

    # ── Private: SSE event transformation ─────────────────────

    def _transform_event(
        self,
        raw: bytes,
        conv_id: str,
        parent_uuid: str,
        msg_uuid: str,
        state: dict,
    ) -> bytes:
        text = raw.decode("utf-8", errors="replace")
        event_type = ""
        data_str = ""

        for line in text.strip().split("\n"):
            if line.startswith("event: "):
                event_type = line[7:].strip()
            elif line.startswith("data: "):
                data_str = line[6:]

        if not data_str:
            return raw

        try:
            data = json.loads(data_str)
        except json.JSONDecodeError:
            return raw

        now_iso = datetime.now(timezone.utc).isoformat()
        evt_type = data.get("type", "")

        # ── message_start ─────────────────────────────────────
        if evt_type == "message_start":
            msg = data.get("message", {})
            msg["uuid"] = msg_uuid
            msg["parent_uuid"] = parent_uuid
            msg.setdefault("trace_id", msg.get("id", ""))
            msg.setdefault("request_id", msg.get("id", ""))
            msg.pop("usage", None)
            data["message"] = msg

        # ── content_block_start ───────────────────────────────
        elif evt_type == "content_block_start":
            block = data.get("content_block", {})
            block.setdefault("start_timestamp", now_iso)
            block.setdefault("stop_timestamp", None)
            block.setdefault("flags", None)

            btype = block.get("type")
            if btype == "text":
                block.setdefault("citations", [])
                state["current_text"] = ""
            elif btype == "thinking":
                block.setdefault("summaries", [])
                block.setdefault("cut_off", False)
                block.setdefault("alternative_display_type", None)
                block.setdefault("thinking", "")
            elif btype == "tool_use":
                state["current_tool"] = {
                    "type": "tool_use",
                    "id": block.get("id", ""),
                    "name": block.get("name", ""),
                    "input": {},
                }
                state["current_tool_input"] = ""
            data["content_block"] = block

        # ── content_block_delta ───────────────────────────────
        elif evt_type == "content_block_delta":
            delta = data.get("delta", {})
            dtype = delta.get("type")
            if dtype == "text_delta":
                state["current_text"] += delta.get("text", "")
            elif dtype == "input_json_delta":
                state["current_tool_input"] += delta.get("partial_json", "")

        # ── content_block_stop ────────────────────────────────
        elif evt_type == "content_block_stop":
            data["stop_timestamp"] = now_iso

            # Save completed text block for history
            if state["current_text"]:
                state["assistant_blocks"].append({
                    "type": "text",
                    "text": state["current_text"],
                })
                state["current_text"] = ""

            # Save completed tool_use block for history
            if state["current_tool"]:
                try:
                    state["current_tool"]["input"] = json.loads(
                        state["current_tool_input"]
                    ) if state["current_tool_input"] else {}
                except json.JSONDecodeError:
                    state["current_tool"]["input"] = {}

                state["assistant_blocks"].append(state["current_tool"])
                ctx.log.info(
                    f"[archestra] tool_use: {state['current_tool']['name']} "
                    f"(id={state['current_tool']['id'][:12]})"
                )
                state["current_tool"] = None
                state["current_tool_input"] = ""

        # ── message_delta ─────────────────────────────────────
        elif evt_type == "message_delta":
            data.get("delta", {})
            data.pop("usage", None)

        # ── message_stop ──────────────────────────────────────
        elif evt_type == "message_stop":
            # Flush assistant message into conversation history
            if conv_id in self.conversations and state["assistant_blocks"]:
                self.conversations[conv_id]["pending_assistant"] = {
                    "role": "assistant",
                    "content": state["assistant_blocks"][:],
                }

            # Inject message_limit before message_stop
            limit = {
                "type": "message_limit",
                "message_limit": {
                    "type": "within_limit",
                    "resetsAt": None,
                    "remaining": None,
                    "perModelLimit": None,
                    "representativeClaim": "five_hour",
                    "overageStatus": "within_limit",
                    "overageResetsAt": None,
                    "overageInUse": False,
                },
            }
            out = f"event: message_limit\ndata: {json.dumps(limit)}\n\n"
            out += f"event: message_stop\ndata: {json.dumps(data)}\n\n"
            return out.encode("utf-8")

        return f"event: {event_type}\ndata: {json.dumps(data)}\n\n".encode("utf-8")

    def _send_error_sse(self, flow: http.HTTPFlow, error_msg: str) -> None:
        """Replace the response with an SSE stream containing an error message."""
        msg_uuid = str(uuid_mod.uuid4())
        now_iso = datetime.now(timezone.utc).isoformat()

        events = [
            {"event": "message_start", "data": {
                "type": "message_start",
                "message": {
                    "id": f"archestra_err_{msg_uuid[:8]}",
                    "type": "message",
                    "role": "assistant",
                    "uuid": msg_uuid,
                    "parent_uuid": flow.metadata.get("parent_uuid", ""),
                    "model": "",
                    "content": [],
                    "stop_reason": None,
                    "stop_sequence": None,
                },
            }},
            {"event": "content_block_start", "data": {
                "type": "content_block_start",
                "index": 0,
                "content_block": {
                    "type": "text",
                    "text": "",
                    "start_timestamp": now_iso,
                    "stop_timestamp": None,
                    "flags": None,
                    "citations": [],
                },
            }},
            {"event": "content_block_delta", "data": {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": f"⚠️ {error_msg}"},
            }},
            {"event": "content_block_stop", "data": {
                "type": "content_block_stop",
                "index": 0,
                "stop_timestamp": now_iso,
            }},
            {"event": "message_delta", "data": {
                "type": "message_delta",
                "delta": {"stop_reason": "end_turn", "stop_sequence": None},
            }},
            {"event": "message_limit", "data": {
                "type": "message_limit",
                "message_limit": {"type": "within_limit"},
            }},
            {"event": "message_stop", "data": {"type": "message_stop"}},
        ]

        body = ""
        for evt in events:
            body += f"event: {evt['event']}\ndata: {json.dumps(evt['data'])}\n\n"

        flow.response = http.Response.make(
            200,
            body.encode("utf-8"),
            {
                "content-type": "text/event-stream; charset=utf-8",
                "access-control-allow-credentials": "true",
                "access-control-allow-origin": "https://claude.ai",
                "cache-control": "no-cache",
            },
        )


addons = [ArchestraRedirect()]
