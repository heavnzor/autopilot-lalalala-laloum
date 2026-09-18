import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fail } from "./errors.ts";

/**
 * Deux emplacements, deux roles. Le projet porte le code et la configuration,
 * il se clone. `~/.autopilot` porte la connaissance et l'etat, il s'accumule.
 */

const here = fileURLToPath(new URL(".", import.meta.url));

/** Racine du projet : le dossier qui porte `autopilot.yaml`. */
export function projectRoot(): string {
  const fromEnv = process.env.AUTOPILOT_PROJECT_ROOT;
  if (fromEnv) return resolve(expandTilde(fromEnv));
  // <root>/plugins/autopilot/mcp/lib/ -> <root>
  return resolve(here, "..", "..", "..", "..");
}

/** Racine de l'etat local. Deplacable pour les tests de workflow en sandbox. */
export function autopilotHome(): string {
  const fromEnv = process.env.AUTOPILOT_HOME;
  return fromEnv ? resolve(expandTilde(fromEnv)) : join(homedir(), ".autopilot");
}

export function memoryDir(): string {
  return join(autopilotHome(), "memory");
}

export function ticketStatePath(ticketId: string): string {
  return join(autopilotHome(), "tickets", `${ticketKey(ticketId)}.yaml`);
}

export function lockPath(ticketId: string): string {
  return join(autopilotHome(), "locks", ticketKey(ticketId));
}

export function eventsPath(ticketId: string): string {
  return join(autopilotHome(), "events", `${ticketKey(ticketId)}.jsonl`);
}

export function worktreePath(ticketId: string, repo: string): string {
  return join(autopilotHome(), "worktrees", ticketKey(ticketId), pathSegment(repo));
}

/**
 * Les maquettes rendues, en PNG, a cote de l'etat du ticket.
 *
 * L'URL que Figma rend pour une image expire au bout de quelques dizaines de
 * minutes, et le lien du fichier demande un jeton. Un run rejoue trois semaines
 * plus tard afficherait donc un cadre vide a la place de la maquette sur
 * laquelle il a ete cadre. On garde le pixel.
 */
export function figmaDir(ticketId: string): string {
  return join(autopilotHome(), "figma", ticketKey(ticketId));
}

/** Une cle de ticket n'est jamais un chemin, meme quand un agent la fournit. */
export function ticketKey(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(value.trim())) {
    fail(`Cle Jira mal formee : ${String(value)}.`, "Attendu <PROJET>-<numero>.");
  }
  return value.trim().toUpperCase();
}

export function pathSegment(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    fail(`Nom de depot invalide : ${String(value)}.`);
  }
  return value;
}

/** Les definitions d'agents. Leur nom de fichier est leur nom, il fait foi. */
export function agentsDir(): string {
  return join(projectRoot(), "plugins", "autopilot", "agents");
}

export function liveShellDir(): string {
  return join(projectRoot(), "tools", "live-shell");
}

/**
 * `~/Projects/web-app` dans le registre doit devenir un vrai chemin. Le registre
 * s'ecrit a la main, on ne va pas y exiger des chemins absolus.
 */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}
