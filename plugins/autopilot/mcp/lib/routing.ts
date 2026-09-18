import { findRepo, loadConfig, orderByLevel } from "./config.ts";
import { fail } from "./errors.ts";
import { readReceipt, receiptPath } from "./receipts.ts";
import { patchTicketState, type Json } from "./store.ts";
import { assertVerifiedRevision } from "./verification.ts";
import { assertApprovedPlan, assertChecklists, assertUpstreamReady, scopeNames, workflowState, type WorkflowState } from "./workflow.ts";

export const OUTCOMES = ["pass", "retry", "scaffold", "tests-added", "tests-corrected", "dispute", "dispute-refused", "environment", "arbitrage"] as const;
export type Outcome = typeof OUTCOMES[number];
const REVIEW_LOOPS: Record<string, string> = { "10.2": "testAdversary", "10.3": "redChecker", "10.5": "greenChecker", "10.6": "codeAdversary" };
const RETRIES: Record<string, string> = { "10.2": "10.1", "10.3": "10.1", "10.5": "10.4", "10.6": "10.4" };
const ACTORS: Record<string, string> = { "1": "get-ticket", "2": "get-figma-components", "3": "doc-scout", "4": "functional-grill", "5": "scope-scout", "6": "doc-scout", "7": "technical-grill", "8": "planner", "9": "ask-plan-approval", "10.1": "test-writer", "10.2": "test-adversary", "10.3": "red-checker", "10.4": "developer", "10.5": "green-checker", "10.6": "code-adversary", "10.7": "push-tag", "11": "memory-planner", "12": "memory-writer", "13": "finalizer" };

/** Les agents rendent un verdict ; les transitions et les compteurs sont du code. */
export async function advanceWorkflow(ticketId: string, expectedStep: string, outcome: Outcome, testId?: string) {
  const state = workflowState(ticketId);
  const from = String(state.run.step);
  if (from !== expectedStep) fail("Le curseur a deja change : transition refusee.", "Relis get-store-ticket ; ne rejoue pas le verdict sur une autre etape.");
  const name = typeof state.run.currentRepo === "string" ? state.run.currentRepo : null;
  const entry = state.scope.find((row) => (row.name ?? row.repo) === name);
  const budgets = loadConfig().budgets as unknown as Record<string, number>;
  const loops = (entry?.loops ?? {}) as Record<string, number>;
  const patch: Record<string, Json> = {};
  const escalate = (cause: string, reason: string) => {
    const next = patchTicketState(ticketId, { ...patch, run: { phase: "escalated", escalation: { at: new Date().toISOString(), step: from, repo: name, cause, reason } }, metrics: { humanInterventions: { __increment: 1 } } }, { step: from, repo: name });
    return { from, next: from, agent: "human", escalated: true, reason, state: next };
  };
  if (state.run.escalation) fail("Le run est escalade.", "Resous le blocage avant de reprendre son curseur.");
  if (outcome === "environment" || outcome === "arbitrage") return escalate(outcome, `Arret au point ${from} : ${outcome}.`);
  if (from.startsWith("10.") && !entry) fail("Le cycle d'implementation exige un depot courant du scope.");

  let to: string;
  let nextRepo = name;
  if (from.startsWith("10.")) assertApprovedPlan(ticketId);
  const loop = REVIEW_LOOPS[from];
  if (loop && ["pass", "retry"].includes(outcome)) {
    const count = (loops[loop] ?? 0) + 1;
    if (count > (budgets[loop] ?? 0)) return escalate("convergence", `Budget ${loop} atteint.`);
    patch.scope = [{ name: name as string, loops: { [loop]: { __increment: 1 } } }];
    if (outcome === "retry" && count >= (budgets[loop] ?? 0)) return escalate("convergence", `Budget ${loop} epuise sans convergence.`);
  }
  if (outcome === "retry" && RETRIES[from]) {
    to = RETRIES[from] as string;
  } else if (from === "10.3" && outcome === "scaffold") {
    const count = (loops.testDispute ?? 0) + 1;
    if (count > (budgets.testDispute ?? 0)) return escalate("convergence", "La preparation de l'interface n'a pas converge.");
    patch.scope = [{ name: name as string, loops: { testDispute: { __increment: 1 } } }];
    patch.run = { scaffoldOnly: true };
    to = "10.4";
  } else if (from === "10.4" && (outcome === "tests-added" || outcome === "dispute")) {
    const count = (loops.testDispute ?? 0) + 1;
    if (count > (budgets.testDispute ?? 0)) return escalate("convergence", "Budget de recours sur les tests atteint.");
    const row: Record<string, Json> = { name: name as string, loops: { testDispute: { __increment: 1 } } };
    if (outcome === "dispute") {
      if (!testId?.trim()) fail("Un test conteste demande son identifiant.");
      const disputes = Array.isArray(entry?.disputes) ? entry.disputes as Record<string, Json>[] : [];
      const previous = disputes.find((item) => item.test === testId);
      const contested = Number(previous?.count ?? 0) + 1;
      row.disputes = [{ test: testId, count: contested }];
      patch.scope = [row];
      if (contested >= (budgets.disputeBeforeEscalation ?? 2)) return escalate("convergence", `Le test ${testId} a ete conteste ${contested} fois.`);
    }
    patch.scope = [row];
    to = "10.1";
  } else if (from === "10.1" && outcome === "dispute-refused") {
    to = "10.4";
  } else if (from === "10.1" && outcome === "tests-corrected") {
    to = "10.2";
    patch.run = { correctedTests: true };
  } else if (outcome === "pass") {
    if (/^[1-8]$/.test(from)) to = String(Number(from) + 1);
    else if (from === "9") {
      assertApprovedPlan(ticketId);
      const next = firstPending(state);
      if (!next) fail("Aucun depot a implementer dans le plan approuve.");
      to = "10.1";
      nextRepo = next;
    } else if (from === "10.1") { to = "10.2"; patch.run = { correctedTests: false }; }
    else if (from === "10.2") to = state.run.correctedTests ? "10.4" : "10.3";
    else if (from === "10.3") to = "10.4";
    else if (from === "10.4") {
      to = state.run.scaffoldOnly ? "10.3" : "10.5";
      patch.run = { scaffoldOnly: false };
    }
    else if (from === "10.5") {
      await assertVerifiedRevision(ticketId, findRepo(name as string));
      to = "10.6";
    } else if (from === "10.6" || from === "10.7") {
      assertChecklists(state, findRepo(name as string), true);
      const sha = await assertVerifiedRevision(ticketId, findRepo(name as string));
      if (from === "10.6" && scopeNames(state).some((repo) => findRepo(repo).dependsOn.includes(name as string))) to = "10.7";
      else {
        if (from === "10.7") {
          assertUpstreamReady(ticketId, name as string);
          const published = readReceipt<{ sha: string; tag: string }>(receiptPath(ticketId, name as string, "upstream.json"));
          const ci = readReceipt<{ sha: string; tag: string; passed: boolean }>(receiptPath(ticketId, name as string, "upstream-ci.json"));
          if (!published || !ci?.passed || ci.sha !== sha || published.sha !== sha || published.tag !== ci.tag) fail("La publication amont n'a pas de preuve CI pour ce commit.");
        }
        patch.scope = [...(Array.isArray(patch.scope) ? patch.scope : []), { name: name as string, status: "done" }];
        nextRepo = firstPending(state, name as string);
        to = nextRepo ? "10.1" : "11";
      }
    } else if (from === "11") to = "12";
    else if (from === "12") to = "13";
    else fail(`Le point ${from} ne s'avance pas automatiquement.`);
  } else fail(`Le verdict ${outcome} n'est pas valable au point ${from}.`);

  const phase = Number(to) < 10 ? "cadrage" : to.startsWith("10.") ? "implementation" : to === "13" ? "publication" : "capitalisation";
  patch.run = { ...(patch.run as Record<string, Json> ?? {}), step: to, phase, currentRepo: nextRepo };
  if (to === "10.1" && nextRepo) patch.scope = [...(Array.isArray(patch.scope) ? patch.scope : []), { name: nextRepo, status: "in-progress" }];
  const next = patchTicketState(ticketId, patch, { step: from, repo: name });
  return { from, next: to, repo: nextRepo, agent: ACTORS[to] ?? null, mode: (patch.run as Record<string, Json>).scaffoldOnly ? "scaffold" : null, escalated: false, state: next };
}

function firstPending(state: WorkflowState, completed?: string): string | null {
  const unfinished = scopeNames(state).filter((name) => name !== completed && state.scope.find((row) => (row.name ?? row.repo) === name)?.status !== "done");
  return orderByLevel(unfinished.map((name) => findRepo(name)))[0]?.name ?? null;
}
