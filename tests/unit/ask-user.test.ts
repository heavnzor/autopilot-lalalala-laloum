import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { appendEvent, closeEventLogs, nextSeq, readEvents, resetSeqCache } from "../../plugins/autopilot/mcp/lib/events.ts";
import type { ToolContext } from "../../plugins/autopilot/mcp/lib/tool.ts";
import { toolByName } from "../../plugins/autopilot/mcp/registry.ts";
import { sandboxHome } from "../helpers.ts";

const sandbox = sandboxHome();
after(() => {
  closeEventLogs();
  resetSeqCache();
  sandbox.cleanup();
});
before(() => resetSeqCache());

const askUser = toolByName("ask-user");

/** Aucun canal direct : le tool doit rendre les questions a l'appelant. */
const NO_CHANNEL: ToolContext = {
  canAskHuman: false,
  heartbeat: () => {},
  askHuman: async () => ({ action: "cancel", content: null }),
};

function call(input: Record<string, unknown>) {
  assert.ok(askUser, "le tool ask-user existe");
  return askUser.handler(input, NO_CHANNEL) as Promise<any>;
}

describe("ask-user pose un lot", () => {
  it("rend toutes les questions d'un coup quand aucun canal n'est disponible", async () => {
    const result = await call({
      ticketId: "TJ-500",
      askedBy: "functional-grill",
      questions: [
        { key: "tirage", header: "Tirage", question: "Comment la variante est-elle tiree ?", options: ["hasard", "par utilisateur", "par dossier"] },
        { key: "mesure", header: "Mesure", question: "Qu'est-ce qu'on mesure ?", options: ["temps", "clics", "rien"] },
      ],
    });

    assert.equal(result.transport, "caller");
    assert.equal(result.questions.length, 2);
    assert.deepEqual(result.questions.map((entry: any) => entry.key), ["tirage", "mesure"]);
    // Trois questions posees separement, c'est trois arrets du workflow.
    assert.match(result.note, /ces questions/);
  });

  it("refuse un lot vide", async () => {
    await assert.rejects(() => call({ ticketId: "TJ-501", questions: [] }), /vide/);
  });

  it("refuse une question a option unique : ce n'est pas un choix", async () => {
    await assert.rejects(
      () =>
        call({
          ticketId: "TJ-502",
          questions: [{ key: "k", header: "H", question: "Une seule issue ?", options: ["oui"] }],
        }),
      (error: unknown) => {
        const failure = error as { message: string; hint: string | null };
        assert.match(failure.message, /Une seule option proposee sur : k/);
        // L'indice dit quoi faire, pas seulement ce qui ne va pas.
        assert.match(failure.hint ?? "", /trois ou quatre, ou aucune/);
        return true;
      },
    );
  });

  it("accepte une question sans option : le champ libre suffit", async () => {
    const result = await call({
      ticketId: "TJ-503",
      questions: [{ key: "libre", header: "Libre", question: "Qu'est-ce qui manque au ticket ?" }],
    });
    assert.equal(result.questions[0].options.length, 0);
  });

  it("laisse une trace de la question dans le flux d'events", async () => {
    await call({
      ticketId: "TJ-504",
      askedBy: "technical-grill",
      questions: [
        { key: "a", header: "Index", question: "Faut-il un index sur la colonne de date ?", options: ["oui", "non", "a mesurer"] },
        { key: "b", header: "Volume", question: "Quel volume attendu ?", options: ["moins de 1k", "1k a 100k", "plus"] },
      ],
    });

    const question = readEvents("TJ-504").find((event) => event.kind === "question");
    assert.ok(question, "un event question a ete pousse");
    assert.equal(question.status, "waiting");
    assert.equal(question.agent, "technical-grill");
    // Le titre doit se lire seul dans l'interface.
    assert.match(question.title, /2 questions : Index, Volume/);
  });
});

describe("le compteur de sequence", () => {
  it("reste monotone sans relire le fichier a chaque event", () => {
    resetSeqCache();
    const seqs = Array.from({ length: 50 }, () => {
      const seq = nextSeq("TJ-600");
      appendEvent({
        runId: "r", ticketId: "TJ-600", seq, ts: new Date().toISOString(),
        kind: "tool", status: "ok", repo: null, agent: null, tool: "t", step: null,
        title: "un event de test lisible seul", detail: null, payload: null,
      });
      return seq;
    });

    assert.deepEqual(seqs, Array.from({ length: 50 }, (_, index) => index));
    assert.equal(readEvents("TJ-600").length, 50);
  });

  it("reprend au bon numero apres un redemarrage de process", () => {
    // Le cache tombe, le fichier reste : c'est la situation d'une reprise.
    closeEventLogs();
    resetSeqCache();
    assert.equal(nextSeq("TJ-600"), 50);
  });

  it("compte separement chaque ticket", () => {
    resetSeqCache();
    assert.equal(nextSeq("TJ-601"), 0);
    assert.equal(nextSeq("TJ-602"), 0);
    assert.equal(nextSeq("TJ-601"), 1);
  });
});

// Le transport des questions est teste contre le vrai live-store dans
// live-shell.test.ts ; un faux serveur reimplementant le casier ne prouvait pas
// le comportement du code livre.
