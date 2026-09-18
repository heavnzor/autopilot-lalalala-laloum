import { useCallback, useEffect, useMemo, useState } from "react";
import type { Progress, RunMark } from "./progress.ts";
import {
  type JsonValue,
  type LiveEvent,
  type PendingPlan,
  type PendingQuestion,
  type PlanVerdict,
  parseEvent,
} from "./event.ts";
import {
  EMPTY_TICKET,
  parentOfAgent,
  readTicket,
  STEPS,
  stepIndex,
  stepOfAgent,
  stepToken,
  type Ticket,
  topLevelStep,
} from "./ticket.ts";

export interface RunSnapshot {
  ticketId: string | null;
  /** L'etat du ticket, brut. Le shell le lit, il ne l'ecrit jamais. */
  ticket: JsonValue | null;
  events: LiveEvent[];
  question: PendingQuestion | null;
  /** Le plan soumis au gate du point 9, s'il attend. */
  plan: PendingPlan | null;
  ignored: { at: string; reason: string }[];
}

const EMPTY: RunSnapshot = {
  ticketId: null,
  ticket: null,
  events: [],
  question: null,
  plan: null,
  ignored: [],
};

/**
 * Trois etats, pas deux.
 *
 * Avec un booleen, le rendu serveur — qui n'a evidemment pas encore de SSE —
 * affichait « deconnecte » en rouge sur la premiere frame d'un run qui se porte
 * bien. On ne crie au probleme qu'apres une vraie tentative ratee.
 */
export type Connection = "connecting" | "open" | "closed";

export interface LoopCounter {
  readonly name: string;
  readonly count: number;
  readonly budget: number | null;
}

/**
 * Une seule source pour l'interface : l'instantane au chargement, puis le SSE.
 *
 * A chaque reconnexion on redemande l'instantane complet plutot que d'essayer
 * de rattraper les events manques. `seq` est monotone : c'est ce qui permet de
 * detecter un trou, et un trou vaut un rechargement, pas un rafistolage.
 */
export function useLiveRun(initial: RunSnapshot = EMPTY) {
  const [snapshot, setSnapshot] = useState<RunSnapshot>(initial);
  const [connection, setConnection] = useState<Connection>("connecting");

  const reload = useCallback(async () => {
    try {
      const response = await fetch("/rpc/state");
      if (response.ok) setSnapshot((await response.json()) as RunSnapshot);
    } catch {
      /* le SSE reprendra la main */
    }
  }, []);

  useEffect(() => {
    void reload();
    const source = new EventSource("/rpc/stream");

    source.addEventListener("open", () => setConnection("open"));
    source.addEventListener("error", () => setConnection("closed"));

    source.addEventListener("snapshot", (message) => {
      setConnection("open");
      setSnapshot(JSON.parse((message as MessageEvent).data) as RunSnapshot);
    });

    source.addEventListener("event", (message) => {
      const event = parseEvent(JSON.parse((message as MessageEvent).data));
      if (!event) return;
      setSnapshot((current) => {
        const known = current.events.some(
          (existing) => existing.runId === event.runId && existing.seq === event.seq,
        );
        return known ? current : { ...current, events: [...current.events, event] };
      });
    });

    // L'etat du ticket arrive tout seul : le serveur surveille le fichier et le
    // pousse quand il change. La page ne le redemande plus au fil des events —
    // elle attendait alors un `kind` precis qu'aucun agent n'etait tenu de
    // pousser, et se figeait sur sa premiere frame quand il ne venait pas.
    source.addEventListener("ticket", (message) => {
      const ticket = JSON.parse((message as MessageEvent).data) as JsonValue | null;
      setSnapshot((current) => ({ ...current, ticket }));
    });

    source.addEventListener("question", (message) => {
      setSnapshot((current) => ({
        ...current,
        question: JSON.parse((message as MessageEvent).data) as PendingQuestion,
      }));
    });

    source.addEventListener("answer", () => {
      setSnapshot((current) => ({ ...current, question: null }));
    });

    source.addEventListener("plan", (message) => {
      setSnapshot((current) => ({
        ...current,
        plan: JSON.parse((message as MessageEvent).data) as PendingPlan,
      }));
    });

    source.addEventListener("decision", () => {
      setSnapshot((current) => ({ ...current, plan: null }));
    });

    // Le lot n'est pas efface : il attend toujours une reponse, mais au
    // terminal. Le montrer disparaitre donnerait a croire qu'il est traite,
    // alors que le run est toujours arrete dessus.
    source.addEventListener("withdraw", () => {
      setSnapshot((current) => ({
        ...current,
        question: current.question ? { ...current.question, answerable: false } : null,
        plan: current.plan ? { ...current.plan, answerable: false } : null,
      }));
    });

    return () => source.close();
  }, [reload]);

  const answer = useCallback(async (id: string, answers: Record<string, string>): Promise<boolean> => {
    try {
      const response = await fetch("/rpc/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, answers }),
      });
      // 409 : le lot n'est plus la — repris au terminal, ou shell relance
      // depuis. Le module doit le dire au lieu de faire semblant d'avoir envoye.
      return response.ok;
    } catch {
      return false;
    }
  }, []);

  /** Le verdict du gate, par le meme chemin qu'une reponse a un lot. */
  const decide = useCallback(async (id: string, verdict: PlanVerdict, note: string): Promise<boolean> => {
    try {
      const response = await fetch("/rpc/decide", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, verdict, note }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }, []);

  const ticket = useMemo<Ticket>(
    () => (snapshot.ticket ? readTicket(snapshot.ticket) : EMPTY_TICKET),
    [snapshot.ticket],
  );

  const derived = useMemo(() => derive(snapshot.events, ticket.run.step, ticket.run.currentRepo, ticket.run.phase), [snapshot.events, ticket.run.step, ticket.run.currentRepo, ticket.run.phase]);
  const mark = useMemo(
    () => runMark(ticket, derived.step, derived.current, snapshot.question, snapshot.plan),
    [ticket, derived.step, derived.current, snapshot.question, snapshot.plan],
  );
  // Apres `mark`, parce qu'il en depend : l'etape courante ne peut pas etre
  // rouge pendant que le bandeau est vert.
  const steps = useMemo(
    () => deriveSteps(derived.step, derived.current, mark),
    [derived.step, derived.current, mark],
  );

  return {
    ...snapshot,
    ticket,
    ...derived,
    steps,
    mark,
    connection,
    connected: connection === "open",
    answer,
    decide,
    reload,
  };
}

/**
 * Un agent sous son etape.
 *
 * Il porte la meme echelle que l'etape au-dessus de lui — le `Progress` de la
 * page, pas un vocabulaire a lui. Un seul des deux tourne a la fois : quand
 * l'agent a le loader, son etape est `idle`, et inversement.
 */
export interface StepAgent {
  readonly name: string;
  readonly state: Progress;
  /**
   * Les agents que celui-ci a ouverts.
   *
   * Vide partout sauf sous l'`orchestrator`, seul agent du workflow qui en
   * invoque d'autres. Le rail les rend d'un cran plus a droite : c'est ce qui
   * fait lire « Implementation > orchestrator > developer » comme une
   * profondeur et pas comme un relais entre trois pairs.
   */
  readonly children: readonly StepAgent[];
}

export interface Derived {
  /** Le dernier event : ce qui se passe, la, maintenant. */
  readonly current: LiveEvent | null;
  /**
   * Le dernier event qui n'est pas une question.
   *
   * Un lot de questions a son propre module, en pleine largeur, sous le
   * bandeau. Le bandeau montre donc ce que l'agent faisait **avant** de
   * demander : on voit ce qui se passait et que ca s'est arrete sur toi, sans
   * que le contenu du lot soit recopie dans un en-tete qui n'est pas fait pour
   * lui.
   */
  readonly working: LiveEvent | null;
  /**
   * Le curseur persiste fait autorite, y compris lors d'un retour de boucle.
   * Le flux ne sert de repli qu'en l'absence d'un curseur lisible.
   */
  readonly step: string;
  readonly busy: boolean;
  readonly loops: readonly LoopCounter[];
  /**
   * Depuis quand l'etape courante dure — **son** debut, pas celui du run.
   *
   * Le rail affichait `run.startedAt`, donc il annoncait trois heures sur une
   * etape commencee il y a dix minutes. C'est precisement le signal de derive
   * qu'on voulait rendre, et il mentait.
   */
  readonly stepSince: string | null;
  /** Les agents de chaque etape, dans l'ordre ou ils ont pris la main. */
  readonly agents: ReadonlyMap<string, readonly StepAgent[]>;
  /** Le chantier de chaque depot, tel que les agents l'ont pousse. */
  readonly worksites: ReadonlyMap<string, Worksite>;
}

export function derive(events: readonly LiveEvent[], ticketStep: string, currentRepo: string | null = null, phase: string | null = null): Derived {
  const loops = new Map<string, LoopCounter>();
  for (const event of events) {
    if (event.kind !== "loop") continue;
    if (currentRepo && event.repo && event.repo !== currentRepo) continue;
    const payload = (event.payload ?? {}) as {
      name?: string;
      count?: number;
      budget?: number;
    };
    const name = payload.name ?? event.agent ?? "boucle";
    loops.set(name, {
      name,
      count: payload.count ?? 0,
      budget: payload.budget ?? null,
    });
  }

  const current = events.at(-1) ?? null;
  const lastStep = [...events].reverse().find((event) => event.kind === "step");
  const trail = walkSteps(events);
  const step = deriveStep(trail, ticketStep);

  // La meme lecture que la branche « running » de `runMark`, sur le seul flux :
  // ce qui fait tourner la pastille du bandeau doit faire pulser l'agent du
  // rail, sinon la page se contredit d'une colonne a l'autre.
  const live =
    current !== null &&
    current.status !== "ko" &&
    phase !== "done" && phase !== "completed";

  return {
    current,
    working: [...events].reverse().find((event) => event.kind !== "question") ?? null,
    step,
    busy: current !== null && ["start", "progress", "waiting"].includes(current.status),
    loops: [...loops.values()],
    stepSince: lastStep?.ts ?? null,
    agents: deriveAgents(events, trail, current, live, step),
    worksites: deriveWorksites(events),
  };
}

/**
 * Le chantier d'un depot : ce que le cycle 10.x fabrique, pendant qu'il le
 * fabrique.
 *
 * Rien ici n'est calcule par le shell. Tout vient du `payload` que les agents
 * poussent — la todo du `developer`, les fichiers de chaque commit avec leur
 * `+n -n`, le verdict de chaque verification. Ce que le shell ne recoit pas, il
 * ne l'affiche pas : il n'y a pas de chiffre reconstitue ici.
 */
export interface Todo {
  readonly text: string;
  readonly status: "pending" | "in_progress" | "completed";
}

export interface TouchedFile {
  readonly path: string;
  readonly added: number | null;
  readonly removed: number | null;
}

export interface Check {
  readonly kind: string;
  readonly passed: boolean;
  readonly durationMs: number | null;
  readonly at: string;
}

export interface Worksite {
  readonly repo: string;
  readonly todos: readonly Todo[];
  readonly files: readonly TouchedFile[];
  readonly commits: number;
  readonly checks: readonly Check[];
}

const TODO_STATUS = new Set(["pending", "in_progress", "completed"]);

function deriveWorksites(events: readonly LiveEvent[]): Map<string, Worksite> {
  const out = new Map<
    string,
    {
      todos: Todo[];
      files: Map<string, TouchedFile>;
      commits: number;
      checks: Map<string, Check>;
    }
  >();
  const of = (repo: string) => {
    const existing = out.get(repo);
    if (existing) return existing;
    const fresh = {
      todos: [],
      files: new Map<string, TouchedFile>(),
      commits: 0,
      checks: new Map<string, Check>(),
    };
    out.set(repo, fresh);
    return fresh;
  };

  for (const event of events) {
    if (!event.repo) continue;
    const payload = (event.payload ?? {}) as {
      items?: { text?: string; content?: string; status?: string }[];
      commit?: {
        files?: { path?: string; added?: number; removed?: number }[];
      };
      check?: { kind?: string; passed?: boolean; durationMs?: number };
    };
    const site = of(event.repo);

    // La todo est remplacee, jamais fusionnee : `TodoWrite` rend la liste
    // entiere a chaque fois, et fusionner ferait survivre une ligne supprimee.
    if (event.kind === "todo" && Array.isArray(payload.items)) {
      site.todos = payload.items
        .map((item) => ({
          text: String(item.text ?? item.content ?? "").trim(),
          status: (TODO_STATUS.has(String(item.status)) ? item.status : "pending") as Todo["status"],
        }))
        .filter((item) => item.text !== "");
    }

    if (payload.commit) {
      site.commits += 1;
      for (const file of payload.commit.files ?? []) {
        const path = String(file.path ?? "").trim();
        if (!path) continue;
        const seen = site.files.get(path);
        // Un fichier touche par deux commits cumule ses deux diffs : c'est le
        // total du chantier qu'on lit, pas celui du dernier commit.
        site.files.set(path, {
          path,
          added: sum(seen?.added, file.added),
          removed: sum(seen?.removed, file.removed),
        });
      }
    }

    if (payload.check?.kind) {
      site.checks.set(payload.check.kind, {
        kind: payload.check.kind,
        passed: payload.check.passed === true,
        durationMs: typeof payload.check.durationMs === "number" ? payload.check.durationMs : null,
        at: event.ts,
      });
    }
  }

  const sites = new Map<string, Worksite>();
  for (const [repo, site] of out) {
    sites.set(repo, {
      repo,
      todos: site.todos,
      files: [...site.files.values()].sort((a, b) => a.path.localeCompare(b.path)),
      commits: site.commits,
      checks: [...site.checks.values()],
    });
  }
  return sites;
}

function sum(left: number | null | undefined, right: number | undefined): number | null {
  if (typeof right !== "number") return left ?? null;
  return (left ?? 0) + right;
}

/**
 * Un curseur d'etape qui distingue le point et son sous-point.
 *
 * Le point et son sous-point sont tenus separement : le cycle d'implementation
 * tient entier dans le point 10, donc compare sur le seul point, `10.6` et
 * `10.1` sont a egalite, et le rail affichait encore `.3` pendant que le
 * `developer` commitait en `.4`.
 */
interface Cursor {
  step: string | null;
  rank: number;
  sub: number;
}

function advance(cursor: Cursor, raw: string | null | undefined, authoritative = false): void {
  if (!raw) return;
  const token = stepToken(raw);
  const rank = token ? stepIndex(token.top) : -1;
  // Une etape qu'on ne sait pas lire ne fait pas avancer le curseur : elle le
  // ferait reculer a -1, et tout le flux d'apres tomberait avec elle.
  if (!token || rank < 0) return;
  const sub = token.sub;
  if (authoritative || rank > cursor.rank || (rank === cursor.rank && sub > cursor.sub)) {
    cursor.step = raw;
    cursor.rank = rank;
    cursor.sub = sub;
  }
}

/**
 * Ou un event se situe, et si on le sait vraiment.
 *
 * `sure` est faux quand ni l'estampille ni le nom de l'agent n'ont rien dit :
 * `step` ne vaut alors que la position du curseur, c'est-a-dire l'etape de
 * quelqu'un d'autre. Un agent range la-dessus est range au hasard — c'est comme
 * ca que le `doc-scout` pousse sous le nom invente `memory-scout` s'est
 * retrouve a tourner sous « Questions fonctionnelles », trois etapes en
 * arriere, pendant que le rail montrait « Memoire, tour cible ».
 */
interface Placed {
  readonly step: string | null;
  readonly sure: boolean;
}

/**
 * L'etape de **chaque** event, recoupee au fil du flux.
 *
 * L'estampille que le tool pose sur un event est lue dans le YAML, et le
 * workflow ecrit le YAML **apres** chaque point : pendant tout le travail du
 * `functional-grill`, les events partaient estampilles de l'etape precedente.
 * Le bandeau s'en sortait — il recoupait avec l'agent qui parle — mais le rail
 * rattachait les agents sur l'estampille brute. Resultat : le curseur montrait
 * « Questions fonctionnelles » vide pendant que le `functional-grill` etait
 * range sous « Lecture du ticket », replie, deux lignes plus haut.
 *
 * On refait donc le meme recoupement, mais event par event. L'ordre compte :
 * l'estampille passe avant l'agent, parce que c'est elle qui donne le plancher
 * a partir duquel on tranche les deux passages du `doc-scout`.
 *
 * Le tableau rendu est aligne sur `events`, indice par indice. `null` tant
 * qu'aucune lecture n'a rien dit : un event qu'on ne sait pas situer reste dans
 * le flux, il ne remonte pas dans le rail.
 */
function walkSteps(events: readonly LiveEvent[]): readonly Placed[] {
  const cursor: Cursor = { step: null, rank: -1, sub: 0 };

  return events.map((event) => {
    const stamped = Boolean(event.step) && stepIndex(String(event.step)) >= 0;
    advance(cursor, event.step, stamped);

    const implied = event.agent ? stepOfAgent(event.agent, cursor.rank) : null;
    if (!stamped) advance(cursor, implied, true);

    return { step: cursor.step, sure: stamped || implied !== null };
  });
}

/**
 * Le YAML porte le curseur courant. Choisir le maximum historique masquerait
 * les reprises, les retours au cadrage et le debut du depot suivant.
 */
function deriveStep(trail: readonly Placed[], ticketStep: string): string {
  // Le curseur peut reculer : nouvelle iteration, autre depot, plan rejete.
  // Une ancienne etape plus haute n'a aucune autorite sur l'etat courant.
  return stepToken(ticketStep) ? ticketStep : trail.at(-1)?.step ?? ticketStep;
}

/**
 * L'etat des treize etapes, dans l'ordre du rail.
 *
 * Une seule chose tourne a la fois dans ce workflow, et c'est ce qui rend le
 * modele lisible : **l'etape a le loader tant qu'elle travaille elle-meme, et
 * le rend a son sous-agent des qu'elle en ouvre un**. Le dernier event dit
 * lequel des deux a la main — il porte un `agent` ou il n'en porte pas.
 *
 * Le cycle complet d'une etape :
 *
 * ```
 * todo ──> running ──> idle ──> running ──> done
 *          (le point)  (son     (il a       (le point
 *                       agent)   rendu)      suivant s'ouvre)
 * ```
 *
 * `idle` ne veut donc plus dire « il ne se passe rien » — il ne l'a jamais
 * voulu, mais la page le laissait croire. Il veut dire « cette ligne-ci n'agit
 * pas », et la ligne qui agit est juste en dessous.
 */
function deriveSteps(step: string, current: LiveEvent | null, mark: RunMark): readonly Progress[] {
  const here = stepIndex(step);

  return STEPS.map((_, index) => {
    if (here < 0 || index > here) return "todo";
    // Le workflow est passe dessus et n'y reviendra pas : une etape depassee
    // est rendue, quoi qu'il se soit dit dedans.
    if (index < here) return "done";

    // L'etape courante. L'arret et la fin priment : un run arrete sur une etape
    // qui avait passe la main doit montrer l'arret, pas la main passee.
    if (mark === "error" || mark === "done") return mark;
    // Ce qui s'arrete sur toi remonte, lui. Un lot de questions bloque l'etape
    // entiere, pas seulement l'agent qui l'a pose : « Questions fonctionnelles »
    // et « Approbation » doivent porter la couleur de l'attente, meme quand
    // c'est leur sous-agent qui demande. C'est la seule chose qui traverse les
    // deux niveaux, parce que c'est la seule qui te concerne.
    if (mark === "human") return "human";
    // Un sous-agent travaille. Ce qu'il fait se lit sur sa ligne a lui, et
    // l'etape n'agit pas pendant ce temps.
    if (current?.agent) return "idle";
    // L'etape elle-meme a la main : elle porte son etat en propre.
    return mark === "idle" ? "idle" : "running";
  });
}

/**
 * L'etat d'un agent, lu sur son dernier event.
 *
 * `start` et `progress` donnent `idle`, pas `running` : ils disent qu'il a pris
 * la main, pas qu'il l'a encore. Seul celui qui a pousse le **dernier** event
 * du flux l'a encore, et c'est `deriveAgents` qui le promeut — sans quoi
 * l'`orchestrator`, ouvert pendant tout le cycle 10.x, ferait tourner un
 * deuxieme loader a cote de celui du `developer`.
 */
const AGENT_STATE: Record<string, Progress> = {
  start: "idle",
  progress: "idle",
  waiting: "human",
  ko: "error",
  ok: "done",
};

/**
 * Qui a pris la main sous chaque etape.
 *
 * L'etat d'un agent vient de son **dernier** event dans l'etape, quel qu'en
 * soit le kind : un agent qui pose une question via `ask-user` attend un
 * humain, meme si sa derniere prise de main disait « je demarre ».
 *
 * **Seul le dernier a parler a encore la main.** Le workflow n'a pas de
 * parallelisme : il y a donc au plus un loader a l'ecran, et c'est celui-la.
 * Les autres agents de l'etape sont `idle` s'ils ont pris la main sans la
 * rendre — l'`orchestrator` pendant que le `developer` commite — et `done`
 * quand leur dernier event la rend.
 *
 * Le corollaire porte l'autre moitie du bug : **`ok` ferme une action, pas un
 * agent**. Un `functional-grill` qui vient d'enregistrer un lot de reponses a
 * pousse un `ok` et prepare deja le suivant. Le lire comme « a rendu »
 * l'eteignait pendant douze minutes de travail, sur le seul agent vivant de la
 * page. Il garde donc le loader tant qu'un autre n'a pas parle.
 *
 * **Un agent qu'on ne sait pas situer n'est range nulle part** — sauf s'il a la
 * main, auquel cas on sait ou il est : la, maintenant, a l'etape du run. Le
 * milieu, c'etait le range-au-hasard : un `doc-scout` pousse sous le nom
 * invente `memory-scout` n'est reconnu par rien, le curseur ne bouge donc pas
 * pour lui, et il se posait sous l'etape du dernier agent connu — trois etapes
 * en arriere, avec le loader, pendant que le rail montrait la bonne etape vide.
 */
function deriveAgents(
  events: readonly LiveEvent[],
  trail: readonly Placed[],
  current: LiveEvent | null,
  live: boolean,
  step: string,
): ReadonlyMap<string, readonly StepAgent[]> {
  const perStep = new Map<string, Map<string, Progress>>();
  const file = (at: string, name: string, state: Progress) => {
    const seen = perStep.get(at) ?? new Map<string, Progress>();
    // `set` sur une cle deja presente garde sa place d'insertion : l'ordre reste
    // celui des prises de main, l'etat est celui du dernier event.
    seen.set(name, state);
    perStep.set(at, seen);
    return seen;
  };

  events.forEach((event, index) => {
    const at = trail[index];
    if (!event.agent || !at?.step || !at.sure) return;
    file(topLevelStep(at.step), event.agent, AGENT_STATE[event.status] ?? "done");
  });

  // Celui qui tient la main. Un meme nom peut apparaitre sous deux etapes — le
  // `doc-scout` passe deux fois — et seule sa derniere prise de main est
  // vivante, a l'etape ou le run se trouve.
  const holder = live ? (current?.agent ?? null) : null;
  if (holder) {
    const at = topLevelStep(step);
    const held = perStep.get(at);
    const state = held?.get(holder);
    // Ni une escalade ni une question en attente ne deviennent un loader : ce
    // sont des etats terminaux de sa ligne, et ils priment sur la main.
    if (state === undefined || state === "idle" || state === "done") file(at, holder, "running");

    // Et son parent l'a forcement ouvert : un `orchestrator` dont le
    // `developer` commite n'a pas rendu, il attend. Son dernier event disait
    // `ok` — la fin de son routage, pas la fin de son tour.
    const parent = parentOfAgent(holder);
    if (parent && held?.get(parent) === "done") file(at, parent, "idle");
  }

  const out = new Map<string, readonly StepAgent[]>();
  for (const [at, seen] of perStep) out.set(at, nest(seen));
  return out;
}

/**
 * Les agents d'une etape, remis dans l'ordre ou ils s'invoquent.
 *
 * Un enfant ne remonte sous son parent que si ce parent a parle dans la meme
 * etape. Sinon il reste a plat : mieux vaut un `developer` au premier rang
 * qu'un `developer` accroche a un `orchestrator` qui n'existe pas dans ce que
 * la page a recu.
 */
function nest(seen: ReadonlyMap<string, Progress>): readonly StepAgent[] {
  const children = new Map<string, StepAgent[]>();
  for (const name of seen.keys()) {
    const parent = parentOfAgent(name);
    if (parent && seen.has(parent)) children.set(parent, children.get(parent) ?? []);
  }

  const roots: StepAgent[] = [];
  for (const [name, state] of seen) {
    const node = { name, state, children: children.get(name) ?? [] };
    const parent = parentOfAgent(name);
    const under = parent ? children.get(parent) : undefined;
    if (under) under.push(node);
    else roots.push(node);
  }
  return roots;
}

/**
 * L'etat du run, ramene a un seul signe.
 *
 * **L'ordre est la regle, pas une commodite d'ecriture.** Un run escalade
 * pendant qu'une question attendait encore doit montrer l'arret : c'est ce qui
 * decide si on vient repondre ou si on vient reprendre la main. L'inverse
 * enverrait quelqu'un taper une reponse dans un run qui ne tourne plus.
 *
 * Le flux SSE coupe n'apparait pas ici : c'est le shell qui va mal, pas le run,
 * et confondre les deux ferait mentir la page sur la seule chose qu'elle sait.
 */
export function runMark(
  ticket: Ticket,
  _step: string,
  current: LiveEvent | null,
  question: PendingQuestion | null,
  plan: PendingPlan | null = null,
): RunMark {
  if (ticket.run.escalation !== null || current?.status === "ko") return "error";
  if (question !== null || plan !== null || current?.status === "waiting") return "human";
  // Rien n'a encore ete pousse : c'est le seul repos qu'un run connaisse.
  if (current === null) return "idle";
  // La fin est explicite ; un `ok` intermediaire du finalizer ne suffit pas.
  if (ticket.run.phase === "done" || ticket.run.phase === "completed") return "done";
  // Partout ailleurs, un `ok` clot une **action**. Entre deux events, l'agent
  // n'attend pas : il lit, il reflechit, il prepare le lot suivant. La page le
  // rendait « au repos », pastille grise, pendant douze minutes de travail —
  // exactement l'inverse de ce qui se passait, et le seul etat qu'on lisait
  // depuis l'autre bout de la piece.
  //
  // Un vrai blocage ne se lit donc plus a la couleur mais a la duree : c'est le
  // role du « silencieux depuis » du bandeau, qui compte a partir de cinq
  // minutes sans event. Une pastille grise ne disait pas depuis quand.
  return "running";
}
