import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { RepoEntry } from "./config.ts";
import { fail } from "./errors.ts";
import { run } from "./exec.ts";

/**
 * Git n'est jamais mocke, meme dans les tests de workflow : c'est la partie la
 * plus fragile du systeme, la mocker reviendrait a ne plus la tester.
 */

export async function git(cwd: string, args: readonly string[], timeoutMs = 120_000): Promise<string> {
  const command = ["git", ...args.map(quote)].join(" ");
  const result = await run(command, { cwd, timeoutMs });
  if (result.exitCode !== 0) {
    fail(
      `git ${args[0]} a echoue dans ${cwd} (code ${result.exitCode}).`,
      (result.stderr || result.stdout).trim().slice(0, 1200),
    );
  }
  return result.stdout.trim();
}

export async function gitAllowFailure(cwd: string, args: readonly string[]): Promise<{ ok: boolean; output: string }> {
  const command = ["git", ...args.map(quote)].join(" ");
  const result = await run(command, { cwd, timeoutMs: 120_000 });
  return { ok: result.exitCode === 0, output: `${result.stdout}${result.stderr}`.trim() };
}

export async function currentBranch(cwd: string): Promise<string> {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export async function headSha(cwd: string): Promise<string> {
  return git(cwd, ["rev-parse", "--short", "HEAD"]);
}

export async function isClean(cwd: string): Promise<boolean> {
  return (await git(cwd, ["status", "--porcelain"])) === "";
}

export async function listTags(cwd: string): Promise<string[]> {
  const output = await git(cwd, ["tag", "--list"]);
  return output ? output.split("\n").map((line) => line.trim()).filter(Boolean) : [];
}

/**
 * Les fichiers touches par la branche courante, compares a la branche de base.
 * C'est l'entree de `monorepo-filter` et du perimetre d'impact de la review.
 */
export async function changedFiles(cwd: string, baseBranch: string): Promise<string[]> {
  const mergeBase = await gitAllowFailure(cwd, ["merge-base", "HEAD", baseBranch]);
  const from = mergeBase.ok && mergeBase.output ? mergeBase.output : baseBranch;
  const committed = await git(cwd, ["diff", "--name-only", `${from}...HEAD`]);
  const working = await git(cwd, ["status", "--porcelain"]);
  const files = new Set<string>();
  for (const line of committed.split("\n")) if (line.trim()) files.add(line.trim());
  for (const line of working.split("\n")) {
    const path = line.slice(3).trim();
    if (path) files.add(path.includes(" -> ") ? (path.split(" -> ")[1] ?? path) : path);
  }
  return [...files].sort();
}

/**
 * Deduit les paquets touches a partir des fichiers modifies.
 *
 * On remonte l'arborescence jusqu'au `package.json` le plus proche, exactement
 * comme le fait le monorepoTool : deviner d'apres `apps/<x>` marcherait sur web-app
 * et casserait sur le premier repo qui range autrement.
 */
export function packagesOf(repoRootPath: string, files: readonly string[]): string[] {
  const packages = new Set<string>();
  for (const file of files) {
    const name = nearestPackageName(repoRootPath, file);
    if (name) packages.add(name);
  }
  return [...packages].sort();
}

function nearestPackageName(repoRootPath: string, file: string): string | null {
  let directory = dirname(join(repoRootPath, file));
  while (true) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      if (directory === repoRootPath) return null; // racine : pas un paquet du monorepo
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
        return parsed.name ?? relative(repoRootPath, directory).split(sep).join("/");
      } catch {
        return relative(repoRootPath, directory).split(sep).join("/");
      }
    }
    const parent = dirname(directory);
    if (parent === directory || !parent.startsWith(repoRootPath)) return null;
    directory = parent;
  }
}

/** `--filter=` pour turbo, `--scope=` pour lerna. Rien pour un repo simple. */
export function filterFlags(repo: RepoEntry, packages: readonly string[]): string {
  if (!repo.monorepoTool || packages.length === 0) return "";
  for (const name of packages) {
    if (!/^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      fail(`Nom de paquet invalide : ${name}.`, "Passe des noms de paquets, jamais une expression shell.");
    }
  }
  const flag = repo.monorepoTool === "turbo" ? "--filter" : "--scope";
  return [...new Set(packages)].map((name) => `${flag}=${name}`).join(" ");
}

/** Compatibilite avec les anciens appels, avec une grammaire fermee. */
export function commandFilter(repo: RepoEntry, input: { filter?: string; packages?: readonly string[] }): string {
  if (input.filter && input.packages?.length) fail("Utilise `packages` ou `filter`, pas les deux.");
  if (!repo.monorepoTool && (input.filter?.trim() || input.packages?.length)) {
    fail(`${repo.name} n'est pas un monorepo : aucun filtre de paquets n'est admis.`);
  }
  if (!input.filter?.trim()) return filterFlags(repo, input.packages ?? []);
  const prefix = repo.monorepoTool === "turbo" ? "--filter=" : "--scope=";
  const packages = input.filter.trim().split(/\s+/).map((flag) => {
    if (!flag.startsWith(prefix)) fail(`Filtre invalide : ${flag}.`, `Seuls les ${prefix}<paquet> sont acceptes.`);
    return flag.slice(prefix.length);
  });
  return filterFlags(repo, packages);
}

export function installCommand(repo: RepoEntry): string {
  switch (repo.packageManager) {
    case "pnpm":
      return "pnpm install --frozen-lockfile";
    case "yarn":
      return "yarn install --frozen-lockfile";
    default:
      return "npm ci";
  }
}

function quote(argument: string): string {
  return /^[\w./:@=-]+$/.test(argument) ? argument : `'${argument.replaceAll("'", "'\\''")}'`;
}
