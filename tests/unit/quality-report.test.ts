import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { containerNeedsOf, findRepo, reportPathFor } from "../../plugins/autopilot/mcp/lib/config.ts";
import { toolByName } from "../../plugins/autopilot/mcp/registry.ts";
import { sandboxHome, sandboxProject, useProjectConfig } from "../helpers.ts";

/**
 * Un lint rouge dont la sortie est vide.
 *
 * `biome ci --reporter=gitlab > code-quality.json` sort en echec sans ecrire une
 * ligne : le diagnostic est dans un fichier. Sur FT-1042, un agent a passe deux
 * heures a le chercher a la main avant d'etre tue. Le registre dit ou le
 * rapport atterrit, et le tool le lit.
 *
 * Le mecanisme se teste sur un registre de fixture, pas sur le registre reel :
 * quel repo en a besoin depend des commandes du moment — `web-app` est passe de
 * `biome:ci`, qui redirige, a `biome:lint`, qui parle sur stdout, et n'en a
 * plus besoin. Un test accroche a ce choix-la casserait a chaque arbitrage
 * d'outillage amont, sans rien dire du mecanisme.
 */

const noopContext = {
  canAskHuman: false,
  heartbeat: () => {},
  askHuman: async () => ({ action: "decline" as const, content: null }),
};

const REGISTRY = `schemaVersion: 1

repositories:
  - name: front-fixture
    level: 1
    path: ~/rien
    gitlabProject: fixture/front
    baseBranch: main
    layer: front
    packageManager: pnpm
    monorepoTool: turbo
    packageName: null
    dependsOn: []
    commands:
      lint: "false"
      typecheck: null
      ut: null
      it: null
      ft: null
      ct: null
      e2e: null
    reports:
      lint: "{apps,packages}/*/code-quality.json"
    withoutTests: true
    ciJobsToWatch: []
    description: Fixture dont le lint redirige son rapport dans un fichier.
    keywords: [fixture]

  - name: back-fixture
    level: 1
    path: ~/rien
    gitlabProject: fixture/back
    baseBranch: main
    layer: backend
    packageManager: npm
    monorepoTool: null
    packageName: null
    dependsOn: []
    commands:
      lint: "false"
      typecheck: null
      ut: null
      it: null
      ft: null
      ct: null
      e2e: null
    ciJobsToWatch: []
    description: Fixture dont le lint parle sur sa sortie, comme eslint.
    withoutTests: true
    keywords: [fixture]

  - name: docker-fixture
    level: 1
    path: ~/rien
    gitlabProject: fixture/docker
    baseBranch: main
    layer: backend
    packageManager: npm
    monorepoTool: null
    packageName: null
    dependsOn: []
    commands:
      lint: null
      typecheck: null
      ut: "true"
      it: null
      ft: null
      ct: null
      e2e: null
    containers:
      required: true
      images: [redis:7-alpine, postgres:16-alpine]
    ciJobsToWatch: []
    description: Fixture dont la suite a besoin d'une machine debout.
    keywords: [fixture]

evalOnly:
  repos: []
  jiraProjects: []
`;

describe("le rapport d'une commande qui n'ecrit pas sur sa sortie", () => {
  let project: ReturnType<typeof sandboxProject>;
  let home: ReturnType<typeof sandboxHome>;

  before(() => {
    home = sandboxHome();
    project = sandboxProject({ registry: REGISTRY });
  });
  after(() => {
    project.cleanup();
    home.cleanup();
    useProjectConfig();
  });

  it("n'est lu que pour un repo qui en declare un", () => {
    assert.equal(reportPathFor(findRepo("front-fixture"), "lint"), "{apps,packages}/*/code-quality.json");
    // Un lint qui parle sur stdout n'a rien a declarer : c'est le cas courant.
    assert.equal(reportPathFor(findRepo("back-fixture"), "lint"), null);
  });

  it("remonte les diagnostics du fichier quand la commande echoue", async () => {
    const worktree = join(home.home, "worktrees", "TJ-1", "front-fixture");
    mkdirSync(join(worktree, "apps", "lab"), { recursive: true });
    writeFileSync(
      join(worktree, "apps", "lab", "code-quality.json"),
      JSON.stringify([
        {
          description: "This hook does not specify its dependency on setResponsibleId.",
          check_name: "lint/correctness/useExhaustiveDependencies",
          severity: "major",
          location: { path: "src/components/LabHeaderActions.spec.tsx", lines: { begin: 162 } },
        },
      ]),
      "utf8",
    );

    const lint = toolByName("run-lint");
    assert.ok(lint);
    const output = (await lint.handler({ ticketId: "TJ-1", repo: "front-fixture" }, noopContext)) as {
      passed: boolean;
      stdout: string;
      report?: { total: number; from: string[]; diagnostics: { file: string; line: number; rule: string }[] };
    };

    assert.equal(output.passed, false);
    assert.equal(output.stdout.trim(), "", "la commande de fixture ne doit rien ecrire, c'est tout l'interet");
    assert.ok(output.report, "le diagnostic du fichier n'a pas ete remonte");
    assert.equal(output.report.total, 1);
    assert.deepEqual(output.report.from, ["apps/lab/code-quality.json"]);
    assert.equal(output.report.diagnostics[0]?.line, 162);
    assert.match(output.report.diagnostics[0]?.rule ?? "", /useExhaustiveDependencies/);
  });

  it("ne remonte rien plutot que de deviner, quand le fichier n'est pas du format attendu", async () => {
    const worktree = join(home.home, "worktrees", "TJ-2", "front-fixture");
    mkdirSync(join(worktree, "apps", "web"), { recursive: true });
    writeFileSync(join(worktree, "apps", "web", "code-quality.json"), "pas du json", "utf8");

    const lint = toolByName("run-lint");
    assert.ok(lint);
    const output = (await lint.handler({ ticketId: "TJ-2", repo: "front-fixture" }, noopContext)) as {
      report?: unknown;
    };
    assert.equal(output.report, undefined);
  });

  it("ne cherche aucun fichier pour un repo qui n'en declare pas", async () => {
    const worktree = join(home.home, "worktrees", "TJ-3", "back-fixture");
    mkdirSync(worktree, { recursive: true });

    const lint = toolByName("run-lint");
    assert.ok(lint);
    const output = (await lint.handler({ ticketId: "TJ-3", repo: "back-fixture" }, noopContext)) as {
      passed: boolean;
      report?: unknown;
    };
    assert.equal(output.passed, false);
    assert.equal(output.report, undefined);
  });
});

describe("les besoins de conteneurs", () => {
  let project: ReturnType<typeof sandboxProject>;

  before(() => {
    project = sandboxProject({ registry: REGISTRY });
  });
  after(() => {
    project.cleanup();
    useProjectConfig();
  });

  it("sont declares, jamais deduits d'un docker-compose trouve au hasard", () => {
    const avecMachine = containerNeedsOf(findRepo("docker-fixture"));
    assert.equal(avecMachine.required, true);
    assert.deepEqual([...avecMachine.images], ["redis:7-alpine", "postgres:16-alpine"]);

    // Un repo qui n'a rien a monter n'a pas la cle, et c'est le cas courant.
    const sansMachine = containerNeedsOf(findRepo("front-fixture"));
    assert.equal(sansMachine.required, false);
    assert.equal(sansMachine.images.length, 0);
  });

  it("laissent passer sans rien verifier un repo qui n'en declare aucun", async () => {
    const sandbox = sandboxHome(project.root);
    try {
      mkdirSync(join(sandbox.home, "worktrees", "TJ-4", "front-fixture"), { recursive: true });

      const preflight = toolByName("preflight-repo");
      assert.ok(preflight);
      const output = (await preflight.handler({ ticketId: "TJ-4", repo: "front-fixture" }, noopContext)) as {
        ready: boolean;
        containers: { required: boolean };
      };

      assert.equal(output.ready, true);
      assert.equal(output.containers.required, false);
    } finally {
      sandbox.cleanup();
    }
  });
});
