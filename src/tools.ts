// Normalizes OpenAI's two divergent tool-definition shapes:
//   Chat Completions: { type: "function", function: { name, description, parameters } }
//   Responses API:     { type: "function", name, description, parameters }
// Only "function" tools are actionable by a human operator; other tool types
// (web_search, file_search, code_interpreter, computer_use, ...) are listed
// as unsupported rather than silently dropped.

export interface JsonSchemaProp {
  type?: string;
  description?: string;
  enum?: unknown[];
}

export interface JsonSchemaObject {
  type?: string;
  properties?: Record<string, JsonSchemaProp>;
  required?: string[];
}

export interface NormalizedTool {
  name: string;
  description: string;
  parameters: JsonSchemaObject | null;
}

export interface UnsupportedTool {
  rawType: string;
}

export interface ToolSet {
  functions: NormalizedTool[];
  unsupported: UnsupportedTool[];
}

export function normalizeTools(raw: unknown): ToolSet {
  const functions: NormalizedTool[] = [];
  const unsupported: UnsupportedTool[] = [];
  if (!Array.isArray(raw)) return { functions, unsupported };
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const tool = entry as Record<string, unknown>;
    if (tool.type !== "function") {
      unsupported.push({ rawType: typeof tool.type === "string" ? tool.type : "unknown" });
      continue;
    }
    // Chat Completions nests fields under `function`; Responses API flattens them.
    const fn = (tool.function ?? tool) as Record<string, unknown>;
    if (typeof fn.name !== "string" || fn.name.length === 0) continue;
    functions.push({
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : "",
      parameters: (fn.parameters as JsonSchemaObject | undefined) ?? null,
    });
  }
  return { functions, unsupported };
}

export type NormalizedToolChoice =
  | { kind: "auto" }
  | { kind: "none" }
  | { kind: "required" }
  | { kind: "forced"; name: string };

export function normalizeToolChoice(raw: unknown): NormalizedToolChoice {
  if (raw === undefined || raw === "auto") return { kind: "auto" };
  if (raw === "none") return { kind: "none" };
  if (raw === "required") return { kind: "required" };
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const fn = obj.function as Record<string, unknown> | undefined;
    const name = (fn?.name ?? obj.name) as unknown;
    if (typeof name === "string") return { kind: "forced", name };
  }
  return { kind: "auto" };
}

export function describeToolChoice(choice: NormalizedToolChoice): string {
  switch (choice.kind) {
    case "auto":
      return "auto";
    case "none":
      return "none";
    case "required":
      return "required";
    case "forced":
      return `forced:${choice.name}`;
  }
}

export interface ToolCallResult {
  id: string;
  name: string;
  arguments: string;
}
