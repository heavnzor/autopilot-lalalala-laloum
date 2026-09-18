import { loadConfig } from "./config.ts";
import { optionalSecret, secret } from "./env.ts";
import { fail } from "./errors.ts";
import { request } from "./http.ts";

export interface MergeRequest {
  readonly iid: number;
  readonly title: string;
  readonly web_url: string;
  readonly source_branch: string;
  readonly target_branch: string;
  readonly draft: boolean;
  readonly description: string;
}

export interface Pipeline {
  readonly id: number;
  readonly status: string;
  readonly web_url: string;
  readonly ref: string;
  readonly sha: string;
}

export interface Job {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly web_url: string;
}

function base(): string {
  const host = optionalSecret("GITLAB_HOST") ?? "https://gitlab.com";
  return `${host.replace(/\/+$/, "")}/api/v4`;
}

function headers(): Record<string, string> {
  return { "private-token": secret("GITLAB_TOKEN") };
}

function project(path: string): string {
  return encodeURIComponent(path);
}

export async function getBranch(projectPath: string, branch: string): Promise<unknown> {
  const { status, data } = await request<unknown>(
    `${base()}/projects/${project(projectPath)}/repository/branches/${encodeURIComponent(branch)}`,
    { headers: headers(), allow: [404] },
  );
  return status === 404 ? null : data;
}

export async function getMergeRequest(projectPath: string, iid: number): Promise<MergeRequest | null> {
  const { status, data } = await request<MergeRequest>(
    `${base()}/projects/${project(projectPath)}/merge_requests/${iid}`,
    { headers: headers(), allow: [404] },
  );
  return status === 404 ? null : data;
}

export async function findMergeRequestForBranch(projectPath: string, branch: string): Promise<MergeRequest | null> {
  const { data } = await request<MergeRequest[]>(
    `${base()}/projects/${project(projectPath)}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}`,
    { headers: headers() },
  );
  return Array.isArray(data) ? (data[0] ?? null) : null;
}

export async function createMergeRequest(input: {
  projectPath: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
}): Promise<MergeRequest> {
  const title = loadConfig().gitlab.mrDraft && !input.title.startsWith("Draft: ") ? `Draft: ${input.title}` : input.title;
  const existing = await findMergeRequestForBranch(input.projectPath, input.sourceBranch);
  if (existing) return updateMergeRequest(input.projectPath, existing.iid, { title, description: input.description });

  const { data } = await request<MergeRequest>(`${base()}/projects/${project(input.projectPath)}/merge_requests`, {
    method: "POST",
    headers: headers(),
    body: {
      source_branch: input.sourceBranch,
      target_branch: input.targetBranch,
      title,
      description: input.description,
      remove_source_branch: true,
      squash: false,
    },
  });
  return data;
}

export async function updateMergeRequest(
  projectPath: string,
  iid: number,
  patch: Readonly<Record<string, unknown>>,
): Promise<MergeRequest> {
  const { data } = await request<MergeRequest>(`${base()}/projects/${project(projectPath)}/merge_requests/${iid}`, {
    method: "PUT",
    headers: headers(),
    body: patch,
  });
  return data;
}

export async function listNotes(projectPath: string, iid: number): Promise<unknown[]> {
  return pages(`${base()}/projects/${project(projectPath)}/merge_requests/${iid}/notes`);
}

export async function createNote(projectPath: string, iid: number, body: string): Promise<unknown> {
  const { data } = await request<unknown>(
    `${base()}/projects/${project(projectPath)}/merge_requests/${iid}/notes`,
    { method: "POST", headers: headers(), body: { body } },
  );
  return data;
}

export async function createTag(projectPath: string, tag: string, ref: string, message: string): Promise<unknown> {
  const { data } = await request<unknown>(`${base()}/projects/${project(projectPath)}/repository/tags`, {
    method: "POST",
    headers: headers(),
    body: { tag_name: tag, ref, message },
  });
  return data;
}

export async function listTags(projectPath: string): Promise<string[]> {
  return (await pages<{ name: string }>(`${base()}/projects/${project(projectPath)}/repository/tags`)).map((tag) => tag.name);
}

export async function latestPipeline(projectPath: string, ref: string, signal?: AbortSignal): Promise<Pipeline | null> {
  const { data } = await request<Pipeline[]>(
    `${base()}/projects/${project(projectPath)}/pipelines?ref=${encodeURIComponent(ref)}&per_page=1&order_by=id&sort=desc`,
    { headers: headers(), signal },
  );
  return Array.isArray(data) ? (data[0] ?? null) : null;
}

export async function pipelineJobs(projectPath: string, pipelineId: number, signal?: AbortSignal): Promise<Job[]> {
  return pages(`${base()}/projects/${project(projectPath)}/pipelines/${pipelineId}/jobs`, signal);
}

async function pages<T>(url: string, signal?: AbortSignal): Promise<T[]> {
  const entries: T[] = [];
  for (let page = 1; page <= 1_000; page += 1) {
    const response = await request<T[]>(`${url}?per_page=100&page=${page}`, { headers: headers(), signal });
    if (!Array.isArray(response.data)) fail("Reponse GitLab invalide : liste attendue.");
    entries.push(...response.data);
    const next = response.headers.get("x-next-page");
    if (next === "" || (next === null && response.data.length < 100)) return entries;
    if (next !== null && Number(next) !== page + 1) fail("Pagination GitLab incoherente.");
  }
  return fail("Limite de pagination GitLab atteinte ; resultat incomplet refuse.");
}

export type WatchVerdict = "success" | "failed" | "timeout" | "no-pipeline";

export interface WatchResult {
  readonly verdict: WatchVerdict;
  readonly pipeline: Pipeline | null;
  readonly jobs: { name: string; status: string }[];
  readonly waitedSeconds: number;
  readonly missingJobs?: readonly string[];
  readonly reason?: string;
}

/**
 * Suit les jobs declares dans `ciJobsToWatch`, et eux seuls.
 *
 * Un pipeline « en echec » a cause d'un job de deploiement facultatif ne doit
 * pas bloquer un bump amont ; inversement, un pipeline « vert » dont le job de
 * publication n'a pas tourne ne prouve rien. Le verdict porte donc sur les jobs
 * nommes dans le registre, pas sur le statut global.
 */
export async function watchPipeline(input: {
  projectPath: string;
  ref: string;
  jobs: readonly string[];
  timeoutSeconds: number;
  pollSeconds?: number;
  expectedSha?: string;
  onProgress?: (message: string) => void;
}): Promise<WatchResult> {
  if (!Number.isFinite(input.timeoutSeconds) || input.timeoutSeconds <= 0) fail("Timeout CI invalide.");
  if (!Number.isFinite(input.pollSeconds ?? 15) || (input.pollSeconds ?? 15) <= 0) fail("Intervalle CI invalide.");
  if (input.expectedSha && !/^[a-f0-9]{7,40}$/i.test(input.expectedSha)) fail("SHA attendu invalide.");
  if (input.jobs.some((name) => !name.trim()) || new Set(input.jobs).size !== input.jobs.length) fail("Jobs CI vides ou dupliques.");
  const started = Date.now();
  const poll = (input.pollSeconds ?? 15) * 1000;
  const deadline = started + input.timeoutSeconds * 1000;
  const signal = AbortSignal.timeout(Math.ceil(input.timeoutSeconds * 1000));
  let observed: Pipeline | null = null;
  let summary: { name: string; status: string }[] = [];
  let missing: string[] = [...input.jobs];

  while (Date.now() < deadline) {
    let pipeline: Pipeline | null;
    let jobs: Job[] = [];
    try {
      input.onProgress?.(`CI ${input.ref} — ${elapsed(started)}s`);
      pipeline = await latestPipeline(input.projectPath, input.ref, signal);
      if (pipeline && (!input.expectedSha || pipeline.sha.startsWith(input.expectedSha))) {
        observed = pipeline;
        jobs = await pipelineJobs(input.projectPath, pipeline.id, signal);
      } else pipeline = null;
    } catch (error) {
      if (signal.aborted) break;
      throw error;
    }
    if (pipeline) {
      const watched = input.jobs.length
        ? jobs.filter((job) => input.jobs.includes(job.name))
        : jobs;
      summary = watched.map((job) => ({ name: job.name, status: job.status }));
      missing = input.jobs.filter((name) => !watched.some((job) => job.name === name));

      if (watched.some((job) => ["failed", "canceled", "skipped", "manual"].includes(job.status))) {
        return { verdict: "failed", pipeline, jobs: summary, missingJobs: missing, waitedSeconds: elapsed(started), reason: "Un job requis est en echec, annule, ignore ou attend une action manuelle." };
      }
      const settled = missing.length === 0 && watched.length > 0 && watched.every((job) => job.status === "success");
      if (settled) {
        return { verdict: "success", pipeline, jobs: summary, waitedSeconds: elapsed(started) };
      }
      if (["success", "failed", "canceled", "skipped"].includes(pipeline.status) && missing.length > 0) {
        return { verdict: "failed", pipeline, jobs: summary, missingJobs: missing, waitedSeconds: elapsed(started), reason: "Le pipeline termine ne contient pas tous les jobs requis." };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(poll, deadline - Date.now()))));
  }

  if (!observed) return { verdict: "no-pipeline", pipeline: null, jobs: [], waitedSeconds: elapsed(started), reason: "Aucun pipeline correspondant a la ref et au SHA attendus." };
  return { verdict: "timeout", pipeline: observed, jobs: summary, missingJobs: missing, waitedSeconds: elapsed(started) };
}

export function assertProjectPath(path: string): string {
  if (!path || !path.includes("/")) fail(`Chemin de projet GitLab invalide : ${path}.`);
  return path;
}

function elapsed(started: number): number {
  return Math.round((Date.now() - started) / 1000);
}
