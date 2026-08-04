// Fake OpenAI-style model catalog. Names are made up — no real OpenAI models.
export interface FakeModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

const CREATED = 1_700_000_000; // fixed fake epoch so listings are stable across restarts

const MODEL_IDS = [
  "glimmer-4",
  "glimmer-4-mini",
  "cascade-2.5-turbo",
  "cascade-2.5-turbo-instruct",
  "nebulon-1",
  "nebulon-1-vision",
  "quartzmind-xl",
  "quartzmind-lite",
  "driftwood-3",
  "emberlynx-1.2",
] as const;

export type ModelId = (typeof MODEL_IDS)[number];

export const MODELS: FakeModel[] = MODEL_IDS.map((id, i) => ({
  id,
  object: "model",
  created: CREATED + i * 86400,
  owned_by: "openai-madeup",
}));

export const MODEL_IDS_SET: Set<string> = new Set(MODEL_IDS);
