import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { nextDevVersion } from "../../plugins/autopilot/mcp/lib/naming.ts";
import { openRepo, prepareUpstream } from "./cycle.ts";
import { createSandbox, type Sandbox } from "./harness.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function remoteTags(remote: string): string[] {
  const output = git(remote, ["tag", "--list"]);
  return output ? output.split("\n").map((line) => line.trim()) : [];
}

/** Le bump de l'aval : ici un fichier de versions, ailleurs un package.json. */
function bump(worktree: string, packageName: string, version: string): void {
  const path = join(worktree, "deps.json");
  const deps = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  deps[packageName] = version;
  writeFileSync(path, `${JSON.stringify(deps, null, 2)}\n`, "utf8");
}

async function publishUpstream(
  sandbox: Sandbox,
  ticketId: string,
  version: string,
): Promise<{ verdict: string; tag: string }> {
  await prepareUpstream(sandbox, ticketId);
  // 1. poser le tag et le pousser — seule ecriture distante avant le point 13
  await sandbox.call("push-tag", { ticketId, repo: "fixture-core", tag: version, message: `${version} (${ticketId})` });

  // 2. suivre les jobs du registre jusqu'au vert
  sandbox.gitlab.pipelineVerdicts.set(version, {
    jobs: [
      { name: "build", status: "success" },
      { name: "test", status: "success" },
    ],
  });
  const watch = await sandbox.call<{ verdict: string }>("watch-gitlab-pipeline", {
    repo: "fixture-core",
    ref: version,
    timeoutSeconds: 10,
    pollSeconds: 1,
  });

  return { verdict: watch.verdict, tag: version };
}

describe("scenario 3 — publication amont, dans l'ordre", () => {
  it("pose le tag, attend le pipeline, puis seulement bumpe l'aval", async () => {
    const sandbox = await createSandbox({ ticket: { key: "TJ-400", summary: "Publier l'amont" } });
    try {
      const core = await openRepo(sandbox, { ticketId: "TJ-400", repo: "fixture-core", title: "Publier l'amont" });
      const app = await openRepo(sandbox, { ticketId: "TJ-400", repo: "fixture-app", title: "Publier l'amont" });

      const coreRemote = sandbox.repo("fixture-core").remote;
      const version = nextDevVersion("v1.0.0", "TJ-400", remoteTags(coreRemote));
      assert.equal(version, "v1.0.0-TJ-400-1");

      const published = await publishUpstream(sandbox, "TJ-400", version);
      assert.equal(published.verdict, "success");

      // Le tag est reellement sur le remote, et aucune branche n'est partie avec.
      assert.ok(remoteTags(coreRemote).includes(version), remoteTags(coreRemote).join(", "));
      assert.equal(git(coreRemote, ["branch", "--list", core.branch]), "", "un tag se pousse sans branche, donc sans MR");

      // 3. et seulement maintenant, le bump en aval
      bump(app.worktree, "@fixture/core", version);
      await sandbox.call("create-code-commit", {
        ticketId: "TJ-400",
        repo: "fixture-app",
        message: `chore: bump @fixture/core to ${version}\n\nRefs: TJ-400`,
      });

      const deps = JSON.parse(readFileSync(join(app.worktree, "deps.json"), "utf8")) as Record<string, string>;
      assert.equal(deps["@fixture/core"], version);

      await sandbox.call("write-store-ticket", {
        ticketId: "TJ-400",
        patch: {
          scope: [
            {
              name: "fixture-core",
              publication: { required: true, tag: version, n: 1, pipelineStatus: "success", bumpedIn: ["fixture-app"] },
            },
          ],
        },
      });

      const state = await sandbox.call<any>("get-store-ticket", { ticketId: "TJ-400" });
      assert.deepEqual(state.scope[0].publication.bumpedIn, ["fixture-app"]);

      // Rien d'autre n'a ete publie.
      assert.equal(sandbox.gitlab.mergeRequests.length, 0);
      assert.equal(sandbox.slack.channels.length, 0);
    } finally {
      await sandbox.cleanup();
    }
  });

  it("ne publie pas un repo dont aucun aval du scope ne depend", async () => {
    const sandbox = await createSandbox({ ticket: { key: "TJ-410", summary: "Un repo sans aval" } });
    try {
      const registry = await sandbox.call<any>("get-repositories-registry", { includeEvalRepos: true });
      const scope = ["fixture-mono"];
      const needsPublication = registry.repositories
        .filter((repo: any) => scope.includes(repo.name))
        .filter((repo: any) =>
          registry.repositories.some((other: any) => scope.includes(other.name) && other.dependsOn.includes(repo.name)),
        );
      assert.deepEqual(needsPublication, [], "10.7 ne se declenche que si un aval du scope depend du repo");
    } finally {
      await sandbox.cleanup();
    }
  });
});

describe("scenario 4 — republication", () => {
  it("incremente le suffixe et refuse de deplacer une version existante", async () => {
    const sandbox = await createSandbox({ ticket: { key: "TJ-500", summary: "Republier apres la review" } });
    try {
      await openRepo(sandbox, { ticketId: "TJ-500", repo: "fixture-core", title: "Republier apres la review" });
      const app = await openRepo(sandbox, { ticketId: "TJ-500", repo: "fixture-app", title: "Republier apres la review" });
      const remote = sandbox.repo("fixture-core").remote;

      const first = nextDevVersion("v1.0.0", "TJ-500", remoteTags(remote));
      await publishUpstream(sandbox, "TJ-500", first);
      assert.equal(first, "v1.0.0-TJ-500-1");

      // Le code-adversary fait remuer l'amont : il faut pouvoir republier.
      writeFileSync(join(sandbox.home, "worktrees", "TJ-500", "fixture-core", "src", "period.js"), "export function clamp(p) {\n  return p ?? '';\n}\n", "utf8");
      await sandbox.call("create-code-commit", {
        ticketId: "TJ-500",
        repo: "fixture-core",
        message: "fix: handle the empty period\n\nRefs: TJ-500",
      });

      // Republier la meme version serait un rejet du registre, ou pire un cache
      // qui sert l'ancien artefact sans rien dire.
      await prepareUpstream(sandbox, "TJ-500");
      const refusal = await sandbox.expectFailure("push-tag", { ticketId: "TJ-500", repo: "fixture-core", tag: first });
      assert.match(refusal, /existe deja/);

      const second = nextDevVersion("v1.0.0", "TJ-500", remoteTags(remote));
      assert.equal(second, "v1.0.0-TJ-500-2", "le n s'incremente a chaque publication");

      await publishUpstream(sandbox, "TJ-500", second);
      const tags = remoteTags(remote);
      assert.ok(tags.includes(first) && tags.includes(second), tags.join(", "));

      bump(app.worktree, "@fixture/core", second);
      const deps = JSON.parse(readFileSync(join(app.worktree, "deps.json"), "utf8")) as Record<string, string>;
      assert.equal(deps["@fixture/core"], "v1.0.0-TJ-500-2");
    } finally {
      await sandbox.cleanup();
    }
  });

  it("escalade sur un timeout de pipeline plutot que de bumper a l'aveugle", async () => {
    const sandbox = await createSandbox({ ticket: { key: "TJ-510", summary: "Pipeline qui traine" } });
    try {
      await openRepo(sandbox, { ticketId: "TJ-510", repo: "fixture-core", title: "Pipeline qui traine" });
      const version = "v1.0.0-TJ-510-1";
      await prepareUpstream(sandbox, "TJ-510");
      await sandbox.call("push-tag", { ticketId: "TJ-510", repo: "fixture-core", tag: version });

      // Le pipeline existe mais ses jobs ne finissent jamais.
      sandbox.gitlab.pipelineVerdicts.set(version, { jobs: [{ name: "build", status: "running" }] });
      const watch = await sandbox.call<{ verdict: string; escalate: boolean; note?: string }>("watch-gitlab-pipeline", {
        repo: "fixture-core",
        ref: version,
        timeoutSeconds: 2,
        pollSeconds: 1,
      });

      assert.equal(watch.verdict, "timeout");
      assert.equal(watch.escalate, true);
      assert.match(watch.note ?? "", /escalate-to-human/);

      await sandbox.call("escalate-to-human", {
        ticketId: "TJ-510",
        reason: "Timeout du pipeline sur le tag de publication amont.",
        step: "10.7",
        repo: "fixture-core",
      });

      const state = await sandbox.call<any>("get-store-ticket", { ticketId: "TJ-510" });
      assert.equal(state.run.phase, "escalated");
      // Le tag deja pousse reste en place : le dechet est assume et borne.
      assert.ok(remoteTags(sandbox.repo("fixture-core").remote).includes(version));
      assert.equal(sandbox.gitlab.mergeRequests.length, 0);
    } finally {
      await sandbox.cleanup();
    }
  });
});
