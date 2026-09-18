import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { fail } from "./errors.ts";

/** Mutex inter-processus. Le verrou de run ne serialise pas les ecrivains MCP. */
export function withFileMutex<T>(path: string, action: () => T): T {
  mkdirSync(dirname(path), { recursive: true });
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      writeFileSync(path, owner, { encoding: "utf8", flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const previous = readFileSync(path, "utf8");
        const { pid } = JSON.parse(previous) as { pid?: number };
        if (typeof pid === "number" && pid > 1) {
          try {
            process.kill(pid, 0);
          } catch (probe) {
            if ((probe as NodeJS.ErrnoException).code === "ESRCH" && readFileSync(path, "utf8") === previous) {
              rmSync(path);
              continue;
            }
          }
        }
      } catch { /* Un detenteur peut liberer le verrou pendant la lecture. */ }
      if (Date.now() >= deadline) fail("Etat occupe par un autre ecrivain.", "Reessaie l'operation ; aucun changement n'a ete applique.");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return action();
  } finally {
    if (readFileSync(path, "utf8") === owner) rmSync(path);
  }
}
