import { createHash } from "node:crypto";
import { findRepo, isRepoEligible, orderByLevel, type RepoEntry } from "./config.ts";
import { fail } from "./errors.ts";
import { readReceipt, receiptPath, writeReceipt } from "./receipts.ts";
import { patchTicketState, readTicketState, type Json } from "./store.ts";
import { assertVerifiedRevision } from "./verification.ts";

type Row = Record<string, Json>;
export interface WorkflowState {
  ticket: Row;
  run: Row;
  plan: Row;
  scope: Row[];
  arbitrages: Row;
  publication: Row;
}

export function workflowState(ticketId: string): WorkflowState {
  const state = readTicketState(ticketId);
  if (!state || typeof state !== "object" || Array.isArray(state)) fail(`Aucun run pour ${ticketId}.`);
  return state as unknown as WorkflowState;
}

export function scopeNames(state: WorkflowState): string[] {
  return state.scope.map((entry) => String(entry.name ?? entry.repo ?? ""));
}

/** Les resultats peuvent changer ; le contrat approuve ne le peut pas. */
export function planFingerprint(state: WorkflowState): string {
  const checklists = (state.plan.checklists ?? {}) as Row;
  const definitions = (value: Json | undefined) => (Array.isArray(value) ? value : []).map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("Ligne de checklist invalide.");
    return Object.fromEntries(Object.entries(entry).filter(([key]) => !["status", "result", "evidence", "verdict", "at", "actual"].includes(key)));
  });
  return fingerprint({
    ticket: state.ticket,
    arbitrages: state.arbitrages,
    scope: scopeNames(state),
    registry: scopeNames(state).map((name) => findRepo(name)),
    plan: { content: state.plan.content, repos: state.plan.repos, tests: definitions(checklists.tests), code: definitions(checklists.code) },
  });
}

export function fingerprint(value: unknown): string {
  const canonical = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(canonical);
    if (entry && typeof entry === "object") return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
    return entry;
  };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function assertPlanReady(ticketId: string): WorkflowState {
  const state = workflowState(ticketId);
  const names = scopeNames(state);
  if (names.length === 0 || new Set(names).size !== names.length) fail("Un plan doit avoir un scope non vide et sans doublon.");
  const repos = names.map((name) => findRepo(name));
  for (const repo of repos) if (!isRepoEligible(repo, ticketId)) fail(`${repo.name} n'est pas eligible pour ${ticketId}.`);
  const planned = Array.isArray(state.plan.repos) ? state.plan.repos as Row[] : [];
  const ordered = orderByLevel(repos).map((repo) => repo.name);
  if (JSON.stringify(planned.map((entry) => entry.repo)) !== JSON.stringify(ordered)) {
    fail("Le plan doit couvrir exactement le scope, dans l'ordre du registre.");
  }
  for (const repo of repos) assertChecklists(state, repo, false);
  return state;
}

export function recordPlanApproval(ticketId: string, expectedFingerprint: string, transport: string): void {
  const state = assertPlanReady(ticketId);
  if (planFingerprint(state) !== expectedFingerprint) fail("Le plan a change pendant son approbation.", "Soumets sa nouvelle version au meme gate.");
  const at = new Date().toISOString();
  writeReceipt(receiptPath(ticketId, "approval.json"), { at, fingerprint: expectedFingerprint, transport });
  patchTicketState(ticketId, { plan: { approvedAt: at } });
}

export function assertApprovedPlan(ticketId: string): WorkflowState {
  const state = assertPlanReady(ticketId);
  const approval = readReceipt<{ at: string; fingerprint: string }>(receiptPath(ticketId, "approval.json"));
  if (!approval || state.plan.approvedAt !== approval.at || approval.fingerprint !== planFingerprint(state)) {
    fail("Le plan courant n'a pas d'approbation humaine valide.", "Appelle ask-plan-approval via le live shell ou l'elicitation MCP. Ecrire approvedAt ne constitue pas une approbation.");
  }
  if (state.run.phase === "escalated" || state.run.escalation) fail("Le run est escalade : publication interdite.");
  return state;
}

export function assertPublicationReady(ticketId: string, name?: string): WorkflowState {
  const state = assertApprovedPlan(ticketId);
  if (String(state.run.step) !== "13") fail("La publication finale n'est autorisee qu'au point 13.");
  if (name && !scopeNames(state).includes(name)) fail(`${name} n'appartient pas au scope approuve.`);
  for (const entry of state.scope) {
    const repo = findRepo(String(entry.name ?? entry.repo));
    if (entry.status !== "done") fail(`${repo.name} n'est pas termine : publication interdite.`);
    assertChecklists(state, repo, true);
  }
  return state;
}

export async function assertFinalAction(ticketId: string, name?: string): Promise<WorkflowState> {
  const state = assertPublicationReady(ticketId, name);
  for (const repo of scopeNames(state)) await assertVerifiedRevision(ticketId, findRepo(repo));
  return state;
}

export async function assertTicketChannel(ticketId: string, channelId: string): Promise<void> {
  await assertFinalAction(ticketId);
  const channel = readReceipt<{ id: string }>(receiptPath(ticketId, "slack-channel.json"));
  if (!channel || channel.id !== channelId) fail("Ce canal Slack n'appartient pas a la publication du ticket.");
}

export async function assertTicketMr(ticketId: string, repo: string, iid: number): Promise<void> {
  await assertFinalAction(ticketId, repo);
  const mr = readReceipt<{ iid: number }>(receiptPath(ticketId, repo, "mr.json"));
  if (!mr || mr.iid !== iid) fail("Cette MR n'appartient pas a la publication du ticket.");
}

export function assertUpstreamReady(ticketId: string, name: string): WorkflowState {
  const state = assertApprovedPlan(ticketId);
  if (String(state.run.step) !== "10.7" || state.run.currentRepo !== name) fail("Un tag amont se publie au point 10.7 du depot courant.");
  const names = scopeNames(state);
  if (!names.includes(name) || !names.some((other) => findRepo(other).dependsOn.includes(name))) {
    fail(`${name} n'a pas de consommateur aval dans le scope approuve.`);
  }
  assertChecklists(state, findRepo(name), true);
  return state;
}

export function assertChecklists(state: WorkflowState, repo: RepoEntry, requirePassed: boolean): void {
  const checklists = (state.plan.checklists ?? {}) as Row;
  for (const kind of ["tests", "code"]) {
    const rows = Array.isArray(checklists[kind]) ? checklists[kind] as Row[] : [];
    const relevant = rows.filter((row) => row.repo === repo.name || (!row.repo && state.scope.length === 1));
    if (relevant.length === 0 && (kind === "code" || !repo.withoutTests)) fail(`Checklist ${kind} absente pour ${repo.name}.`);
    for (const row of relevant) {
      if (typeof row.id !== "string" || !row.id || typeof row.criterion !== "string" || !row.criterion.trim()) fail(`Checklist ${kind} invalide pour ${repo.name}.`);
      if (requirePassed && row.status !== "passed") fail(`Checklist ${kind} non validee pour ${repo.name} : ${row.id}.`);
    }
  }
}
