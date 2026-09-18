import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateConfig, validateRegistry } from "./config-schema.ts";
import { fail } from "./errors.ts";
import { expandTilde, projectRoot } from "./paths.ts";
import { parseYaml } from "./yaml.ts";

export type TestKind = "ut" | "it" | "ft" | "ct" | "e2e";
export type CommandKind = TestKind | "lint" | "typecheck";

/**
 * Ce qu'un repo demande a la machine avant de pouvoir etre teste. Declare, comme
 * les commandes : deduire « ce repo utilise des conteneurs » d'un docker-compose
 * trouve au hasard remettrait de la devinette la ou le registre existe pour ne
 * plus en avoir.
 */
export interface ContainerNeeds {
  readonly required: boolean;
  readonly images: readonly string[];
}

/**
 * Ou une commande ecrit son rapport quand elle ne l'ecrit pas sur la sortie.
 *
 * Le cas qui nous a mordu : `biome ci --reporter=gitlab > code-quality.json`.
 * La commande sort en echec, sa sortie est vide, et le diagnostic est dans un
 * fichier que personne ne lit. Deux heures de run ont ete passees a le
 * chercher a la main.
 */
export type ReportPaths = Partial<Record<CommandKind, string>>;

/**
 * Comment ce repo se laisse cibler sur un fichier, commande par commande.
 *
 * Tous les runners ne prennent pas une liste de fichiers en arguments libres.
 * `mtr`, celui de nos services Node, fait un `parseArgs` sans `allowPositionals` :
 * lui passer un chemin rend `ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL` avant meme
 * d'avoir lance un test. Il accepte pourtant un ciblage — par `-g` — et un
 * second `-g` ecrase celui que le script npm porte deja.
 *
 * Sur FT-1042, le red-checker a lu le refus des positionnels et conclu « ce
 * repo n'est pas ciblable ». Il l'etait ; personne n'avait dit comment. C'est
 * ce que cette cle declare, pour que le tool compose la commande au lieu
 * d'empiler des chemins en esperant.
 *
 * Le gabarit porte un emplacement, `{paths}` ou `{glob}` :
 *
 * - `{paths}` -> les chemins, echappes, separes par une espace
 * - `{glob}`  -> un motif unique, accolades si plusieurs chemins
 *
 * Trois etats, et la difference compte :
 *
 * - cle absente -> `{paths}`, les chemins ajoutes en fin de commande. C'est ce
 *   qu'acceptent vitest, jest et `node --test`.
 * - gabarit     -> on remplit l'emplacement.
 * - `null`      -> ce type ne se cible pas ici. Le tool refuse `paths` au lieu
 *   de fabriquer une commande fausse : sur `api-service`, la suite unitaire
 *   passe par le binaire `glob`, dont un motif supplementaire ELARGIT la suite.
 *   Un ciblage silencieusement inverse est pire qu'un ciblage refuse.
 */
export type TargetingTemplates = Partial<Record<CommandKind, string | null>>;

export interface RepoEntry {
  readonly name: string;
  readonly level: number;
  readonly path: string;
  readonly gitlabProject: string;
  readonly baseBranch: string;
  readonly layer: "front" | "backend" | "data" | "eval";
  readonly packageManager: "npm" | "pnpm" | "yarn";
  readonly monorepoTool: "turbo" | "lerna" | null;
  readonly packageName: string | null;
  readonly dependsOn: readonly string[];
  readonly commands: Readonly<Record<CommandKind, string | null>>;
  /**
   * Un repo qui n'a deliberement aucun type de test le declare. Sans cette cle,
   * rien ne distingue « ce repo n'a pas de suite » de « les commandes ont
   * disparu du registre sans que personne ne s'en apercoive ».
   */
  readonly withoutTests?: boolean;
  /**
   * Les fichiers de configuration locale a porter dans le worktree.
   *
   * `.env` et ses voisins sont gitignores : `git worktree add` ne les emmene
   * donc pas, et un worktree neuf demarre sans secrets. Sur `sheet-service`
   * la consequence est nette — la CLAUDE.md du depot le dit noir sur blanc :
   * sans les quatre valeurs obligatoires, le serveur ne boote pas, donc aucun
   * test fonctionnel ne tourne. Le red-checker prend alors une panne
   * d'environnement pour un test rouge, ou escalade sans savoir pourquoi.
   *
   * Chemins relatifs a la racine du depot. Copies depuis la source vers le
   * worktree, jamais l'inverse, et jamais par-dessus un fichier existant.
   */
  readonly localFiles?: readonly string[];
  readonly reports?: ReportPaths;
  readonly targeting?: TargetingTemplates;
  readonly containers?: ContainerNeeds;
  readonly ciJobsToWatch: readonly string[];
  readonly description: string;
  readonly keywords: readonly string[];
}

export interface Registry {
  readonly schemaVersion: number;
  readonly repositories: readonly RepoEntry[];
  readonly evalOnly: { readonly repos: readonly string[]; readonly jiraProjects: readonly string[] };
}

export interface AutopilotConfig {
  readonly schemaVersion: number;
  readonly budgets: {
    readonly testAdversary: number;
    readonly redChecker: number;
    readonly testDispute: number;
    readonly greenChecker: number;
    readonly codeAdversary: number;
    readonly disputeBeforeEscalation: number;
    /**
     * Lignes de checklist code qu'un `developer` traite avant de rendre la main.
     * Au dela, il rend un lot et l'orchestrateur le rappelle : le contexte d'un
     * agent qui tient tout le chantier en une passe finit par couter plus cher
     * en latence que les tours qu'il economise.
     */
    readonly developerBatchLines: number;
  };
  readonly timeouts: {
    readonly ciPipelineSeconds: number;
    readonly askUserSeconds?: number;
    readonly repoSetupSeconds: number;
    readonly commandSeconds: number;
    /** Silence tolere avant abandon, plafond global mis a part. */
    readonly commandSilenceSeconds: number;
    readonly containerStartSeconds: number;
    readonly imagePullSeconds: number;
  };
  readonly memory: {
    readonly maxNoteLines: number;
    readonly docScout: { readonly maxFilesRead: number; readonly maxOutputLines: number };
  };
  readonly naming: {
    readonly types: readonly string[];
    readonly branch: string;
    readonly mergeRequest: string;
    readonly slackChannel: string;
    readonly devVersionSuffix: string;
    readonly slugMaxLength: number;
    readonly typeFromJiraIssueType: Readonly<Record<string, string>>;
  };
  /**
   * Identite portee par les commits que l'autopilot ecrit dans les worktrees.
   * Absente, c'est l'identite git de la machine qui s'applique — le cas normal
   * quand une seule personne fait tourner l'outil.
   */
  readonly git?: {
    readonly committer?: { readonly name: string; readonly email: string };
  } | null;
  readonly gitlab: {
    readonly mrDraft: boolean;
    readonly mrDescriptionLanguage: string;
    readonly commitLanguage: string;
    readonly commitConvention: string;
  };
  readonly jira: {
    readonly baseUrl: string;
    readonly assignToSelf: boolean;
    readonly transitions: SquadIndexed<{ readonly apresMr: string }>;
  };
  readonly slack: {
    readonly channelVisibility: "private" | "public";
    readonly invitees: SquadIndexed<readonly string[]>;
  };
  readonly liveMode: { readonly portRange: readonly [number, number]; readonly openBrowser: boolean };
  readonly limits?: { readonly commandOutputBytes?: number };
}

/**
 * Une seule forme pour tout ce qui varie d'une equipe a l'autre. Les cles de
 * reglage restent en dehors de `bySquad` : sans cette separation, le code doit
 * maintenir une liste noire de cles reservees, et le jour ou une squad s'appelle
 * comme un reglage, le bug est silencieux.
 */
export interface SquadIndexed<T> {
  readonly default: T;
  readonly bySquad: Readonly<Record<string, T>>;
}

let configCache: AutopilotConfig | null = null;
let registryCache: Registry | null = null;

export function loadConfig(): AutopilotConfig {
  if (configCache) return configCache;
  const raw = readOrFail("autopilot.yaml");
  const parsed = parseYaml<AutopilotConfig>(raw);
  validateConfig(parsed);
  if (parsed?.schemaVersion !== 1) {
    fail(`autopilot.yaml : schemaVersion ${String(parsed?.schemaVersion)} inconnue, attendu 1.`);
  }
  if (parsed.liveMode.portRange[0] >= parsed.liveMode.portRange[1]) fail("La plage de ports doit etre croissante.");
  configCache = {
    ...parsed,
    budgets: { ...parsed.budgets, developerBatchLines: parsed.budgets.developerBatchLines ?? 4 },
    timeouts: { ...parsed.timeouts, commandSilenceSeconds: parsed.timeouts.commandSilenceSeconds ?? 240, containerStartSeconds: parsed.timeouts.containerStartSeconds ?? 180, imagePullSeconds: parsed.timeouts.imagePullSeconds ?? 600 },
  };
  return configCache;
}

export function loadRegistry(): Registry {
  if (registryCache) return registryCache;
  const raw = readOrFail("repositories.yaml");
  const parsed = parseYaml<Registry>(raw);
  validateRegistry(parsed);
  if (parsed?.schemaVersion !== 1) {
    fail(`repositories.yaml : schemaVersion ${String(parsed?.schemaVersion)} inconnue, attendu 1.`);
  }
  assertRegistryCoherent(parsed);
  registryCache = parsed;
  return parsed;
}

/** Les tests reconstruisent la config a chaque cas : le cache doit pouvoir tomber. */
export function resetConfigCache(): void {
  configCache = null;
  registryCache = null;
}

export function findRepo(name: string): RepoEntry {
  const repo = loadRegistry().repositories.find((r) => r.name === name);
  if (!repo) {
    const known = loadRegistry().repositories.map((r) => r.name).join(", ");
    fail(`Repo inconnu du registre : ${name}.`, `Repos declares : ${known}`);
  }
  return repo;
}

export function repoRoot(repo: RepoEntry): string {
  return resolve(projectRoot(), expandTilde(repo.path));
}

/** Ordre de traitement : amont vers aval, `level` croissant, nom en depart d'egalite. */
export function orderByLevel(repos: readonly RepoEntry[]): readonly RepoEntry[] {
  return [...repos].sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
}

/**
 * Resolution par squad, en deux temps : `bySquad[squad]`, sinon `default`.
 * Pas d'heritage implicite, pas de resolution partielle.
 *
 * La comparaison est insensible a la casse : `FT`, `Ft` et `ft` designent la
 * meme squad. Une resolution sensible a la casse produirait un repli silencieux
 * sur `default`, donc un canal sans personne dedans et aucun message d'erreur.
 */
export function resolveBySquad<T>(indexed: SquadIndexed<T>, squad: string): T {
  const wanted = squad.trim().toLowerCase();
  for (const [key, value] of Object.entries(indexed.bySquad ?? {})) {
    if (key.trim().toLowerCase() === wanted) return value;
  }
  return indexed.default;
}

/** La squad d'un ticket, c'est le prefixe de sa cle Jira : `FT` dans `FT-1025`. */
export function squadOf(ticketKey: string): string {
  const match = /^([A-Za-z][A-Za-z0-9_]*)-\d+$/.exec(ticketKey.trim());
  if (!match?.[1]) {
    fail(`Cle Jira mal formee : ${ticketKey}.`, "Attendu <PROJET>-<numero>, par exemple FT-1025.");
  }
  return match[1].toUpperCase();
}

/**
 * Un repo de banc d'essai ne doit jamais tomber dans le perimetre d'un vrai
 * ticket, et un vrai repo ne doit jamais etre touche par un ticket de test.
 */
export function isRepoEligible(repo: RepoEntry, ticketKey: string): boolean {
  const { evalOnly } = loadRegistry();
  const squad = squadOf(ticketKey);
  const isEvalTicket = evalOnly.jiraProjects.some((p) => p.toUpperCase() === squad);
  const isEvalRepo = evalOnly.repos.includes(repo.name);
  return isEvalTicket === isEvalRepo;
}

export function commandFor(repo: RepoEntry, kind: CommandKind): string | null {
  return repo.commands?.[kind] ?? null;
}

export function reportPathFor(repo: RepoEntry, kind: CommandKind): string | null {
  return repo.reports?.[kind] ?? null;
}

/**
 * Le gabarit de ciblage du repo. `null` dit que ce type ne se cible pas, et se
 * distingue de la cle absente, qui vaut l'ajout en fin de commande.
 */
export function targetingFor(repo: RepoEntry, kind: CommandKind): string | null {
  const declared = repo.targeting;
  if (!declared || !(kind in declared)) return "{paths}";
  return declared[kind] ?? null;
}

/** Un repo sans bloc `containers` ne demande rien : c'est le cas courant. */
export function containerNeedsOf(repo: RepoEntry): ContainerNeeds {
  return { required: repo.containers?.required ?? false, images: repo.containers?.images ?? [] };
}

/**
 * Le fichier reel s'il existe, le modele versionne sinon.
 *
 * `autopilot.yaml` et `repositories.yaml` decrivent une infrastructure : ils
 * sont gitignores, donc absents d'un clone neuf. Sans ce repli, rien ne
 * tournerait avant qu'on les ait ecrits — ni la suite de tests, ni
 * `config:check`. Avec lui, le depot se clone et se verifie tel quel, et le
 * jour ou le vrai fichier apparait il prend la main sans rien a changer.
 */
function readOrFail(name: string): string {
  const root = projectRoot();
  for (const candidate of [join(root, name), join(root, name.replace(/\.yaml$/, ".example.yaml"))]) {
    try {
      return readFileSync(candidate, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return fail(
    `${name} introuvable dans ${root}, et son modele non plus.`,
    `Copie le modele : cp ${name.replace(/\.yaml$/, ".example.yaml")} ${name}`,
  );
}

/** Le chemin effectivement lu, modele compris. Utile aux tests et aux scripts. */
export function configPathOf(name: "autopilot.yaml" | "repositories.yaml"): string {
  const root = projectRoot();
  const real = join(root, name);
  return existsSync(real) ? real : join(root, name.replace(/\.yaml$/, ".example.yaml"));
}

/**
 * Deux incoherences de registre cassent le run tres loin de leur cause : une
 * dependance vers un repo inexistant, et une dependance qui remonte le courant.
 * Les deux se detectent ici, au chargement, pour une lecture de fichier.
 */
function assertRegistryCoherent(registry: Registry): void {
  const byName = new Map(registry.repositories.map((r) => [r.name, r]));
  if (byName.size !== registry.repositories.length) fail("repositories.yaml : noms de depots dupliques.");
  for (const name of registry.evalOnly.repos) if (!byName.has(name)) fail(`Repo d'eval inconnu : ${name}.`);
  for (const repo of registry.repositories) {
    const hasTests = ["ut", "it", "ft", "ct", "e2e"].some((kind) => repo.commands[kind as CommandKind]);
    if (!hasTests && !repo.withoutTests) fail(`${repo.name} ne declare aucun test.`, "Declare withoutTests: true si ce choix est intentionnel.");
    if (hasTests && repo.withoutTests) fail(`${repo.name} declare a la fois des tests et withoutTests: true.`);
    for (const [kind, template] of Object.entries(repo.targeting ?? {})) {
      if (template !== null && !template?.includes("{paths}") && !template?.includes("{glob}")) fail(`${repo.name}.${kind} : gabarit de ciblage sans emplacement.`);
    }
    for (const upstream of repo.dependsOn ?? []) {
      const target = byName.get(upstream);
      if (!target) {
        fail(`repositories.yaml : ${repo.name} dependsOn ${upstream}, qui n'est pas declare.`);
      }
      if (target.level >= repo.level) {
        fail(
          `repositories.yaml : ${repo.name} (level ${repo.level}) dependsOn ${upstream} (level ${target.level}).`,
          "Un repo amont doit avoir un level strictement inferieur, sinon l'ordre de traitement ne veut plus rien dire.",
        );
      }
    }
  }
}
