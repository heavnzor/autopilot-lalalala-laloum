import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEvent, type LiveEvent } from "../../tools/live-shell/src/lib/event.ts";
import { answer, ask, askPlan, collect, decide, ingest } from "../../tools/live-shell/src/lib/live-store.ts";
import { derive, runMark } from "../../tools/live-shell/src/lib/use-live-run.ts";
import { EMPTY_TICKET } from "../../tools/live-shell/src/lib/ticket.ts";

const event = (step: string, seq = 0, repo = "core"): LiveEvent => ({
  runId: "run", ticketId: "TJ-1", seq, ts: new Date().toISOString(), kind: "step", status: "progress",
  repo, agent: null, tool: null, step, title: "Progression du travail", detail: null, payload: null,
});

describe("le suivi affiche le curseur reel, y compris ses retours", () => {
  it("repasse en 10.1 quand un second depot commence", () => {
    assert.equal(derive([event("10.7"), event("10.1", 1, "app")], "10.1").step, "10.1");
  });
  it("revient au cadrage apres un rejet du plan", () => {
    assert.equal(derive([event("9")], "4").step, "4");
  });
  it("ne termine pas le run au premier succes partiel du finalizer", () => {
    const current = { ...event("13"), status: "ok" as const };
    assert.equal(runMark(EMPTY_TICKET, "13", current, null), "running");
    assert.equal(runMark({ ...EMPTY_TICKET, run: { ...EMPTY_TICKET.run, phase: "done" } }, "13", current, null), "done");
  });
  it("un plan en attente reste bloquant meme si un event de progression arrive", () => {
    const plan = { id: "p", repos: [], note: null, askedBy: null, askedAt: new Date().toISOString(), answerable: true };
    assert.equal(runMark(EMPTY_TICKET, "9", event("9"), null, plan), "human");
  });
  it("refuse les payloads qui feraient planter le rendu", () => {
    assert.equal(parseEvent({ ...event("10.4"), payload: { commit: { files: 42 } } }), null);
    assert.equal(parseEvent({ ...event("10.4"), payload: { value: new Date() } }), null);
  });
  it("isole les events du ticket de cette fenetre", () => {
    assert.equal(ingest(event("1")).accepted, true);
    assert.equal(ingest({ ...event("1", 1), ticketId: "TJ-2" }).accepted, false);
  });
});

describe("le vrai casier du live shell conserve les reponses", () => {
  it("la reponse survit a une premiere releve dont la reponse reseau est perdue", () => {
    const question = ask({ id: "review-q1", askedBy: null, questions: [{ key: "k", header: "Choix", question: "Quelle periode ?", options: ["mois", "annee"] }] });
    assert.equal(collect(question.id).status, "pending");
    assert.equal(answer(question.id, { k: "mois" }).delivered, true);
    const first = collect(question.id);
    assert.deepEqual(first, { status: "answered", answers: { k: "mois" } });
    assert.deepEqual(collect(question.id), first);
    ask({ id: question.id, askedBy: null, questions: question.questions });
    assert.deepEqual(collect(question.id), first, "redeposer le lot ne doit pas effacer sa reponse");
  });
  it("la decision du gate est elle aussi relevee de facon idempotente", () => {
    const plan = askPlan({ id: "review-p1", repos: [], note: null, askedBy: null });
    assert.equal(decide(plan.id, { verdict: "approve", note: "" }).delivered, true);
    const first = collect(plan.id);
    assert.equal(first.decision?.verdict, "approve");
    assert.deepEqual(collect(plan.id), first);
  });
  it("refuse un lot incomplet ou une valeur non textuelle", () => {
    const question = ask({ id: "review-q2", askedBy: null, questions: [{ key: "k", header: "Choix", question: "Quelle periode ?", options: [] }] });
    assert.equal(answer(question.id, {}).delivered, false);
    assert.equal(answer(question.id, { k: 42 } as any).delivered, false);
  });
});
