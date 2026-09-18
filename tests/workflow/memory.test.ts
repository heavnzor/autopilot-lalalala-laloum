import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Frontmatter } from "../../plugins/autopilot/mcp/lib/memory.ts";
import { createSandbox } from "./harness.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const PERIMEE = {
  path: "repos/fixture-core/conventions-tests.md",
  frontmatter: {
    type: "convention",
    scope: "repo",
    last_verified: "2026-08-01",
    repos: ["fixture-core"],
  } as unknown as Frontmatter,
  body: "Le repo tourne sous vitest.",
};

describe("le cycle memoire", () => {
  it("empile les contradictions pendant le run et les rend au point 11", async () => {
    const sandbox = await createSandbox({ ticket: { key: "TJ-1000", summary: "Corriger une note fausse" }, memory: [PERIMEE] });
    try {
      // Un scout lit la note, puis lit le code, et les deux ne concordent pas.
      const found = await sandbox.call<any>("get-memory", { repos: ["fixture-core"], scope: ["repo"] });
      assert.equal(found.total, 1);
      assert.equal(found.notes[0].path, PERIMEE.path);

      await sandbox.call("contradict-memory", {
        ticketId: "TJ-1000",
        note: PERIMEE.path,
        claim: "Le repo tourne sous vitest",
        evidence: "package.json:4 — node --test",
        raisedBy: "scope-scout",
      });

      const state = await sandbox.call<any>("get-store-ticket", { ticketId: "TJ-1000" });
      assert.equal(state.memory.contradictions.length, 1);
      assert.equal(state.memory.contradictions[0].raisedBy, "scope-scout");
      assert.equal(state.memory.contradictions[0].evidence, "package.json:4 — node --test");
    } finally {
      await sandbox.cleanup();
    }
  });

  it("refuse une contradiction sans preuve localisee", async () => {
    const sandbox = await createSandbox({ ticket: { key: "TJ-1010", summary: "Une impression" }, memory: [PERIMEE] });
    try {
      const refusal = await sandbox.expectFailure("contradict-memory", {
        ticketId: "TJ-1010",
        note: PERIMEE.path,
        claim: "Le repo tourne sous vitest",
        evidence: "il me semble que non",
        raisedBy: "developer",
      });
      assert.match(refusal, /preuve localisee/);
    } finally {
      await sandbox.cleanup();
    }
  });

  it("applique le plan et produit un commit unique, revocable", async () => {
    const sandbox = await createSandbox({ ticket: { key: "TJ-1020", summary: "Capitaliser" }, memory: [PERIMEE] });
    try {
      // L'orchestrateur a ecrit l'etat a chaque transition, bien avant le point 12.
      await sandbox.call("write-store-ticket", {
        ticketId: "TJ-1020",
        patch: { run: { phase: "publication", step: "12" }, scope: [{ name: "fixture-core", status: "done" }] },
      });

      // Le memory-writer applique : une reecriture et une creation.
      await sandbox.call("write-store-ticket", { ticketId: "TJ-1021", patch: { ticket: { title: "Autre run en cours" } } });
      await sandbox.call("write-memory", {
        path: PERIMEE.path,
        frontmatter: { type: "convention", scope: "repo", last_verified: "2026-09-15", repos: ["fixture-core"] },
        body: "Le repo tourne sous le runner de test de node, pas vitest.",
      });
      await sandbox.call("create-memory", {
        path: "features/periode/filtre.md",
        frontmatter: { type: "knowledge", scope: "feature", feature: "periode", last_verified: "2026-09-15" },
        body: "Le filtre par periode borne au mois.",
      });

      const commit = await sandbox.call<any>("commit-memory", { ticketId: "TJ-1020", summary: "Corrige une note perimee." });
      assert.equal(commit.committed, true);
      assert.ok(commit.sha);
      assert.match(commit.revert, /git -C .* revert/);

      const message = git(sandbox.home, ["log", "-1", "--format=%s"]);
      assert.equal(message, "memory: TJ-1020", "un commit unique et identifiable, sinon rien n'est revocable");

      // Le sha est retenu dans l'etat du ticket.
      const state = await sandbox.call<any>("get-store-ticket", { ticketId: "TJ-1020" });
      assert.equal(state.memory.commit, commit.sha);

      // Tout est gitignore sauf memory/ et tickets/.
      const tracked = git(sandbox.home, ["ls-files"]).split("\n");
      assert.ok(tracked.some((file) => file.startsWith("memory/")), tracked.join(" "));
      assert.ok(tracked.some((file) => file.startsWith("tickets/")), tracked.join(" "));
      assert.ok(!tracked.includes("tickets/TJ-1021.yaml"), "un commit memoire ne capture pas l'etat d'un autre ticket");
      assert.ok(!tracked.some((file) => file.startsWith("worktrees/")), "les worktrees ne sont jamais versionnes");
      assert.ok(!tracked.some((file) => file.startsWith("locks/")), "les locks ne sont jamais versionnes");
      assert.ok(existsSync(join(sandbox.home, ".gitignore")));
    } finally {
      await sandbox.cleanup();
    }
  });

  it("ne commite rien quand le plan n'a rien change", async () => {
    const sandbox = await createSandbox({ ticket: { key: "TJ-1030", summary: "Rien a capitaliser" } });
    try {
      const first = await sandbox.call<any>("commit-memory", { ticketId: "TJ-1030" });
      // Le squelette de memoire et l'etat du ticket n'existent pas encore : le
      // premier commit peut etre vide, le second doit l'etre.
      if (first.committed) {
        const second = await sandbox.call<any>("commit-memory", { ticketId: "TJ-1030" });
        assert.equal(second.committed, false);
        assert.match(second.reason, /Aucun changement/);
      } else {
        assert.match(first.reason, /Aucun changement/);
      }
    } finally {
      await sandbox.cleanup();
    }
  });

  it("refuse une note rangee au mauvais niveau", async () => {
    const sandbox = await createSandbox({ ticket: { key: "TJ-1040", summary: "Mauvais niveau" } });
    try {
      const refusal = await sandbox.expectFailure("create-memory", {
        path: "repos/fixture-core/feature.md",
        frontmatter: { type: "knowledge", scope: "feature", last_verified: "2026-09-15" },
        body: "Une feature rangee dans repos/.",
      });
      assert.match(refusal, /rangee sous/);
    } finally {
      await sandbox.cleanup();
    }
  });

  it("refuse une note au-dela de la limite de lignes, pour qu'on la scinde", async () => {
    const sandbox = await createSandbox({ ticket: { key: "TJ-1050", summary: "Note trop longue" } });
    try {
      const refusal = await sandbox.expectFailure("create-memory", {
        path: "features/longue/note.md",
        frontmatter: { type: "knowledge", scope: "feature", last_verified: "2026-09-15" },
        body: Array.from({ length: 120 }, (_, index) => `ligne ${index}`).join("\n"),
      });
      assert.match(refusal, /trop longue/);
      assert.match(refusal, /Scinde-la/);
    } finally {
      await sandbox.cleanup();
    }
  });
});
