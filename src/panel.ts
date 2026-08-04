// Web control panel: replaces the raw-mode terminal UI. Every completion
// request becomes a card in a browser page; the operator fills in plain
// form fields (one box per tool argument) and clicks Send — no hand-typed
// JSON, no keyboard-shortcut menus to get lost in.
import { describeToolChoice, type NormalizedTool, type NormalizedToolChoice, type ToolCallResult } from "./tools";

export interface PromptContext {
  model: string;
  endpoint: string;
  historyLines: string[];
  images: string[];
  tools: NormalizedTool[];
  toolChoice: NormalizedToolChoice;
}

export type OperatorOutcome =
  | { kind: "text"; text: string; thinking: string }
  | { kind: "tool_calls"; calls: ToolCallResult[]; thinking: string };

export interface PendingView extends PromptContext {
  id: string;
  createdAt: number;
  toolChoiceLabel: string;
}

interface PendingRequest {
  id: string;
  ctx: PromptContext;
  createdAt: number;
  resolve: (outcome: OperatorOutcome) => void;
}

const pending = new Map<string, PendingRequest>();
const subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
const encoder = new TextEncoder();

function listPendingViews(): PendingView[] {
  return [...pending.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((p) => ({ id: p.id, createdAt: p.createdAt, toolChoiceLabel: describeToolChoice(p.ctx.toolChoice), ...p.ctx }));
}

function broadcast(): void {
  const frame = encoder.encode(`event: update\ndata: ${JSON.stringify(listPendingViews())}\n\n`);
  for (const controller of subscribers) {
    try {
      controller.enqueue(frame);
    } catch {
      subscribers.delete(controller);
    }
  }
}

/**
 * Precondition: none.
 * Postcondition: registers a card in the panel and resolves once the
 * operator submits a response for it via `resolvePending`. Never rejects —
 * the caller (an in-flight HTTP request) waits as long as it takes.
 */
export function submitPrompt(ctx: PromptContext): Promise<OperatorOutcome> {
  const id = crypto.randomUUID();
  const { promise, resolve } = Promise.withResolvers<OperatorOutcome>();
  pending.set(id, { id, ctx, createdAt: Date.now(), resolve });
  broadcast();
  return promise;
}

/**
 * Precondition: `id` and `body` come straight from an untrusted HTTP POST.
 * Postcondition: on success, resolves the matching pending prompt and
 * returns null; on any validation failure, returns a human-readable error
 * string and leaves the pending request untouched so the operator can retry.
 */
export function resolvePending(id: string, body: unknown): string | null {
  const p = pending.get(id);
  if (!p) return "no pending request with that id (already answered, or the connection dropped)";
  if (!body || typeof body !== "object") return "invalid response body";
  const b = body as Record<string, unknown>;
  const thinking = typeof b.thinking === "string" ? b.thinking : "";

  if (b.kind === "text") {
    if (typeof b.text !== "string") return "'text' is required for a text reply";
    pending.delete(id);
    p.resolve({ kind: "text", text: b.text, thinking });
    broadcast();
    return null;
  }

  if (b.kind === "tool_calls") {
    if (!Array.isArray(b.calls) || b.calls.length === 0) return "'calls' must be a non-empty array";
    const calls: ToolCallResult[] = [];
    for (const raw of b.calls) {
      if (!raw || typeof raw !== "object") return "each call needs a tool name and arguments";
      const c = raw as Record<string, unknown>;
      if (typeof c.name !== "string" || c.name.length === 0) return "each call needs a tool name";
      const argsText = typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments ?? {});
      try {
        JSON.parse(argsText);
      } catch {
        return `arguments for '${c.name}' are not valid JSON`;
      }
      calls.push({ id: `call_${crypto.randomUUID()}`, name: c.name, arguments: argsText });
    }
    pending.delete(id);
    p.resolve({ kind: "tool_calls", calls, thinking });
    broadcast();
    return null;
  }

  return "unknown 'kind' — expected 'text' or 'tool_calls'";
}

export function panelEventStream(): ReadableStream<Uint8Array> {
  let self: ReadableStreamDefaultController<Uint8Array>;
  return new ReadableStream({
    start(controller) {
      self = controller;
      subscribers.add(controller);
      controller.enqueue(encoder.encode(`event: update\ndata: ${JSON.stringify(listPendingViews())}\n\n`));
    },
    cancel() {
      subscribers.delete(self);
    },
  });
}

export function closePanel(): void {
  for (const controller of subscribers) {
    try {
      controller.close();
    } catch {
      // already closed
    }
  }
  subscribers.clear();
}

export const PANEL_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>openai-madeup-endpoint — operator panel</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.45 ui-monospace, "SF Mono", Consolas, monospace; background: #16181d; color: #e6e6e6; }
  #layout { display: grid; grid-template-columns: 300px 1fr; height: 100vh; }
  #sidebar { border-right: 1px solid #2a2d35; overflow-y: auto; background: #14161a; }
  #sidebar h1 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: #8b93a7; padding: 14px 14px 8px; margin: 0; }
  .card-item { padding: 10px 14px; border-bottom: 1px solid #21242c; cursor: pointer; }
  .card-item:hover { background: #1c1f26; }
  .card-item.selected { background: #202742; border-left: 3px solid #5b8cff; }
  .card-item .meta { color: #8b93a7; font-size: 12px; }
  .card-item .preview { margin-top: 4px; color: #cfd3dc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #empty-sidebar, #empty-main { padding: 20px; color: #6b7280; }
  #main { overflow-y: auto; padding: 22px 28px 80px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; background: #2a2d35; color: #b8c0d2; font-size: 12px; margin-left: 8px; }
  .badge.tool-choice { background: #3a2f1a; color: #e0b96b; }
  h2 { margin: 0 0 4px; font-size: 17px; }
  #history { background: #0f1114; border: 1px solid #2a2d35; border-radius: 8px; padding: 12px 14px; margin: 14px 0; max-height: 320px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; }
  #history div { padding: 2px 0; }
  #images { display: flex; flex-wrap: wrap; gap: 10px; margin: 10px 0 20px; }
  #images img { max-width: 220px; max-height: 220px; border-radius: 6px; border: 1px solid #2a2d35; }
  label.field-label { display: block; margin: 14px 0 6px; color: #b8c0d2; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  textarea, input[type=text], input[type=number], select {
    width: 100%; background: #0f1114; color: #e6e6e6; border: 1px solid #333846; border-radius: 6px; padding: 8px 10px; font: inherit;
  }
  textarea { min-height: 70px; resize: vertical; }
  .row { display: flex; gap: 10px; align-items: flex-start; }
  .row > * { flex: 1; }
  button { font: inherit; cursor: pointer; border: none; border-radius: 6px; padding: 8px 14px; background: #2a2d35; color: #e6e6e6; }
  button:hover { background: #343846; }
  button.primary { background: #3457d5; color: #fff; }
  button.primary:hover { background: #4066f0; }
  button.primary:disabled { background: #2a2d35; color: #6b7280; cursor: not-allowed; }
  button.danger { background: #402126; color: #ffb4bb; }
  button.small { padding: 4px 10px; font-size: 12px; }
  section.panel-block { border: 1px solid #2a2d35; border-radius: 8px; padding: 16px; margin: 18px 0; }
  section.panel-block h3 { margin: 0 0 4px; font-size: 14px; }
  section.panel-block .hint { color: #8b93a7; font-size: 12px; margin-bottom: 10px; }
  .tool-picker { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
  .call-card { border: 1px solid #333846; border-radius: 8px; padding: 12px 14px; margin-bottom: 12px; background: #191c22; }
  .call-card .call-head { display: flex; justify-content: space-between; align-items: center; }
  .call-card .call-head strong { font-size: 13px; color: #9fb4ff; }
  .kv-row { display: flex; gap: 8px; margin-bottom: 8px; align-items: center; }
  .kv-row input { flex: 1; }
  .kv-row select { flex: 0 0 90px; }
  .error-line { color: #ff9aa2; font-size: 12px; margin-top: 6px; }
  .field-desc { color: #6b7280; font-size: 11px; margin-top: -2px; margin-bottom: 4px; }
  .field-block { margin-bottom: 10px; }
  .nested-box { border: 1px dashed #333846; border-radius: 6px; padding: 10px 12px; margin-top: 4px; background: #14161c; }
  .array-field { margin-top: 4px; }
  .array-item { display: flex; gap: 8px; align-items: flex-start; border-left: 2px solid #333846; padding: 8px 0 8px 10px; margin-bottom: 8px; }
  .array-item > *:first-child { flex: 1; }
</style>
</head>
<body>
<div id="layout">
  <div id="sidebar">
    <h1>Pending requests</h1>
    <div id="sidebar-list"></div>
  </div>
  <div id="main"><div id="empty-main">Waiting for a request… send anything to any /v1/* endpoint and it'll show up here.</div></div>
</div>
<script>
const state = { items: [], selectedId: null };

const es = new EventSource("/panel/events");
es.addEventListener("update", (e) => {
  state.items = JSON.parse(e.data);
  if (state.selectedId && !state.items.some((it) => it.id === state.selectedId)) state.selectedId = null;
  if (!state.selectedId && state.items.length > 0) state.selectedId = state.items[0].id;
  renderSidebar();
  renderMain();
});

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of children ?? []) node.appendChild(child);
  return node;
}

function renderSidebar() {
  const list = document.getElementById("sidebar-list");
  list.innerHTML = "";
  if (state.items.length === 0) {
    list.appendChild(el("div", { id: "empty-sidebar", text: "Nothing waiting." }));
    return;
  }
  for (const item of state.items) {
    const div = el("div", {
      class: "card-item" + (item.id === state.selectedId ? " selected" : ""),
      onclick: () => { state.selectedId = item.id; renderSidebar(); renderMain(); },
    }, [
      el("div", { class: "meta", text: item.endpoint + " · " + item.model }),
      el("div", { class: "preview", text: item.historyLines[item.historyLines.length - 1] || "(empty)" }),
    ]);
    list.appendChild(div);
  }
}

// Builds one input for a single JSON-schema value. Recurses into nested
// "object" (known properties) and "array" (known item schema) shapes so
// nested JSON never has to be hand-typed — only a schema-less object/array
// leaf falls back to free-form key/value rows (never to a raw JSON blob).
// read() returns { value } | { skip: true } (blank + optional) | { error }.
function buildValueField(schema) {
  if (schema.enum) {
    const select = el("select", {}, [el("option", { value: "", text: "(choose)" })]);
    for (const opt of schema.enum) select.appendChild(el("option", { value: String(opt), text: String(opt) }));
    return { node: select, read: () => (select.value === "" ? { skip: true } : coerce(select.value, schema.type)) };
  }
  if (schema.type === "boolean") {
    const select = el("select", {}, [
      el("option", { value: "", text: "(unset)" }),
      el("option", { value: "true", text: "true" }),
      el("option", { value: "false", text: "false" }),
    ]);
    return { node: select, read: () => (select.value === "" ? { skip: true } : { value: select.value === "true" }) };
  }
  if (schema.type === "number" || schema.type === "integer") {
    const input = el("input", { type: "number", ...(schema.type === "integer" ? { step: "1" } : { step: "any" }) });
    return { node: input, read: () => (input.value === "" ? { skip: true } : coerce(input.value, schema.type)) };
  }
  if (schema.type === "object") {
    if (schema.properties) {
      const built = buildObjectFields(schema.properties, schema.required);
      return { node: el("div", { class: "nested-box" }, [built.node]), read: built.collect };
    }
    const built = buildFreeformFields();
    const box = el("div", { class: "nested-box" }, [el("div", { class: "field-desc", text: "free-form object (no schema)" }), built.node]);
    return { node: box, read: built.collect };
  }
  if (schema.type === "array") {
    return buildArrayField(schema.items ?? { type: "string" });
  }
  const input = el("input", { type: "text" });
  return { node: input, read: () => (input.value === "" ? { skip: true } : { value: input.value }) };
}

function coerce(text, type) {
  if (type === "integer") {
    const n = Number(text);
    return Number.isInteger(n) ? { value: n } : { error: "must be an integer" };
  }
  if (type === "number") {
    const n = Number(text);
    return Number.isFinite(n) ? { value: n } : { error: "must be a number" };
  }
  return { value: text };
}

// Renders one labeled field per property of a JSON-schema object — the core
// "no formatting done by me" building block, reused for the top-level call
// arguments AND for every nested object property found inside them.
function buildObjectFields(properties, requiredKeys) {
  const required = new Set(requiredKeys ?? []);
  const container = el("div", { class: "object-fields" });
  const fields = Object.entries(properties ?? {}).map(([key, schema]) => {
    const isRequired = required.has(key);
    const type = schema.type ? "<" + schema.type + ">" : "";
    const block = el("div", { class: "field-block" });
    block.appendChild(el("label", { class: "field-label", text: key + type + (isRequired ? " (required)" : " (optional)") }));
    if (schema.description) block.appendChild(el("div", { class: "field-desc", text: schema.description }));
    const { node, read } = buildValueField(schema);
    block.appendChild(node);
    container.appendChild(block);
    return { key, isRequired, read };
  });
  return {
    node: container,
    collect() {
      const out = {};
      for (const f of fields) {
        const res = f.read();
        if (res.error) return { error: f.key + ": " + res.error };
        if (res.skip) {
          if (f.isRequired) return { error: f.key + ": required" };
          continue;
        }
        out[f.key] = res.value;
      }
      return { value: out };
    },
  };
}

// A repeatable list of one field per array item, typed by itemSchema -
// including nested objects, so "array of objects" never needs raw JSON
// either. Arrays always yield a value (possibly []), never "skip".
function buildArrayField(itemSchema) {
  const container = el("div", { class: "array-field" });
  const rows = el("div", {});
  container.appendChild(rows);
  const items = [];
  function addItem() {
    const built = buildValueField(itemSchema);
    const row = el("div", { class: "array-item" });
    row.appendChild(built.node);
    row.appendChild(el("button", {
      class: "small danger",
      text: "✕ remove item",
      onclick: () => { row.remove(); items.splice(items.indexOf(entry), 1); },
    }));
    const entry = { read: built.read };
    items.push(entry);
    rows.appendChild(row);
  }
  container.appendChild(el("button", { class: "small", text: "+ add item", onclick: addItem }));
  return {
    node: container,
    read() {
      const out = [];
      for (const it of items) {
        const res = it.read();
        if (res.error) return { error: res.error };
        if (!res.skip) out.push(res.value);
      }
      return { value: out };
    },
  };
}

// A free-form list of key/value rows with a per-row type selector, used
// both as the whole-call fallback (tool has no schema at all) and as the
// fallback for a nested object property that itself has no known shape.
function buildFreeformFields() {
  const wrap = el("div", {});
  const rows = el("div", {});
  wrap.appendChild(rows);
  const rowState = [];
  function addRow() {
    const key = el("input", { type: "text", placeholder: "key" });
    const value = el("input", { type: "text", placeholder: "value" });
    const type = el("select", {}, [
      el("option", { value: "string", text: "string" }),
      el("option", { value: "number", text: "number" }),
      el("option", { value: "boolean", text: "boolean" }),
      el("option", { value: "json", text: "json" }),
    ]);
    const removeBtn = el("button", { class: "small", text: "✕", onclick: () => { row.remove(); rowState.splice(rowState.indexOf(entry), 1); } });
    const row = el("div", { class: "kv-row" }, [key, value, type, removeBtn]);
    const entry = { key, value, type };
    rowState.push(entry);
    rows.appendChild(row);
  }
  wrap.appendChild(el("button", { class: "small", text: "+ add field", onclick: addRow }));
  addRow();
  return {
    node: wrap,
    collect() {
      const out = {};
      for (const { key, value, type } of rowState) {
        const k = key.value.trim();
        if (!k) continue;
        if (type.value === "number") {
          const n = Number(value.value);
          if (!Number.isFinite(n)) return { error: k + ": not a valid number" };
          out[k] = n;
        } else if (type.value === "boolean") {
          out[k] = value.value === "true";
        } else if (type.value === "json") {
          try { out[k] = JSON.parse(value.value); } catch { return { error: k + ": not valid JSON" }; }
        } else {
          out[k] = value.value;
        }
      }
      return { value: out };
    },
  };
}

// A call card for a tool WITH a JSON-schema properties object.
function buildSchemaCall(tool) {
  const card = el("div", { class: "call-card" });
  const built = buildObjectFields(tool.parameters?.properties ?? {}, tool.parameters?.required);
  card.appendChild(built.node);
  return { node: card, collect: built.collect };
}

// A call card for a tool with NO schema (or an empty schema).
function buildFreeformCall() {
  const card = el("div", { class: "call-card" });
  card.appendChild(el("label", { class: "field-label", text: "arguments (no schema provided)" }));
  const built = buildFreeformFields();
  card.appendChild(built.node);
  return { node: card, collect: built.collect };
}

function renderMain() {
  const main = document.getElementById("main");
  main.innerHTML = "";
  const item = state.items.find((it) => it.id === state.selectedId);
  if (!item) {
    main.appendChild(el("div", { id: "empty-main", text: "Waiting for a request… send anything to any /v1/* endpoint and it'll show up here." }));
    return;
  }

  main.appendChild(el("h2", {}, [document.createTextNode(item.endpoint + " ")]));
  const badges = el("div", {}, [
    el("span", { class: "badge", text: "model: " + item.model }),
  ]);
  if (item.tools.length > 0) badges.appendChild(el("span", { class: "badge tool-choice", text: "tool_choice: " + item.toolChoiceLabel }));
  main.appendChild(badges);

  const history = el("div", { id: "history" });
  for (const line of item.historyLines) history.appendChild(el("div", { text: line }));
  main.appendChild(history);

  if (item.images.length > 0) {
    const gallery = el("div", { id: "images" });
    for (const url of item.images) gallery.appendChild(el("img", { src: url, alt: "attached image" }));
    main.appendChild(gallery);
  }

  const thinking = el("textarea", { placeholder: "optional reasoning / thinking trace shown to the client as reasoning_content" });
  main.appendChild(el("label", { class: "field-label", text: "reasoning trace (optional)" }));
  main.appendChild(thinking);

  const errorLine = el("div", { class: "error-line" });

  function send(body) {
    errorLine.textContent = "";
    fetch("/panel/pending/" + item.id + "/respond", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(async (res) => {
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        errorLine.textContent = data.error || ("HTTP " + res.status);
      }
    }).catch((err) => { errorLine.textContent = String(err); });
  }

  // --- plain text reply — always available, regardless of tool_choice ---
  const textSection = el("section", { class: "panel-block" }, [
    el("h3", { text: "Reply with text" }),
  ]);
  if (item.tools.length > 0 && item.toolChoiceLabel === "required") {
    textSection.appendChild(el("div", { class: "hint", text: "tool_choice is 'required', but you can still send plain text if that's what you need to test." }));
  }
  const textArea = el("textarea", { placeholder: "assistant reply text" });
  textSection.appendChild(textArea);
  textSection.appendChild(el("button", {
    class: "primary",
    text: "Send text reply",
    onclick: () => send({ kind: "text", text: textArea.value, thinking: thinking.value }),
  }));
  main.appendChild(textSection);

  // --- tool calls — only offered when the request actually supplied tools ---
  if (item.tools.length > 0 && item.toolChoiceLabel !== "none") {
    const toolSection = el("section", { class: "panel-block" }, [
      el("h3", { text: "Call tool(s) instead" }),
      el("div", { class: "hint", text: "Pick a tool to add a call card, fill in its fields, then send. You can add more than one for parallel calls." }),
    ]);
    const picker = el("div", { class: "tool-picker" });
    const cardsHost = el("div", {});
    const cards = [];
    const sendCallsBtn = el("button", { class: "primary", text: "Send 0 call(s)", disabled: "true" });

    function refreshSendLabel() {
      sendCallsBtn.textContent = "Send " + cards.length + " call(s)";
      sendCallsBtn.disabled = cards.length === 0;
    }

    const forcedName = item.toolChoiceLabel.startsWith("forced:") ? item.toolChoiceLabel.slice("forced:".length) : null;
    const pickable = forcedName ? item.tools.filter((t) => t.name === forcedName) : item.tools;
    for (const tool of pickable) {
      picker.appendChild(el("button", {
        text: "+ " + tool.name,
        onclick: () => {
          const hasSchema = tool.parameters && Object.keys(tool.parameters.properties ?? {}).length > 0;
          const built = hasSchema ? buildSchemaCall(tool) : buildFreeformCall();
          const head = el("div", { class: "call-head" }, [
            el("strong", { text: tool.name }),
            el("button", { class: "small danger", text: "remove", onclick: () => { built.node.remove(); cards.splice(cards.indexOf(entry), 1); refreshSendLabel(); } }),
          ]);
          built.node.insertBefore(head, built.node.firstChild);
          const entry = { name: tool.name, collect: built.collect };
          cards.push(entry);
          cardsHost.appendChild(built.node);
          refreshSendLabel();
        },
      }));
    }
    if (forcedName) toolSection.appendChild(el("div", { class: "hint", text: "tool_choice forces '" + forcedName + "' — that's the only tool offered here, but plain text above still works if you want to break the contract on purpose." }));

    sendCallsBtn.addEventListener("click", () => {
      const calls = [];
      for (const c of cards) {
        const res = c.collect();
        if (res.error) { errorLine.textContent = c.name + ": " + res.error; return; }
        calls.push({ name: c.name, arguments: res.value });
      }
      send({ kind: "tool_calls", calls, thinking: thinking.value });
    });

    toolSection.appendChild(picker);
    toolSection.appendChild(cardsHost);
    toolSection.appendChild(sendCallsBtn);
    main.appendChild(toolSection);
  }

  main.appendChild(errorLine);
}

renderSidebar();
renderMain();
</script>
</body>
</html>
`;
