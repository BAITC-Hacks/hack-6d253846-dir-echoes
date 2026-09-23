export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type ReviewedLanguage = "ru" | "kk" | "tr";
/** Normalized BCP 47 base code; external values must pass normalizeLanguageCode. */
export type SpokenLanguage = string;
export type Language = ReviewedLanguage | "mixed" | "other";
export type ReplyTone = "neutral" | "calm" | "reassuring";
export type Role = "participant" | "supervisor";
export type Scenario = {
  scenario_id: string; slug: string; name: string; description: string;
  domain: string; category: string; priority: "normal" | "high" | "urgent";
  fast_path_eligible: boolean; requires_identification: boolean;
  slots: { required: string[]; optional: string[] }; actions: string[];
  requires_confirmation: boolean; handoff: { when: string; queue: string } | null;
  not_this_if: { condition: string; use_instead: string }[];
  examples: { ru: string[]; kk: string[] };
  responses: Record<"ru" | "kk", { opening: string; closing: string }>;
};
export type SlotDefinition = { name: string; type: string; description: string; pattern?: string; values?: Json[]; prompt: { ru: string; kk: string } };
export type ActionDefinition = { name: string; description: string; inputs: string[]; outputs: string[]; errors: string[]; irreversible: boolean };
export type Dataset = {
  version: string; hash: string; businessDate: string;
  scenarios: Scenario[]; systemIntents: JsonObject[]; slots: SlotDefinition[];
  actions: ActionDefinition[]; queues: string[]; knowledge: JsonObject;
  backend: JsonObject;
};
export type ScenarioChoice = { scenarioId: string; confidence: number; reason: string };
export type RoutingDecision = {
  scenarios: ScenarioChoice[]; alternatives: ScenarioChoice[];
  /** Social contact is distinct from a failed attempt to understand a business request. */
  utteranceKind?: "greeting" | "request" | "answer";
  language: Language; slots: JsonObject; isContinuation: boolean;
  responseLanguage?: Language; tone?: ReplyTone;
  inputLanguages?: SpokenLanguage[]; responseLanguages?: SpokenLanguage[];
  confirmation: "confirm" | "reject" | "none";
  reason: string; clarification: string | null;
};
export type ActionResult = { name: string; status: "read" | "preview" | "executed" | "queued" | "failed"; data: JsonObject; error?: { code: string; message: string } };
export type PendingOperation = { id: string; scenarioId: string; actionNames: string[]; slots: JsonObject; summary: string; createdAt: string };
export type DialogueState = {
  language: Language; activeScenarioId: string | null;
  responseLanguages?: SpokenLanguage[];
  pendingScenarioIds: string[]; suspendedScenarioIds: string[];
  completedScenarioIds: string[]; slots: JsonObject; slotsByScenario: Record<string, JsonObject>;
  clientId: string | null; pendingConfirmation: PendingOperation | null;
  unclearCount: number; lastQuestionSlot: string | null; lookupFailures: number;
  status: "active" | "handoff" | "closed";
};
export type Timings = { stt: number | null; router: number; executor: number; response: number; serverTotal: number; ttsFirstByte?: number; playback?: number; ttsCacheHit?: boolean; lastPlaybackCached?: boolean };
export type Trace = {
  scenarios: ScenarioChoice[]; alternatives: ScenarioChoice[]; reason: string;
  language: Language; slots: JsonObject; actions: ActionResult[];
  responseLanguage?: Language; tone?: ReplyTone;
  inputLanguages?: SpokenLanguage[]; responseLanguages?: SpokenLanguage[];
  timings: Timings; catalogHash: string; model: string;
  usage: { inputTokens: number; outputTokens: number; estimatedUsd: number };
  source: "llm" | "confirmation" | "slot" | "catalog_example" | "social" | "operator"; warnings: string[];
};
export type Turn = { id: string; sessionId: string; requestId: string; userText: string; assistantText: string; createdAt: string; trace: Trace; mode: "text" | "voice" | "operator" };
export type PresencePhase = "listening" | "processing" | "replying";
export type SessionLive = { active: true; phase: PresencePhase; lastSeenAt: string; expiresAt: string };
export type Session = { id: string; title: string; createdAt: string; updatedAt: string; state: DialogueState; version: number; turnCount: number; live?: SessionLive | null };
export type SessionDetail = { session: Session; turns: Turn[]; handoffs?: Handoff[] };
export type Handoff = { id: string; sessionId: string; queue: string; reason: string; summary: string; status: "waiting" | "active" | "closed"; createdAt: string; updatedAt: string };
export type ChatEntry = { role: "user" | "assistant"; content: string };
export interface EntityStore {
  list(kind: string): Promise<JsonObject[]>;
  get(kind: string, id: string): Promise<JsonObject | null>;
  put(kind: string, id: string, value: JsonObject): Promise<void>;
}
export type ExecuteInput = { dataset: Dataset; state: DialogueState; decision: RoutingDecision; text: string; store: EntityStore; sessionId: string; requestId: string };
export type ExecuteOutput = { state: DialogueState; actions: ActionResult[]; reply: string; facts: JsonObject; handoff?: { queue: string; reason: string }; warnings: string[] };
export type RouterOutput = { decision: RoutingDecision; model: string; source?: "llm" | "confirmation" | "slot" | "catalog_example" | "social"; elapsedMs: number; inputTokens: number; outputTokens: number; estimatedUsd: number };
