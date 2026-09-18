---
name: autopilot-start
description: Implemente un ticket Jira de bout en bout : cadrage, approbation du plan, TDD adversarial par depot, capitalisation et publication verifiee. TRIGGER quand un ticket est donne a implementer ou quand /autopilot-start est invoque, pas pour une simple question sur un ticket.
argument-hint: <url-ou-cle-jira> [--notes "…"] [--figma <url>…] [--live] [--clear]
---

# autopilot-start

Tu pilotes le run, sans ecrire toi-meme le code ni les tests. Les agents
interpretent ; `advance-workflow` applique les transitions et les budgets.

```text
/autopilot-start <url-ou-cle-jira> [--notes "…"] [--figma <url>…] [--live] [--clear]
```

Les URL Figma du flag completent celles du ticket. Conserve les notes et les
URL dans l'etat pour qu'une reprise retrouve le meme contexte.

## Demarrer ou reprendre

1. Lis `get-ticket`. `resumable` et `resumeAt` indiquent le curseur existant.
   Ne refais jamais un depot `done` et ne reconstruis pas l'etat depuis tes
   souvenirs d'une ancienne session.
2. Avec `--live`, lance `launch-live-mode` avant le premier travail de cadrage.
3. Prends `acquire-ticket-lock` avec ticketId et runId. Un refus arrete ce run.
4. Persiste les options de lancement avec `write-store-ticket`.
5. A la fin, y compris apres escalade, appelle `release-ticket-lock` avec le
   meme runId. Ne libere jamais le verrou d'un autre run.

## Cadrage

| Point | Action |
|---|---|
| 1 | `get-ticket`, puis persister titre, URL, type, statut initial, description et criteres d'acceptation |
| 2 | Outils Figma, optionnels ; persister les frames, images et references |
| 3 | `doc-scout`, passe large |
| 4 | `functional-grill` |
| 5 | `scope-scout` |
| 6 | `doc-scout`, passe ciblee sur le scope |
| 7 | `technical-grill` |
| 8 | `planner` : plan structure et checklists |
| 9 | `ask-plan-approval` |

Apres chaque point 1 a 8, persiste ses produits puis appelle
`advance-workflow` avec `pass` et `expectedStep` egal au point termine. Le prochain curseur est ecrit avant
l'invocation suivante. Pousse un event a la prise de main et au retour ; ton
champ `agent` reste absent, les sous-agents utilisent leur nom exact.

Les arbitrages ont un `id` stable. Le scope porte `name` et `level`. Chaque
ligne de checklist a `id`, `repo`, `criterion`, `status` ; les tests distinguent
`purpose: new-behavior` et `purpose: regression`. Les IDs reutilises dans deux
depots exigent `repo` dans chaque patch partiel.

`memory.scouted` conserve les deux passes, avec `pass`, `filesRead`, `notes`
(chemin et apport) et `silentOn`. Une memoire muette ne valide aucune hypothese.

## Le gate du point 9

Soumets **exactement `plan.repos`** a `ask-plan-approval`. Le scope, les criteres
et les arbitrages doivent deja etre dans l'etat. Le tool enregistre la preuve
d'approbation et son empreinte ; **ne reecris jamais `plan.approvedAt`**.

- `approve` : `advance-workflow` avec `expectedStep: "9"` et `pass` ouvre le premier depot.
- `amend` : retourne au planner (point 8), persiste le nouveau plan et resoumets.
- `reject` : reprends le cadrage au point 4 ou 7 selon la raison, puis refais le plan.

Un retour au cadrage s'ecrit explicitement dans le curseur. Il invalide les
anciens acquis des que le contrat change. Une question posee via le fallback
textuel ne cree pas de preuve d'approbation : ouvre le live shell et rappelle
le tool pour terminer ce gate si l'elicitation MCP est indisponible.

## Implementation

Invoque `orchestrator` pour le depot courant, avec plan et checklists. Il
utilise `advance-workflow` apres les verdicts et rend la main quand le depot
change ou que le run escalade. Relis alors le curseur : ne l'incremente pas une
seconde fois. Un seul depot se traite a la fois, amont vers aval.

Si les sous-agents ne peuvent pas eux-memes invoquer Agent, conduis ces appels
depuis la session principale en suivant `agents/orchestrator.md`. Le meme
routeur serveur reste utilise ; aucune commande de test n'est improvisee.

Un `null` du registre interdit ce type de verification. Un besoin non couvert
demande une decision d'outillage ; n'utilise pas Bash pour contourner le registre.

Les checks finaux sont complets et portent sur le dernier commit propre.
Modifier un fichier apres un vert impose un nouveau commit et de nouveaux checks.

## Capitalisation et publication

Quand tous les depots sont passes :

1. Point 11, `memory-planner` : traiter les contradictions avant les ajouts.
2. `advance-workflow` avec `expectedStep: "11"` et `pass` ouvre le point 12.
3. `memory-writer` applique le plan et commite. Persiste `memory.operations`
   et le resultat, y compris le cas ou aucune modification n'etait necessaire.
4. `advance-workflow` avec `expectedStep: "12"` et `pass` ouvre le point 13.
5. `finalizer` publie. Ses tools exigent ticketId, approbation valide,
   checklists passees et preuves de verification du commit courant.
6. Une fois **toutes** les actions confirmees, persiste `run.phase: done` et
   pousse l'event final. Un succes partiel ne termine pas le run.

Les ecritures distantes utilisent les memes identifiants d'operation a la
reprise. Un resultat incertain demande reconciliation et escalade, jamais un
nouveau POST avec une cle inventee pour contourner le journal.

## Nettoyage explicite

`--clear` appelle le script de nettoyage, jamais une suppression manuelle :

```sh
node plugins/autopilot/mcp/scripts/clear-run.ts <ticket> [--force] [--dry-run]
```

Il conserve les effets distants et leurs journaux de publication. Les anciennes
preuves locales doivent etre refaites. S'il signale du travail non sauvegarde,
rends son rapport a l'utilisateur ; ne force pas sa suppression a sa place.

Apres le nettoyage, le prochain run part dans une **session neuve**. N'enchaine
pas un nouveau cadrage avec les conclusions gardees en contexte par l'ancien.

## Mesure et echec

Le serveur calcule `loopTurnsTotal`. Les tools comptent les interventions
directes. `mrFeedbackCount` reste manuel tant que workflow 2 n'est pas implemente.

Sur une escalade, arrete les nouveaux travaux et decris precisement les
worktrees, commits, tags, MR ou messages deja existants. Une publication peut
avoir reussi partiellement ; ne declare pas que rien n'est parti sans verifier.
