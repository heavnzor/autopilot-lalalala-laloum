import { ToolError } from "./errors.ts";
import { setTimeout as delay } from "node:timers/promises";

export interface HttpOptions {
  readonly method?: "GET" | "POST" | "PUT" | "DELETE";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly timeoutMs?: number;
  readonly form?: Readonly<Record<string, string>>;
  /** Codes acceptes en plus de 2xx, quand l'absence est une reponse valable. */
  readonly allow?: readonly number[];
  /** Annulation du workflow, partagee par toutes les tentatives. */
  readonly signal?: AbortSignal;
  /** N'activer pour un POST que si le service garantit son idempotence. */
  readonly retry?: boolean;
}

export interface HttpResponse<T> {
  readonly status: number;
  readonly data: T;
  readonly headers: Headers;
}

export class HttpError extends ToolError {
  readonly status: number | null;
  readonly uncertain: boolean;

  constructor(message: string, hint: string | null, status: number | null, uncertain: boolean) {
    super(message, hint);
    this.status = status;
    this.uncertain = uncertain;
  }
}

/**
 * Un seul client http pour les quatre services.
 *
 * Les lectures peuvent etre rejouees, les creations non. Une reponse perdue
 * apres un POST peut cacher un succes distant : le rejouer dupliquerait l'effet.
 * Le timeout borne l'appel complet, tentatives et attente comprises.
 */
export async function request<T>(url: string, options: HttpOptions = {}): Promise<HttpResponse<T>> {
  const method = options.method ?? "GET";
  const mayRetry = options.retry ?? ["GET", "PUT", "DELETE"].includes(method);
  const attempts = mayRetry ? 3 : 1;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new ToolError("Timeout HTTP invalide.");
  const signal = AbortSignal.any([AbortSignal.timeout(Math.ceil(timeoutMs)), ...(options.signal ? [options.signal] : [])]);
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      signal.throwIfAborted();
      const response = await fetch(url, { ...buildInit(options), signal });
      const text = await response.text();
      const data = parseBody<T>(text, response.headers.get("content-type"));

      if (response.ok || options.allow?.includes(response.status)) {
        return { status: response.status, data, headers: response.headers };
      }
      if (isRetryable(response.status) && attempt < attempts) {
        await delay(backoffMs(attempt, response.headers.get("retry-after")), undefined, { signal });
        continue;
      }
      throw new HttpError(
        `${options.method ?? "GET"} ${redact(url)} a repondu ${response.status}.`,
        text.slice(0, 600) || null,
        response.status,
        method !== "GET" && response.status >= 500,
      );
    } catch (error) {
      if (error instanceof ToolError) throw error;
      lastError = error;
      if (signal.aborted) break;
      if (attempt < attempts) {
        try {
          await delay(backoffMs(attempt, null), undefined, { signal });
        } catch (aborted) {
          lastError = aborted;
          break;
        }
        continue;
      }
    }
  }

  throw new HttpError(
    `${method} ${redact(url)} interrompu ou injoignable.`,
    method === "POST"
      ? "Resultat distant incertain : verifie s'il existe avant de reessayer cette creation."
      : lastError instanceof Error ? lastError.message : null,
    null,
    method !== "GET",
  );
}

function buildInit(options: HttpOptions): RequestInit {
  const headers: Record<string, string> = { accept: "application/json", ...options.headers };
  let body: string | undefined;

  if (options.form) {
    headers["content-type"] = "application/x-www-form-urlencoded; charset=utf-8";
    body = new URLSearchParams(options.form).toString();
  } else if (options.body !== undefined) {
    headers["content-type"] = "application/json; charset=utf-8";
    body = JSON.stringify(options.body);
  }

  return {
    method: options.method ?? "GET",
    headers,
    body,
  };
}

function parseBody<T>(text: string, contentType: string | null): T {
  if (!text) return null as T;
  if (contentType?.includes("json") || text.trimStart().startsWith("{") || text.trimStart().startsWith("[")) {
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }
  return text as T;
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function backoffMs(attempt: number, retryAfter: string | null): number {
  const numeric = retryAfter ? Number(retryAfter) * 1000 : Number.NaN;
  const advertised = Number.isFinite(numeric) ? numeric : retryAfter ? Date.parse(retryAfter) - Date.now() : Number.NaN;
  if (Number.isFinite(advertised) && advertised > 0) return advertised;
  return 400 * 2 ** (attempt - 1);
}

/** Une URL peut porter un jeton en query. Elle ne doit pas finir dans un message. */
export function redact(url: string): string {
  return url.replace(/([?&](token|access_token|private_token)=)[^&]+/gi, "$1<masque>");
}
