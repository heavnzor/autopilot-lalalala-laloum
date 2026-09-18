import { fail } from "./errors.ts";
import { HttpError } from "./http.ts";
import { withFileMutex } from "./mutex.ts";
import { readReceipt, receiptPath, writeReceipt } from "./receipts.ts";
import { fingerprint } from "./workflow.ts";

interface Operation<T> {
  key: string;
  inputHash: string;
  status: "pending" | "done" | "failed" | "uncertain";
  at: string;
  result?: T;
  error?: string;
}

/**
 * Les succes sont rejouables sans nouvel effet. Un resultat reseau incertain
 * demande une reconciliation, jamais un second POST aveugle.
 */
export async function publishOnce<T>(
  ticketId: string,
  key: string,
  input: unknown,
  execute: () => Promise<T>,
  reconcile?: () => Promise<T | null>,
): Promise<T> {
  const path = receiptPath(ticketId, `operation-${fingerprint(key)}.json`);
  const inputHash = fingerprint(input);
  const previous = withFileMutex(`${path}.lock`, () => {
    const old = readReceipt<Operation<T>>(path);
    if (old && old.inputHash !== inputHash) fail(`L'operation ${key} existe avec un autre contenu.`, "Relis sa publication avant de demander une nouvelle operation.");
    if (old && old.status !== "failed") return old;
    writeReceipt(path, { key, inputHash, status: "pending", at: new Date().toISOString() });
    return null;
  });
  if (previous?.status === "done") return previous.result as T;
  const finish = (operation: Operation<T>) => withFileMutex(`${path}.lock`, () => {
    // Une reconciliation concurrente peut avoir constate le succes entre-temps.
    if (readReceipt<Operation<T>>(path)?.status !== "done") writeReceipt(path, operation);
  });
  if (previous) {
    // Un casier pending peut appartenir a un appel encore en vol. Le lecteur
    // peut constater un succes, mais n'a jamais le droit de relancer la creation.
    const recovered = reconcile ? await reconcile() : null;
    if (recovered !== null) {
      finish({ key, inputHash, status: "done", at: new Date().toISOString(), result: recovered });
      return recovered;
    }
    fail(`Resultat distant incertain pour ${key}.`, "Escalade avec ce nom d'operation. Verifie le service distant avant toute nouvelle creation.");
  }
  try {
    const result = await execute();
    finish({ key, inputHash, status: "done", at: new Date().toISOString(), result });
    return result;
  } catch (error) {
    finish({
      key, inputHash, status: error instanceof HttpError && !error.uncertain ? "failed" : "uncertain",
      at: new Date().toISOString(), error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
