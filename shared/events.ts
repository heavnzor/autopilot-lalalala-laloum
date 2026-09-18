import * as v from "valibot";
import { isJsonValue, type JsonValue } from "./json.ts";

export type { JsonValue } from "./json.ts";
export const LIVE_EVENT_KINDS = ["step", "agent", "tool", "loop", "todo", "question", "answer", "plan", "decision", "escalation", "message"] as const;
export const LIVE_EVENT_STATUSES = ["start", "progress", "ok", "ko", "waiting"] as const;

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const rows = (value: unknown) => Array.isArray(value) && value.every(record);

/** Un contrat unique, partage par le MCP et le navigateur. */
export const LiveEventSchema = v.pipe(v.object({
  runId: v.pipe(v.string(), v.minLength(1)),
  ticketId: v.pipe(v.string(), v.regex(/^[A-Za-z][A-Za-z0-9_]*-\d+(?:-demo)?$/)),
  seq: v.pipe(v.number(), v.integer(), v.minValue(0)),
  ts: v.pipe(v.string(), v.isoTimestamp()),
  kind: v.picklist(LIVE_EVENT_KINDS),
  status: v.picklist(LIVE_EVENT_STATUSES),
  repo: v.nullable(v.string()), agent: v.nullable(v.string()), tool: v.nullable(v.string()),
  step: v.optional(v.nullable(v.string()), null),
  title: v.pipe(v.string(), v.minLength(3), v.maxLength(200)),
  detail: v.nullable(v.string()),
  payload: v.custom<JsonValue>(isJsonValue),
}), v.check((event) => {
  const payload = event.payload;
  if (!record(payload)) return true;
  if (event.kind === "todo" && payload.items !== undefined && !rows(payload.items)) return false;
  if (payload.questions !== undefined && !rows(payload.questions)) return false;
  if (payload.repos !== undefined && !rows(payload.repos)) return false;
  if (payload.commit !== undefined && (!record(payload.commit) || (payload.commit.files !== undefined && !rows(payload.commit.files)))) return false;
  if (payload.check !== undefined && (!record(payload.check) || typeof payload.check.kind !== "string" || typeof payload.check.passed !== "boolean")) return false;
  return true;
}, "Payload incompatible avec les donnees affichees."));

export type LiveEvent = v.InferOutput<typeof LiveEventSchema>;
