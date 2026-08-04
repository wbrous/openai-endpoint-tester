// Raw-keypress terminal UI the human operator drives to answer every
// request: free-form text, an optional "thinking" trace, or one-or-more
// tool calls picked from an arrow-key menu (opened by pressing Tab).
//
// Requests are served strictly FIFO — only one prompt is on-screen and
// readable at a time, queued behind any prompt already in flight.
import { emitKeypressEvents, type Key } from "node:readline";
import { renderImageInline } from "./images";
import { describeToolChoice, type NormalizedTool, type NormalizedToolChoice, type ToolCallResult } from "./tools";

const isTty = Boolean(process.stdin.isTTY);

interface KeyEvent {
  str: string | undefined;
  key: Key;
}

const keyQueue: KeyEvent[] = [];
const keyWaiters: Array<(ev: KeyEvent) => void> = [];

function initRawInput(): void {
  emitKeypressEvents(process.stdin);
  if (isTty) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("keypress", (str: string | undefined, key: Key) => {
    const ev: KeyEvent = { str, key };
    const waiter = keyWaiters.shift();
    if (waiter) waiter(ev);
    else keyQueue.push(ev);
  });
}
initRawInput();

function nextKey(): Promise<KeyEvent> {
  const queued = keyQueue.shift();
  if (queued) return Promise.resolve(queued);
  const { promise, resolve } = Promise.withResolvers<KeyEvent>();
  keyWaiters.push(resolve);
  return promise;
}

function exitOnCtrlC(key: Key): void {
  if (key?.ctrl && key.name === "c") {
    closeInteractive();
    process.exit(0);
  }
}

interface LineResult {
  text: string;
  tab: boolean;
}

// Reads one line with manual echo (raw mode disables terminal echo).
// `allowTab`: an empty buffer + Tab press short-circuits with `{ tab: true }`
// instead of inserting a literal tab, signaling "open the tool menu".
async function readLineRaw(promptStr: string, allowTab: boolean): Promise<LineResult> {
  process.stdout.write(promptStr);
  let buf = "";
  for (;;) {
    const { str, key } = await nextKey();
    exitOnCtrlC(key);
    if (key?.name === "return" || key?.name === "enter") {
      process.stdout.write("\n");
      return { text: buf, tab: false };
    }
    if (allowTab && key?.name === "tab" && buf.length === 0) {
      return { text: "", tab: true };
    }
    if (key?.name === "backspace") {
      if (buf.length > 0) {
        buf = buf.slice(0, -1);
        process.stdout.write("\b \b");
      }
      continue;
    }
    if (str && !key?.ctrl && !key?.meta && key?.name !== "tab" && key?.name !== "escape") {
      buf += str;
      process.stdout.write(str);
    }
  }
}

interface MultilineResult {
  text: string;
  tab: boolean;
}

// Reads lines until one contains only ".", joining with "\n". `allowTab`
// only applies to the very first line (an empty buffer at that point).
async function readMultiline(firstPrompt: string, allowTab: boolean): Promise<MultilineResult> {
  const lines: string[] = [];
  for (;;) {
    const label = lines.length === 0 ? firstPrompt : ". > ";
    const { text, tab } = await readLineRaw(label, allowTab && lines.length === 0);
    if (tab) return { text: "", tab: true };
    if (text === ".") break;
    lines.push(text);
  }
  return { text: lines.join("\n"), tab: false };
}

interface MenuItem {
  label: string;
}

// Arrow-key (Up/Down) menu; Enter selects, Escape cancels when allowed.
async function selectMenu(items: MenuItem[], allowEscape: boolean): Promise<number | null> {
  let selected = 0;
  let firstRender = true;
  const render = () => {
    if (!firstRender) process.stdout.write(`\x1b[${items.length}A`);
    firstRender = false;
    for (const [i, item] of items.entries()) {
      process.stdout.write("\x1b[2K\r");
      const marker = i === selected ? "\x1b[36m➤ " : "  ";
      process.stdout.write(`${marker}${item.label}\x1b[0m\n`);
    }
  };
  render();
  for (;;) {
    const { key } = await nextKey();
    exitOnCtrlC(key);
    if (key?.name === "up") selected = (selected - 1 + items.length) % items.length;
    else if (key?.name === "down") selected = (selected + 1) % items.length;
    else if (key?.name === "return" || key?.name === "enter") {
      render();
      return selected;
    } else if (key?.name === "escape" && allowEscape) {
      render();
      return null;
    }
    render();
  }
}

function coerceValue(text: string, type: string | undefined): { value?: unknown; error?: string } {
  switch (type) {
    case "number":
    case "integer": {
      const n = Number(text);
      if (Number.isNaN(n)) return { error: "not a number, try again" };
      return { value: type === "integer" ? Math.trunc(n) : n };
    }
    case "boolean": {
      const t = text.trim().toLowerCase();
      if (["true", "yes", "y", "1"].includes(t)) return { value: true };
      if (["false", "no", "n", "0"].includes(t)) return { value: false };
      return { error: "expected true/false, try again" };
    }
    case "array":
    case "object": {
      try {
        return { value: JSON.parse(text) };
      } catch {
        return { error: "invalid JSON, try again" };
      }
    }
    default:
      return { value: text };
  }
}

async function collectRawJsonArgs(toolName: string): Promise<string> {
  for (;;) {
    console.log(`Arguments for ${toolName} — raw JSON, no schema provided. End with "." (empty = {})`);
    const { text } = await readMultiline("> ", false);
    const raw = text.trim();
    if (raw === "") return "{}";
    try {
      JSON.parse(raw);
      return raw;
    } catch {
      console.log("Invalid JSON, try again.");
    }
  }
}

async function collectSchemaArgs(tool: NormalizedTool): Promise<string> {
  const props = tool.parameters?.properties;
  if (!props || Object.keys(props).length === 0) return collectRawJsonArgs(tool.name);

  const required = new Set(tool.parameters?.required ?? []);
  const result: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(props)) {
    const isRequired = required.has(key);
    const hint = schema.enum ? ` [${schema.enum.join("|")}]` : "";
    const type = schema.type ? `<${schema.type}>` : "";
    const desc = schema.description ? ` — ${schema.description}` : "";
    const optionalNote = isRequired ? "" : " (optional, blank=skip)";
    for (;;) {
      const { text } = await readLineRaw(`  ${key}${type}${hint}${optionalNote}${desc}\n  > `, false);
      if (text === "") {
        if (isRequired) {
          console.log("  required, cannot be blank.");
          continue;
        }
        break;
      }
      const coerced = coerceValue(text, schema.type);
      if (coerced.error) {
        console.log(`  ${coerced.error}`);
        continue;
      }
      result[key] = coerced.value;
      break;
    }
  }
  return JSON.stringify(result);
}

async function collectToolArgs(tool: NormalizedTool): Promise<string> {
  return tool.parameters ? collectSchemaArgs(tool) : collectRawJsonArgs(tool.name);
}

type MenuLoopResult = { kind: "calls"; calls: ToolCallResult[] } | { kind: "text"; text: string };

async function runToolMenuLoop(tools: NormalizedTool[], allowEscapeToText: boolean): Promise<MenuLoopResult> {
  const calls: ToolCallResult[] = [];
  for (;;) {
    const items: MenuItem[] = tools.map((t) => ({ label: `${t.name}${t.description ? ` — ${t.description}` : ""}` }));
    if (calls.length > 0) items.push({ label: `✅ Done — submit ${calls.length} call(s)` });
    const idx = await selectMenu(items, allowEscapeToText && calls.length === 0);
    if (idx === null) {
      const { text } = await readMultiline("> ", false);
      return { kind: "text", text };
    }
    if (calls.length > 0 && idx === items.length - 1) return { kind: "calls", calls };
    const tool = tools[idx];
    const args = await collectToolArgs(tool);
    calls.push({ id: `call_${crypto.randomUUID()}`, name: tool.name, arguments: args });
    console.log(`  added call: ${tool.name}(${args})`);
  }
}

async function collectThinking(): Promise<string> {
  console.log('Thinking / reasoning trace (optional). End with "." on its own line (immediate "." = skip).');
  const { text } = await readMultiline("think> ", false);
  return text;
}

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

let queueTail: Promise<void> = Promise.resolve();

async function queued<T>(fn: () => Promise<T>): Promise<T> {
  const myTurn = queueTail;
  const { promise: nextTail, resolve } = Promise.withResolvers<void>();
  queueTail = nextTail;
  await myTurn;
  try {
    return await fn();
  } finally {
    resolve();
  }
}

function printHeader(ctx: PromptContext): void {
  console.log("\n" + "─".repeat(70));
  console.log(`[${ctx.endpoint}] model=${ctx.model}`);
  for (const line of ctx.historyLines) console.log(line);
  if (ctx.tools.length > 0) {
    console.log(`tools: ${ctx.tools.map((t) => t.name).join(", ")} (tool_choice=${describeToolChoice(ctx.toolChoice)})`);
  }
}

export async function promptOperator(ctx: PromptContext): Promise<OperatorOutcome> {
  return queued(async () => {
    printHeader(ctx);
    for (const url of ctx.images) await renderImageInline(url);

    const thinking = await collectThinking();

    const toolsAvailable = ctx.tools.length > 0 && ctx.toolChoice.kind !== "none";

    if (!toolsAvailable) {
      const { text } = await readMultiline("> ", false);
      return { kind: "text", text, thinking };
    }

    if (ctx.toolChoice.kind === "forced") {
      const forcedName = ctx.toolChoice.name;
      const tool = ctx.tools.find((t) => t.name === forcedName);
      if (!tool) {
        console.log(`forced tool '${forcedName}' not found in tools list — falling back to text.`);
        const { text } = await readMultiline("> ", false);
        return { kind: "text", text, thinking };
      }
      console.log(`tool_choice forces '${tool.name}'.`);
      const args = await collectToolArgs(tool);
      return { kind: "tool_calls", calls: [{ id: `call_${crypto.randomUUID()}`, name: tool.name, arguments: args }], thinking };
    }

    if (ctx.toolChoice.kind === "required") {
      const res = await runToolMenuLoop(ctx.tools, false);
      if (res.kind === "text") return { kind: "text", text: res.text, thinking };
      return { kind: "tool_calls", calls: res.calls, thinking };
    }

    console.log(`(${ctx.tools.length} tool(s) available — press Tab at the start of your reply to open the tool menu)`);
    const res = await readMultiline("> ", true);
    if (res.tab) {
      const menuRes = await runToolMenuLoop(ctx.tools, true);
      if (menuRes.kind === "text") return { kind: "text", text: menuRes.text, thinking };
      return { kind: "tool_calls", calls: menuRes.calls, thinking };
    }
    return { kind: "text", text: res.text, thinking };
  });
}

export function closeInteractive(): void {
  if (isTty) process.stdin.setRawMode(false);
  process.stdin.pause();
}
