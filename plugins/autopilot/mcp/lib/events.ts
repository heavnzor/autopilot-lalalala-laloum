import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { Agent, request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import * as v from "valibot";
import { autopilotHome, eventsPath, ticketKey } from "./paths.ts";
import { LiveEventSchema, type LiveEvent } from "../../../../shared/events.ts";
export { LiveEventSchema, LIVE_EVENT_KINDS, LIVE_EVENT_STATUSES } from "../../../../shared/events.ts";
export type { LiveEvent, JsonValue } from "../../../../shared/events.ts";

/**
 * Un seul format d'event pour tout le monde. Un event qu'on ne sait pas valider
 * est logge et ignore, jamais affiche a moitie : une interface qui montre une
 * ligne tronquee est pire qu'une interface qui n'en montre pas.
 */

/**
 * Le payload est libre par kind, mais il traverse le reseau et le rendu serveur :
 * il doit donc etre serialisable. `unknown` laissait passer une Date ou une Map,
 * qui arrivaient cassees de l'autre cote sans que rien ne le dise.
 */
export function validateEvent(candidate: unknown): { ok: true; event: LiveEvent } | { ok: false; issues: string[] } {
  const result = v.safeParse(LiveEventSchema, candidate);
  if (result.success) return { ok: true, event: result.output };
  return { ok: false, issues: result.issues.map((issue) => `${issue.path?.map((p) => String(p.key)).join(".") ?? "?"} : ${issue.message}`) };
}

// --------------------------------------------------------- session live ----

export interface LiveSession {
  readonly runId: string;
  readonly ticketId: string;
  readonly port: number;
  readonly url: string;
  readonly pid: number;
  readonly startedAt: string;
}

export function liveSessionPath(ticketId: string): string {
  return join(autopilotHome(), "live", `${ticketKey(ticketId)}.json`);
}

export function readLiveSession(ticketId: string): LiveSession | null {
  try {
    return JSON.parse(readFileSync(liveSessionPath(ticketId), "utf8")) as LiveSession;
  } catch {
    return null;
  }
}

export function writeLiveSession(session: LiveSession): void {
  const path = liveSessionPath(session.ticketId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

// ----------------------------------------------------------- persistance ----

/**
 * Les events sont d'abord appendus sur disque, ensuite pousses au shell. Cet
 * ordre est la seule raison pour laquelle le live shell n'est pas un point de
 * defaillance : s'il est mort, le run continue et l'historique reste complet,
 * et une reprise peut rejouer depuis le debut.
 */
const openLogs = new Map<string, number>();

export function appendEvent(event: LiveEvent): void {
  const path = eventsPath(event.ticketId);
  let fd = openLogs.get(path);

  if (fd !== undefined && !stillTheSameFile(fd, path)) {
    // Le chemin ne designe plus ce qu'on tient ouvert : le fichier a ete
    // efface, deplace, ou remplace. Garder le descripteur reviendrait a ecrire
    // dans un inode que plus personne ne peut lire — sans la moindre erreur,
    // parce qu'ecrire dans un fichier supprime reste parfaitement legal.
    try {
      closeSync(fd);
    } catch {
      // Deja ferme : rien a rattraper.
    }
    openLogs.delete(path);
    fd = undefined;
  }

  if (fd === undefined) {
    mkdirSync(dirname(path), { recursive: true });
    // Ouvert une fois et garde ouvert : `appendFileSync` refait un open/close a
    // chaque ligne, ce qui coutait 2,3 ms par event pour une ecriture de 200
    // octets. L'ecriture reste synchrone, donc la garantie « sur disque avant
    // d'etre diffuse » ne bouge pas.
    fd = openSync(path, "a");
    openLogs.set(path, fd);
  }
  writeSync(fd, `${JSON.stringify(event)}\n`);
}

/**
 * Le descripteur ouvert designe-t-il toujours le fichier de ce chemin.
 *
 * Un serveur MCP vit des heures et traverse plusieurs runs. Vider
 * `~/.autopilot/events/` entre deux runs — ce qui est un geste normal —
 * suffisait a faire disparaitre en silence tout l'historique du run suivant :
 * le journal continuait de s'ecrire dans l'inode detruit, le fichier
 * n'existait plus, et le rejeu au redemarrage du shell ne trouvait rien.
 *
 * Deux `stat` par event, de l'ordre de la dizaine de microsecondes : deux
 * ordres de grandeur sous l'open/close de 2,3 ms que le cache evite, et c'est
 * ce qui rend vraie la promesse « sur disque avant d'etre diffuse ».
 */
function stillTheSameFile(fd: number, path: string): boolean {
  try {
    const open = fstatSync(fd);
    const here = statSync(path);
    return open.ino === here.ino && open.dev === here.dev;
  } catch {
    // Le chemin a disparu : il faut rouvrir.
    return false;
  }
}

/** Referme les logs ouverts. Les tests changent de `AUTOPILOT_HOME` en cours de route. */
export function closeEventLogs(): void {
  for (const fd of openLogs.values()) {
    try {
      closeSync(fd);
    } catch {
      // Deja ferme : rien a rattraper.
    }
  }
  openLogs.clear();
}

export function readEvents(ticketId: string): LiveEvent[] {
  let raw = "";
  try {
    raw = readFileSync(eventsPath(ticketId), "utf8");
  } catch {
    return [];
  }
  const events: LiveEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = validateEvent(JSON.parse(line));
      if (parsed.ok) events.push(parsed.event);
    } catch {
      // Ligne illisible : on l'ignore plutot que de casser le rejeu complet.
    }
  }
  return events;
}

/**
 * Le compteur de sequence, tenu en memoire.
 *
 * Il etait relu depuis le fichier a chaque event : O(n) par push, donc O(n²) sur
 * un run. Mesure sur un log de 172 lignes, c'etait deja 4,4 ms par event contre
 * 1,8 ms pour le POST — et ca ne fait que grandir. Sur un run de trois heures le
 * flux aurait fini par trainer visiblement derriere le terminal.
 *
 * On ne lit donc le disque qu'une fois par ticket, au premier event du process.
 */
const seqCache = new Map<string, number>();

export function nextSeq(ticketId: string): number {
  ticketId = ticketKey(ticketId);
  const cached = seqCache.get(ticketId);
  if (cached !== undefined) {
    const next = cached + 1;
    seqCache.set(ticketId, next);
    return next;
  }
  // Premier event de ce process : on reprend la ou le fichier s'est arrete, ce
  // qui garde les seq monotones au travers d'une reprise.
  const last = readEvents(ticketId).at(-1);
  const seq = last ? last.seq + 1 : 0;
  seqCache.set(ticketId, seq);
  return seq;
}

/** Les tests rejouent plusieurs runs dans le meme process. */
export function resetSeqCache(): void {
  seqCache.clear();
}

/**
 * La connexion vers le live shell est gardee ouverte.
 *
 * `fetch` rouvre une connexion par appel. Sur un flux d'events c'est une poignee
 * de main TCP par ligne affichee, pour un serveur qui tourne sur la meme
 * machine. Un agent keep-alive supprime ce cout.
 */
const keepAlive = new Agent({ keepAlive: true, maxSockets: 4, keepAliveMsecs: 30_000 });

/** Best effort, et strictement best effort : une diffusion ratee n'echoue jamais. */
export function broadcast(event: LiveEvent, timeoutMs = 2000): Promise<"sent" | "no-session" | "unreachable"> {
  const session = readLiveSession(event.ticketId);
  if (!session) return Promise.resolve("no-session");

  const body = JSON.stringify(event);
  const target = new URL(`${session.url}/rpc/event`);

  return new Promise((resolve) => {
    const request = httpRequest(
      {
        agent: keepAlive,
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        timeout: timeoutMs,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (response) => {
        response.resume(); // il faut vider le flux pour rendre la socket au pool
        response.on("end", () => resolve((response.statusCode ?? 500) < 400 ? "sent" : "unreachable"));
      },
    );
    request.on("error", () => resolve("unreachable"));
    request.on("timeout", () => {
      request.destroy();
      resolve("unreachable");
    });
    request.end(body);
  });
}
