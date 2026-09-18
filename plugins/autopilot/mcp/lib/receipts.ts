import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { autopilotHome, pathSegment, ticketKey } from "./paths.ts";

/** Preuves produites par les outils, distinctes du YAML editable par les agents. */
export function receiptPath(ticketId: string, ...parts: string[]): string {
  return join(autopilotHome(), "receipts", ticketKey(ticketId), ...parts.map(pathSegment));
}

export function readReceipt<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function writeReceipt(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}
