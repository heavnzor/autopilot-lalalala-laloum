import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { autopilotHome } from "./paths.ts";

export interface RunResult {
  readonly command: string;
  readonly cwd: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  /**
   * Pourquoi la commande s'est arretee. `silence` dit quelque chose que
   * `timeout` ne dit pas : le process etait vivant mais n'ecrivait plus rien,
   * ce qui est la signature d'une attente d'infrastructure — un `docker pull`
   * sans daemon, un conteneur qui ne demarre pas — et pas d'un test lent.
   */
  readonly stoppedBy: "exit" | "timeout" | "silence" | "output-limit";
  readonly durationMs: number;
  /** Delai ecoule depuis la derniere ligne recue, au moment ou on a rendu. */
  readonly silentForMs: number;
  /**
   * Le plus long silence traverse par la commande.
   *
   * C'est ce chiffre qui calibre `commandSilenceSeconds`, pas une intuition :
   * une suite qui se tait 90 secondes pendant son build interdit un seuil a 60,
   * et le savoir demande de l'avoir mesure une fois.
   */
  readonly maxSilentMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  /**
   * Le journal complet, sur disque, quand la sortie rendue ne l'est pas.
   *
   * Couper par le milieu convient a un build : le debut dit ce qui a ete lance,
   * la fin dit ce qui a casse. Ca ne convient pas a une suite de tests, ou le
   * verdict cherche est un fichier parmi trois cents et tombe ou il tombe. Sur
   * FT-1042, la suite fonctionnelle de `sheet-service` sortait 4400 lignes,
   * `feature/lab` au milieu : le red-checker a rendu trois fois « non
   * verifiable » sur une sortie dont il n'avait jamais recu la partie utile.
   * Le texte rendu reste court ; l'integralite est ici, et `focus` sait la
   * rouvrir sans la relire en entier.
   */
  readonly logPath: string | null;
  /**
   * Lignes retenues par `focus`. `null` quand aucun motif n'a ete demande,
   * `0` quand le motif n'a rien trouve — et dans ce cas la sortie rendue est
   * la sortie entiere, jamais un vide qu'on prendrait pour un vert.
   */
  readonly focusMatched: number | null;
}

export interface RunOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  /**
   * Silence tolere avant abandon. Une commande qui n'a rien ecrit depuis ce
   * delai est abandonnee, meme s'il lui reste du temps au plafond global.
   */
  readonly silenceMs?: number;
  readonly env?: Readonly<Record<string, string>>;
  /** Nombre de lignes conservees de chaque flux. Le reste ne sert a personne. */
  readonly keepLines?: number;
  /**
   * Motif de recentrage, applique AVANT la coupe. Les lignes qui matchent, plus
   * deux de contexte de chaque cote, sont les seules gardees — c'est ce qui
   * permet d'extraire trois fichiers de tests d'une suite de quatre mille
   * lignes. Un motif qui ne trouve rien ne coupe rien : on rend la sortie
   * entiere plutot qu'un vide muet.
   */
  readonly focus?: string;
  /**
   * Etiquette du journal complet ecrit sur disque des que la sortie rendue est
   * partielle. Sans elle, rien n'est ecrit : une commande dont personne ne
   * relira la sortie n'a pas besoin d'un fichier.
   */
  readonly logTo?: string;
  /**
   * Appele regulierement tant que la commande tourne. C'est ce qui empeche le
   * client MCP de prendre un test long pour un appel mort : cote client, un
   * appel silencieux finit tue, et le tool n'a aucun moyen de plaider sa cause
   * apres coup.
   */
  readonly onProgress?: (message: string) => void;
  readonly maxOutputBytes?: number;
}

/**
 * Tout ce qui sort d'un repo passe par ici.
 *
 * La sortie est tronquee par le milieu : le debut dit ce qui a ete lance, la
 * fin dit ce qui a casse. Les dix mille lignes du milieu d'un build turbo
 * n'apprennent rien a personne et coutent un contexte entier.
 */
export function run(command: string, options: RunOptions): Promise<RunResult> {
  const timeouts = loadConfig().timeouts;
  const timeoutMs = options.timeoutMs ?? timeouts.commandSeconds * 1000;
  const silenceMs = options.silenceMs ?? timeouts.commandSilenceSeconds * 1000;
  const keepLines = options.keepLines ?? 120;
  const maxOutputBytes = options.maxOutputBytes ?? loadConfig().limits?.commandOutputBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) throw new Error("Limite de sortie invalide.");
  const startedAt = Date.now();

  return new Promise<RunResult>((resolve) => {
    // `detached` fait du shell le chef de son groupe de processus, et c'est la
    // seule chose qui rend le watchdog capable de tuer ce qu'il a lance.
    // Sans lui, `child.kill()` ne tue que le `/bin/sh` : `npm` et le runner de
    // tests qu'il a ouverts survivent, orphelins, rattaches a launchd. Ils ont
    // garde les tubes de sortie ouverts, donc `close` n'arrivait jamais et la
    // promesse ne se resolvait pas — l'agent restait muet jusqu'au plafond du
    // serveur MCP, huit heures. Mesure faite sur FT-1042 : un `mtr` d'UT
    // toujours vivant trente minutes apres son abandon, et un autre du
    // surlendemain precedent encore la apres un jour et seize heures.
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      detached: true,
      env: childEnv(options.env),
    });

    /**
     * Abattre l'arbre, pas la racine.
     *
     * Le signal negatif vise le groupe entier. On passe par `SIGTERM` d'abord —
     * un runner de tests a le droit de fermer ses connexions — puis `SIGKILL`
     * deux secondes plus tard pour ce qui n'a pas obei.
     */
    const killTree = (): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      const signal = (sig: NodeJS.Signals) => {
        try {
          process.kill(-pid, sig);
        } catch {
          // Groupe deja parti, ou jamais cree : le `try` sur le pid seul est
          // le dernier recours, et son echec n'est pas une panne.
          try {
            child.kill(sig);
          } catch {
            /* rien a tuer */
          }
        }
      };
      signal("SIGTERM");
      setTimeout(() => signal("SIGKILL"), 2_000).unref?.();
    };

    let stdout = "";
    let stderr = "";
    let lastOutputAt = startedAt;
    let maxSilentMs = 0;
    let stoppedBy: RunResult["stoppedBy"] = "exit";
    let outputBytes = 0;

    const timer = setTimeout(() => {
      if (stoppedBy !== "exit") return;
      stoppedBy = "timeout";
      killTree();
    }, timeoutMs);

    /**
     * Deux horloges, pas une.
     *
     * Le plafond global borne une commande lente ; le silence attrape une
     * commande bloquee. Les confondre coute la difference entre les deux : sur
     * FT-1042, une suite de tests a occupe trente minutes de plafond sans
     * jamais ecrire une ligne parce qu'aucun daemon de conteneurs ne repondait,
     * puis la meme commande a rendu en vingt-et-une secondes une fois le
     * daemon la. Le silence le disait des la premiere minute.
     */
    const watchdog = setInterval(() => {
      if (stoppedBy !== "exit") return;
      const silentFor = Date.now() - lastOutputAt;
      if (silenceMs > 0 && silentFor >= silenceMs) {
        stoppedBy = "silence";
        clearInterval(watchdog);
        killTree();
        return;
      }
      options.onProgress?.(`${command.slice(0, 60)} — ${Math.round((Date.now() - startedAt) / 1000)}s`);
    }, Math.max(1000, Math.min(PROGRESS_EVERY_MS, silenceMs > 0 ? silenceMs / 2 : PROGRESS_EVERY_MS)));

    const record = (chunk: Buffer, into: "out" | "err"): void => {
      if (stoppedBy === "output-limit") return;
      const now = Date.now();
      maxSilentMs = Math.max(maxSilentMs, now - lastOutputAt);
      lastOutputAt = now;
      const remaining = maxOutputBytes - outputBytes;
      const kept = chunk.subarray(0, Math.max(0, remaining));
      outputBytes += kept.length;
      if (into === "out") stdout += kept.toString();
      else stderr += kept.toString();
      if (chunk.length > remaining) {
        stoppedBy = "output-limit";
        stderr += `\nSortie arretee a ${maxOutputBytes} octets ; le journal est incomplet.\n`;
        killTree();
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => record(chunk, "out"));
    child.stderr?.on("data", (chunk: Buffer) => record(chunk, "err"));

    running.add(killTree);

    let settled = false;
    const done = (result: Omit<RunResult, "command" | "cwd" | "durationMs" | "silentForMs" | "maxSilentMs">): void => {
      // Deux evenements peuvent conclure, et parfois les deux arrivent.
      if (settled) return;
      settled = true;
      running.delete(killTree);
      clearTimeout(timer);
      clearInterval(watchdog);
      const silentForMs = Date.now() - lastOutputAt;
      resolve({
        ...result,
        command,
        cwd: options.cwd,
        durationMs: Date.now() - startedAt,
        silentForMs,
        maxSilentMs: Math.max(maxSilentMs, silentForMs),
      });
    };

    child.on("error", (error) => {
      done({
        exitCode: 127,
        timedOut: false,
        stoppedBy: "exit",
        stdout: "",
        stderr: error.message,
        truncated: false,
        logPath: null,
        focusMatched: null,
      });
    });

    const finish = (code: number | null): void => {
      if (settled) return;
      const focusedOut = focusOn(stdout, options.focus);
      const focusedErr = focusOn(stderr, options.focus);
      const out = clip(focusedOut.text, keepLines);
      const err = clip(focusedErr.text, keepLines);
      const truncated = out.truncated || err.truncated;
      const partial = truncated || focusedOut.filtered || focusedErr.filtered;
      const matched =
        options.focus === undefined ? null : focusedOut.matched + focusedErr.matched;
      done({
        exitCode: stoppedBy === "exit" ? (code ?? 1) : 124,
        timedOut: stoppedBy === "timeout" || stoppedBy === "silence",
        stoppedBy,
        stdout: out.text,
        stderr: err.text,
        truncated,
        // Le journal n'est ecrit que si la sortie rendue ne suffit pas. Ecrire a
        // chaque commande remplirait le disque de suites vertes que personne
        // n'ouvrira jamais.
        logPath: partial ? writeLog(options.logTo, command, stdout, stderr) : null,
        focusMatched: matched,
      });
    };

    // `close` attend la fermeture des tubes, pas la fin du processus. Un
    // petit-fils survivant les tient ouverts et `close` n'arrive jamais : c'est
    // exactement comme ca qu'un run s'arretait sans rien dire. `exit`, lui, ne
    // depend que du processus. On laisse deux secondes a la sortie en retard,
    // puis on conclut avec ce qu'on a.
    child.on("exit", (code) => {
      setTimeout(() => finish(code), 2_000).unref?.();
    });
    child.on("close", (code) => finish(code));
  });
}

/** Rythme des battements vers le client, quand le silence tolere est large. */
const PROGRESS_EVERY_MS = 15_000;

/**
 * Les commandes en cours, pour pouvoir les abattre quand la session s'en va.
 *
 * Le chien de garde protege d'une commande bloquee ; il ne protege de rien
 * quand c'est le serveur lui-meme qui disparait. Sans ce registre, un `pnpm
 * test` lance il y a dix secondes continue de tourner apres la fermeture de la
 * session — et plus personne n'en connait le pid. Constate sur FT-1042 : un
 * runner d'UT encore vivant apres un jour et seize heures.
 */
const running = new Set<() => void>();

/**
 * Tuer tout ce qui tourne encore. Appele par l'arret du serveur, jamais
 * pendant un run : une commande abandonnee ici n'a personne pour lire son
 * verdict.
 */
export function killRunningCommands(): void {
  for (const kill of [...running]) {
    try {
      kill();
    } catch {
      // Un groupe deja parti n'est pas une panne.
    }
  }
  running.clear();
}

/**
 * Ce qu'on dit d'une commande abandonnee, pour que l'agent qui le lit sache
 * ou chercher. Un `timedOut: true` nu envoie chercher un test lent ; neuf fois
 * sur dix c'est l'environnement qui ne repond pas.
 */
export function stopReason(result: RunResult): string | null {
  if (result.stoppedBy === "exit") return null;
  if (result.stoppedBy === "output-limit") return "Commande interrompue : volume de sortie excessif. Le resultat ne valide aucun test et le journal est incomplet.";
  if (result.stoppedBy === "silence") {
    return (
      `Commande abandonnee apres ${Math.round(result.silentForMs / 1000)}s sans la moindre sortie. ` +
      "Verifie l'infrastructure, puis un blocage du runner ou du code. Le silence seul n'identifie pas la cause."
    );
  }
  return (
    `Commande abandonnee au plafond de ${Math.round(result.durationMs / 1000)}s. ` +
    "Inspecte les dernieres sorties : ce plafond ne distingue pas a lui seul une commande lente d'un blocage."
  );
}

/**
 * Des variables du process courant changent le comportement du process fils
 * sans qu'on le demande.
 *
 * Le cas qui nous a mordu : `NODE_TEST_CONTEXT` est pose par `node --test`, et
 * un `node --test` lance dans ce contexte **saute les fichiers et sort 0**. Une
 * suite de tests rendait donc un vert sans avoir rien lance — exactement le
 * faux vert que le red-checker existe pour attraper.
 */
const INHERITED_BUT_HARMFUL = ["NODE_TEST_CONTEXT", "NODE_OPTIONS", "NODE_V8_COVERAGE", "TEST_RUNNER"];

function childEnv(overrides: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides, CI: "1", FORCE_COLOR: "0" };
  for (const key of INHERITED_BUT_HARMFUL) delete env[key];
  return env;
}

export function clip(text: string, keepLines: number): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  if (lines.length <= keepLines * 2) return { text, truncated: false };
  const head = lines.slice(0, keepLines);
  const tail = lines.slice(-keepLines);
  const omitted = lines.length - head.length - tail.length;
  return {
    text: [
      ...head,
      `… ${omitted} lignes coupees au milieu — relance avec \`focus\` pour les voir, ou ouvre \`logPath\` …`,
      ...tail,
    ].join("\n"),
    truncated: true,
  };
}

/** Lignes de contexte gardees autour de chaque ligne retenue par `focus`. */
const FOCUS_CONTEXT = 2;

/**
 * Garder le milieu, quand c'est le milieu qu'on cherche.
 *
 * Une suite de tests n'a pas de « debut utile » et de « fin utile » : elle a
 * des fichiers, dans l'ordre ou le runner les a pris. Le motif dit lesquels,
 * et on rend ces lignes-la plutot que les deux bouts.
 *
 * Un motif qui ne trouve rien rend la sortie entiere, delibererement. Rendre un
 * vide laisserait croire a une suite sans echec — exactement le faux vert que
 * le red-checker existe pour attraper.
 */
export function focusOn(
  text: string,
  pattern: string | undefined,
): { text: string; filtered: boolean; matched: number } {
  if (pattern === undefined || pattern === "") return { text, filtered: false, matched: 0 };

  let regexp: RegExp;
  try {
    regexp = new RegExp(pattern, "i");
  } catch {
    // Un motif invalide est une erreur d'appelant, pas une raison de masquer la
    // sortie : on rend tout, il verra son motif dans le resultat.
    return { text, filtered: false, matched: 0 };
  }

  const lines = text.split("\n");
  const kept = new Set<number>();
  let matched = 0;
  for (const [index, line] of lines.entries()) {
    if (!regexp.test(line)) continue;
    matched += 1;
    for (let offset = -FOCUS_CONTEXT; offset <= FOCUS_CONTEXT; offset += 1) {
      const neighbour = index + offset;
      if (neighbour >= 0 && neighbour < lines.length) kept.add(neighbour);
    }
  }
  if (matched === 0) return { text, filtered: false, matched: 0 };

  const out: string[] = [];
  let previous = -1;
  for (const index of [...kept].sort((left, right) => left - right)) {
    if (previous !== -1 && index > previous + 1) out.push(`… ${index - previous - 1} lignes …`);
    out.push(lines[index] ?? "");
    previous = index;
  }
  return { text: out.join("\n"), filtered: true, matched };
}

/**
 * Le journal complet, a cote de l'etat du run.
 *
 * Il ne remplace pas la sortie rendue : il la complete pour celui qui doit
 * aller voir la ligne que la coupe a mangee. Un echec d'ecriture n'est pas une
 * panne de la commande — on rend `null` et la sortie partielle reste lisible.
 */
function writeLog(label: string | undefined, command: string, stdout: string, stderr: string): string | null {
  if (!label) return null;
  try {
    const directory = join(autopilotHome(), "logs");
    mkdirSync(directory, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
    const path = join(directory, `${label.replaceAll(/[^A-Za-z0-9._-]+/g, "-")}-${stamp}.log`);
    writeFileSync(path, `$ ${command}\n\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`, "utf8");
    return path;
  } catch {
    return null;
  }
}
