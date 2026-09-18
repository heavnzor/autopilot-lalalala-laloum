import { existsSync } from "node:fs";
import { join } from "node:path";
import { type CommandKind, type RepoEntry } from "./config.ts";
import { fail } from "./errors.ts";
import { git } from "./git.ts";
import { withFileMutex } from "./mutex.ts";
import { worktreePath } from "./paths.ts";
import { readReceipt, receiptPath, writeReceipt } from "./receipts.ts";

export interface Revision { sha: string; clean: boolean }
export interface CheckReceipt {
  sha: string | null;
  passed: boolean;
  full: boolean;
  command: string;
  at: string;
  durationMs: number;
  planFingerprint: string | null;
}

export async function captureRevision(cwd: string): Promise<Revision | null> {
  if (!existsSync(join(cwd, ".git"))) return null;
  return { sha: await git(cwd, ["rev-parse", "HEAD"]), clean: (await git(cwd, ["status", "--porcelain"])) === "" };
}

export function recordVerification(ticketId: string, repo: string, kind: CommandKind, receipt: CheckReceipt): void {
  const path = receiptPath(ticketId, repo, "checks.json");
  withFileMutex(`${path}.lock`, () => {
    const checks = readReceipt<Record<string, CheckReceipt>>(path) ?? {};
    checks[kind] = receipt;
    writeReceipt(path, checks);
  });
}

export async function assertVerifiedRevision(ticketId: string, repo: RepoEntry): Promise<string> {
  const revision = await captureRevision(worktreePath(ticketId, repo.name));
  if (!revision?.clean) fail(`Le worktree ${repo.name} est absent ou porte des modifications non commitees.`);
  const checks = readReceipt<Record<string, CheckReceipt>>(receiptPath(ticketId, repo.name, "checks.json")) ?? {};
  const approval = readReceipt<{ fingerprint: string }>(receiptPath(ticketId, "approval.json"));
  for (const [kind, command] of Object.entries(repo.commands)) {
    if (!command) continue;
    const check = checks[kind];
    if (!check?.passed || !check.full || check.sha !== revision.sha || check.command !== command || !approval || check.planFingerprint !== approval.fingerprint) {
      fail(`${repo.name} : aucune verification complete ${kind} reussie sur le commit courant.`, "Lance le tool de verification du registre apres le dernier commit, sans filtre ni paths.");
    }
  }
  return revision.sha;
}
