import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { fail } from "./errors.ts";
import { projectRoot } from "./paths.ts";

/**
 * Les secrets ne traversent jamais le contexte d'un agent.
 *
 * `secret()` est appele par les clients http, dans le process du serveur de
 * tools. Ce qu'un agent peut obtenir, c'est `describeEnv()` : la liste des cles
 * et le fait qu'elles soient renseignees ou non. Rien d'autre.
 */

const KNOWN_KEYS = [
  "SLACK_USER_TOKEN",
  "SLACK_SELF_USER_ID",
  "GITLAB_HOST",
  "GITLAB_TOKEN",
  "JIRA_SITE_URL",
  "JIRA_EMAIL",
  "JIRA_API_TOKEN",
  "FIGMA_TOKEN",
  // Bases d'API surchargeables. En production elles ne sont jamais renseignees ;
  // c'est ce qui permet aux tests de workflow de substituer de faux serveurs
  // sans qu'aucun tool n'ait a savoir qu'il tourne en sandbox.
  "SLACK_API_BASE",
  "FIGMA_API_BASE",
] as const;

export type EnvKey = (typeof KNOWN_KEYS)[number];

let cache: Map<string, string> | null = null;

function load(): Map<string, string> {
  if (cache) return cache;
  const values = new Map<string, string>();
  const path = process.env.AUTOPILOT_ENV_FILE ?? join(projectRoot(), ".env");
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    raw = "";
  }
  for (const [key, value] of Object.entries(parseEnv(raw))) {
    if (value) values.set(key, value);
  }
  // L'environnement du process l'emporte : c'est ce qui permet aux tests de
  // workflow de pointer vers de faux serveurs sans toucher au `.env` reel.
  for (const key of KNOWN_KEYS) {
    const fromProcess = process.env[key];
    if (fromProcess) values.set(key, fromProcess);
  }
  cache = values;
  return values;
}

export function resetEnvCache(): void {
  cache = null;
}

/** Valeur brute. Ne doit jamais etre renvoyee dans une reponse de tool. */
export function secret(key: EnvKey): string {
  const value = load().get(key);
  if (!value) {
    fail(
      `Secret manquant : ${key}.`,
      `Renseigne-le dans le .env du projet (voir .env.example), puis relance.`,
    );
  }
  return value;
}

export function optionalSecret(key: EnvKey): string | null {
  return load().get(key) ?? null;
}

export function hasSecret(key: EnvKey): boolean {
  return Boolean(load().get(key));
}

/** Ce qu'un agent a le droit de voir de l'environnement. */
export function describeEnv(): { key: EnvKey; present: boolean; required: boolean }[] {
  const optional: readonly EnvKey[] = [
    "FIGMA_TOKEN",
    "SLACK_SELF_USER_ID",
    "GITLAB_HOST",
    "SLACK_API_BASE",
    "FIGMA_API_BASE",
  ];
  return KNOWN_KEYS.map((key) => ({
    key,
    present: hasSecret(key),
    required: !optional.includes(key),
  }));
}
