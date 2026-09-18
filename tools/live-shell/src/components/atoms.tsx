import { useEffect, useState } from "react";
import { cn } from "#/lib/utils";
import type { Progress } from "../lib/progress.ts";
export type { Progress, RunMark } from "../lib/progress.ts";

/**
 * Les quelques primitives de la page.
 *
 * Pas de carte, pas de conteneur generique : le dossier est fait de filets et
 * de texte courant. Ce qui reste ici, c'est ce qui porte de l'etat.
 */

/** La seule motion continue de la page. */
export function Spinner({ className }: { className?: string }) {
  return (
    <output
      aria-label="en cours"
      className={cn(
        "spin-quiet block size-3 shrink-0 rounded-full border-[1.5px] border-ink-faint/30 border-t-ink",
        className,
      )}
    />
  );
}

/**
 * Un seul vocabulaire d'etat pour toute la page.
 *
 * Le rail et le bandeau parlaient de la meme chose avec deux jeux de mots et
 * deux codes couleur — le vert y voulait dire « vivant » sur un agent et
 * « reussi » sur le run. Deux sens pour une couleur, sur la meme colonne, a
 * vingt pixels d'ecart : c'est exactement le cout de recoupement que cette page
 * existe pour supprimer. Il n'y a plus qu'une echelle, et elle se lit pareil
 * partout.
 *
 * - `todo` — cercle vide, contour seul. Le workflow n'y est pas encore venu.
 * - `running` — le loader. **Une seule chose tourne a la fois** : le workflow
 *   n'a pas de parallelisme, donc deux loaders a l'ecran seraient un bug.
 * - `idle` — pastille sourde. Ouvert, mais pas en train d'agir : c'est l'etat
 *   d'une etape qui a passe la main a son sous-agent, et de l'orchestrateur qui
 *   a passe la main au developpeur. Ce n'est **pas** l'etat d'un run qui
 *   travaille, et c'est toute la difference.
 * - `human` — pastille primaire. Ca s'arrete sur toi.
 * - `error` — pastille rouge. Echec ou escalade.
 * - `done` — pastille verte. A rendu.
 */

/**
 * L'etat du run, qui est celui de ce qui travaille le plus profond.
 *
 * Pas de `todo` : un run affiche est un run qui existe. Le detail du classement
 * vit dans `runMark`.
 */

const DOT: Record<Exclude<Progress, "running">, { tone: string; label: string }> = {
  todo: { tone: "border border-ink-faint/40", label: "pas commence" },
  idle: { tone: "bg-ink-faint/50", label: "au repos" },
  human: { tone: "bg-human", label: "en attente de ta reponse" },
  error: { tone: "bg-ko", label: "en echec" },
  done: { tone: "bg-ok", label: "rendu" },
};

/**
 * La pastille, a l'identique pour une etape et pour un agent.
 *
 * L'encombrement ne bouge jamais, loader compris : changer d'etat ne doit pas
 * decaler la ligne, sinon on croit que le texte a bouge.
 */
export function ProgressDot({
  state,
  className,
  label,
  pulse = false,
}: {
  state: Progress;
  className?: string;
  /** Ce que la pastille designe, pour la lecture a voix haute. */
  label?: string;
  /**
   * L'etape a passe la main : sa pastille respire entre son encre et le vide.
   *
   * Reserve au premier niveau. Elle ne tourne jamais en meme temps que le
   * loader de la meme ligne — c'est l'un ou l'autre par construction — et elle
   * reste sous le seuil du loader qui tourne deux lignes plus bas, sur le
   * sous-agent : c'est lui qui travaille, pas elle.
   */
  pulse?: boolean;
}) {
  if (state === "running") return <Spinner className={className} />;

  const dot = DOT[state];
  const said = pulse && state === "idle" ? "a passe la main" : dot.label;
  return (
    <output className={cn("flex size-3 shrink-0 items-center justify-center", className)}>
      <span aria-hidden className={cn("size-2.5 rounded-full", dot.tone, pulse && "fade-quiet")} />
      <span className="sr-only">{label ? `${label} : ${said}` : said}</span>
    </output>
  );
}

/**
 * Ou en est une ligne, maintenant.
 *
 * `running` est celle sur laquelle un agent travaille : elle emprunte la
 * respiration du rail plutot qu'une cinquieme couleur, parce que c'est la meme
 * chose qu'une etape qui a passe la main — ouvert, pas fini.
 */
export type MarkTone = "done" | "todo" | "failed" | "running";

const MARK: Record<MarkTone, string> = {
  done: "border-ok bg-ok",
  failed: "border-ko bg-ko",
  running: "fade-quiet border-ink bg-ink",
  todo: "border-line-soft bg-transparent",
};

/**
 * Le carre d'avancement, un seul pour toute la page.
 *
 * La revue le pose en grille cliquable, la todo du developer l'aligne devant
 * son texte. Les deux montrent la meme chose — une ligne qui attend, une ligne
 * sur laquelle on travaille, une ligne rendue — et deux dessins pour une seule
 * idee obligeraient a apprendre deux fois la meme echelle. C'est le meme
 * composant, donc le clignotement et le vert ne peuvent pas diverger.
 */
export function Mark({
  tone,
  className,
  interactive = false,
}: {
  tone: MarkTone;
  className?: string;
  /** Pose l'affordance de survol. Un carre qui n'ouvre rien ne la porte pas. */
  interactive?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-4 shrink-0 rounded-[2px] border transition-colors",
        MARK[tone],
        interactive && tone === "todo" && "hover:border-ink-faint",
        className,
      )}
    />
  );
}

/**
 * Le document, dessine au trait de la page.
 *
 * Comme le caret et le chevron : la page ne prend pas d'icone a une fonte, elle
 * dessine les signes dont elle a besoin, au meme trait et a la meme rondeur,
 * pour qu'ils aient l'air d'avoir ete faits ensemble. Trois lignes de longueurs
 * inegales — c'est un journal, pas un formulaire.
 */
export function DocumentGlyph({ className }: { className?: string }) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: aria-hidden, et le bouton qui le porte est nomme
    <svg viewBox="0 0 16 16" aria-hidden focusable="false" className={cn("size-4 shrink-0", className)}>
      <path
        d="M3.25 2.75h6.5l3 3v7.5h-9.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M9.5 2.9v3.1h3M5.75 8.5h4.5M5.75 10.75h3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Le seul signe dessiné de la page, et il tourne toujours dans le même sens.
 *
 * Il pointe toujours vers ce qu'il va révéler : à droite puis en bas pour une
 * liste qui se déplie, en haut puis en bas pour un tiroir qui monte — celui-là
 * fait donc un demi-tour, pas un quart. Les deux angles sont donnés par
 * l'appelant, parce que « ouvert » ne veut pas dire la même direction partout.
 */
export function Caret({
  open,
  closed = 0,
  opened = 90,
  className,
}: {
  open: boolean;
  /** Où il pointe fermé, en degrés depuis la droite. */
  closed?: number;
  /** Où il pointe ouvert. Il pointe vers ce qu'il va révéler. */
  opened?: number;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 12 12"
      role="img"
      aria-label={open ? "replier" : "déplier"}
      style={{ transform: `rotate(${open ? opened : closed}deg)` }}
      className={cn("size-3 shrink-0 transition-transform duration-300 ease-out", className)}
    >
      <path
        d="M4.5 2.5 8 6l-3.5 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const TONE: Record<string, string> = {
  done: "bg-ok",
  success: "bg-ok",
  passed: "bg-ok",
  ok: "bg-ok",
  confirmee: "bg-ok",
  "in-progress": "bg-ink",
  running: "bg-ink",
  escalated: "bg-ko",
  failed: "bg-ko",
  ko: "bg-ko",
  pending: "bg-ink-faint/50",
  todo: "bg-ink-faint/50",
  waiting: "bg-human",
};

/** Un etat se lit a la couleur **et** au mot : la pastille seule ne suffit pas. */
export function StateDot({ status, className }: { status: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", TONE[status] ?? "bg-ink-faint/50", className)}
    />
  );
}

export function statusTone(status: string): string {
  if (["passed", "done", "success", "ok", "confirmee"].includes(status)) return "text-ok";
  if (["failed", "escalated", "ko", "infirmee"].includes(status)) return "text-ko";
  if (["waiting", "pending", "todo"].includes(status)) return "text-ink-faint";
  return "text-ink-soft";
}

/**
 * Le temps ecoule, qui avance tout seul.
 *
 * C'est la seule facon dont la page rend une derive temporelle : elle ne
 * connait pas la duree normale d'une etape, donc elle montre la duree en cours
 * assez fort pour que vingt minutes se remarquent.
 */
export function Elapsed({ since, className }: { since: string; className?: string }) {
  const now = useNow();
  const started = Date.parse(since);
  if (Number.isNaN(started)) return null;

  return (
    <time dateTime={since} className={cn("font-mono tabular-nums", className)}>
      {format(Math.max(0, Math.round((now - started) / 1000)))}
    </time>
  );
}

/**
 * L'horloge de la page, une seule pour tout le monde.
 *
 * Le rendu serveur n'a pas la meme heure que l'onglet : on ne lit `Date.now()`
 * qu'apres le montage, sinon la premiere seconde affiche un ecart qui n'existe
 * pas.
 */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  return now;
}

function format(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}`;
}

/** Un horodatage absolu, quand c'est le moment qui compte et pas la duree. */
export function At({ iso, className }: { iso: string; className?: string }) {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  return (
    <time dateTime={iso} className={cn("font-mono tabular-nums", className)}>
      {new Date(parsed).toLocaleTimeString("fr-FR", {
        hour: "2-digit",
        minute: "2-digit",
      })}
    </time>
  );
}

/**
 * Un vide qui dit quelque chose.
 *
 * Une memoire muette, un perimetre pas encore etabli, une checklist non rendue :
 * chacun est une information sur l'avancement, pas un trou a masquer.
 */
export function Nothing({ children }: { children: React.ReactNode }) {
  return <p className="text-[13px] leading-relaxed text-ink-faint">{children}</p>;
}

/**
 * Le meme trait que le caret, oriente.
 *
 * Il est `aria-hidden` : ce sont les boutons qui le portent qui se nomment.
 * Dessine au trait de la page plutot qu'emprunte a la fonte — un `›` tourne
 * porte le gras du texte et pivote autour de sa boite, pas autour de sa pointe.
 */
export function Chevron({ direction, className }: { direction: "left" | "right"; className?: string }) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: aria-hidden, et le bouton qui le porte est nomme
    <svg
      viewBox="0 0 12 12"
      aria-hidden
      focusable="false"
      className={cn("size-3 shrink-0", direction === "left" && "rotate-180", className)}
    >
      <path
        d="M4.5 2.5 8 6l-3.5 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
