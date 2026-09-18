import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Les faux repos sont de **vrais depots git**, avec un remote **bare** local.
 *
 * `create-worktree`, `create-code-commit` et `push-tag` s'executent donc pour de
 * vrai, et les tests verifient l'etat reel du depot. Mocker git reviendrait a ne
 * plus tester la partie la plus fragile du systeme.
 */

export interface FixtureRepo {
  readonly name: string;
  readonly level: number;
  readonly path: string;
  readonly remote: string;
  readonly baseBranch: string;
  readonly dependsOn: readonly string[];
  readonly packageName: string | null;
  readonly monorepoTool: "turbo" | null;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@test",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@test",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  }).trim();
}

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

/** Un lockfile minimal, pour que `npm ci` passe sans reseau. */
function lockfile(name: string): string {
  return JSON.stringify(
    { name, version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name, version: "1.0.0" } } },
    null,
    2,
  );
}

interface Blueprint {
  name: string;
  level: number;
  baseBranch: string;
  dependsOn: string[];
  packageName: string | null;
  monorepoTool: "turbo" | null;
  files: Record<string, string>;
}

/**
 * Quatre depots : deux levels differents, une dependance amont/aval, un
 * monorepo, une suite qui passe et une qu'on peut faire echouer a la demande.
 */
export function blueprints(): Blueprint[] {
  return [
    {
      name: "fixture-core",
      level: 1,
      baseBranch: "main",
      dependsOn: [],
      packageName: "@fixture/core",
      monorepoTool: null,
      files: {
        "package.json": JSON.stringify(
          { name: "@fixture/core", version: "1.0.0", private: true, type: "module", scripts: { "test:unit": "node --test tests/*.test.js" } },
          null,
          2,
        ),
        "package-lock.json": lockfile("@fixture/core"),
        "src/period.js": "export function clamp(period) {\n  return period ?? null;\n}\n",
        "tests/period.test.js":
          "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { clamp } from '../src/period.js';\n\ntest('clamp rend la periode', () => {\n  assert.equal(clamp('2026-09'), '2026-09');\n});\n",
      },
    },
    {
      name: "fixture-app",
      level: 2,
      baseBranch: "main",
      dependsOn: ["fixture-core"],
      packageName: null,
      monorepoTool: null,
      files: {
        "package.json": JSON.stringify(
          {
            name: "fixture-app",
            version: "1.0.0",
            private: true,
            type: "module",
            scripts: { "test:unit": "node --test tests/*.test.js" },
          },
          null,
          2,
        ),
        "package-lock.json": lockfile("fixture-app"),
        // Le lien amont vit ici plutot que dans `dependencies` : un vrai
        // `npm ci` irait chercher le paquet sur un registre, et la sandbox
        // n'en a pas. Ce que le bump doit prouver, c'est qu'une version se
        // propage a l'aval — pas que npm sait resoudre.
        "deps.json": JSON.stringify({ "@fixture/core": "1.0.0" }, null, 2),
        "src/list.js": "export function list() {\n  return [];\n}\n",
        "tests/list.test.js":
          "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { list } from '../src/list.js';\n\ntest('list rend une liste', () => {\n  assert.ok(Array.isArray(list()));\n});\n",
      },
    },
    {
      name: "fixture-mono",
      level: 3,
      baseBranch: "main",
      dependsOn: [],
      packageName: null,
      monorepoTool: "turbo",
      files: {
        "package.json": JSON.stringify(
          // Pas de champ `workspaces` : `npm ci` exigerait un lockfile qui les
          // liste. Ce qu'on teste ici, c'est que `monorepo-filter` retrouve
          // les paquets en remontant au package.json le plus proche.
          { name: "fixture-mono", version: "1.0.0", private: true, type: "module" },
          null,
          2,
        ),
        "package-lock.json": lockfile("fixture-mono"),
        "apps/web/package.json": JSON.stringify({ name: "@mono/web", version: "1.0.0" }, null, 2),
        "apps/web/src/index.js": "export const web = true;\n",
        "packages/helpers/package.json": JSON.stringify({ name: "@mono/helpers", version: "1.0.0" }, null, 2),
        "packages/helpers/src/index.js": "export const helper = true;\n",
      },
    },
    {
      name: "fixture-flaky",
      level: 1,
      baseBranch: "main",
      dependsOn: [],
      packageName: null,
      monorepoTool: null,
      files: {
        "package.json": JSON.stringify(
          { name: "fixture-flaky", version: "1.0.0", private: true, type: "module", scripts: { "test:unit": "node --test tests/*.test.js" } },
          null,
          2,
        ),
        "package-lock.json": lockfile("fixture-flaky"),
        // La suite passe ou echoue selon le contenu de `src/answer.js` : c'est
        // le levier des scenarios de boucle rouge.
        "src/answer.js": "export const answer = 42;\n",
        "tests/answer.test.js":
          "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { answer } from '../src/answer.js';\n\ntest('answer vaut 42', () => {\n  assert.equal(answer, 42);\n});\n",
      },
    },
  ];
}

export function materialize(root: string): FixtureRepo[] {
  const repos: FixtureRepo[] = [];

  for (const blueprint of blueprints()) {
    const remote = join(root, "remotes", `${blueprint.name}.git`);
    const path = join(root, "repos", blueprint.name);

    mkdirSync(remote, { recursive: true });
    git(remote, ["init", "--bare", "-q", "-b", blueprint.baseBranch]);

    mkdirSync(path, { recursive: true });
    git(path, ["init", "-q", "-b", blueprint.baseBranch]);
    git(path, ["config", "user.name", "fixture"]);
    git(path, ["config", "user.email", "fixture@test"]);

    for (const [file, content] of Object.entries(blueprint.files)) write(path, file, content);

    git(path, ["add", "-A"]);
    git(path, ["commit", "-q", "-m", "chore: bootstrap fixture"]);
    git(path, ["tag", "-a", "v1.0.0", "-m", "v1.0.0"]);
    git(path, ["remote", "add", "origin", remote]);
    git(path, ["push", "-q", "origin", blueprint.baseBranch]);
    git(path, ["push", "-q", "origin", "v1.0.0"]);

    repos.push({
      name: blueprint.name,
      level: blueprint.level,
      path,
      remote,
      baseBranch: blueprint.baseBranch,
      dependsOn: blueprint.dependsOn,
      packageName: blueprint.packageName,
      monorepoTool: blueprint.monorepoTool,
    });
  }

  return repos;
}

/** Rend la suite de `fixture-flaky` rouge, ou verte a nouveau. */
export function setFlaky(repoPath: string, failing: boolean): void {
  write(repoPath, "src/answer.js", failing ? "export const answer = 0;\n" : "export const answer = 42;\n");
}

export { git as fixtureGit };
