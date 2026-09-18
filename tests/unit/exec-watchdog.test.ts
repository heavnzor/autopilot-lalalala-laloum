import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { run, stopReason } from "../../plugins/autopilot/mcp/lib/exec.ts";
import { PROJECT_ROOT, useProjectConfig } from "../helpers.ts";

before(useProjectConfig);

/**
 * Deux horloges, et la difference entre les deux vaut une demi-heure.
 *
 * Sur FT-1042, `npm run test:unit` a occupe les 1800 secondes de plafond sans
 * ecrire une ligne — aucun daemon de conteneurs ne repondait — puis a rendu en
 * vingt-et-une secondes une fois le daemon debout. Le plafond seul ne savait
 * pas faire la difference entre ca et une suite lente. Le silence, si.
 */
describe("le chien de garde de silence", () => {
  it("abandonne une commande vivante mais muette, bien avant le plafond", async () => {
    const started = Date.now();
    const result = await run("sleep 30", {
      cwd: PROJECT_ROOT,
      timeoutMs: 30_000,
      silenceMs: 1_000,
    });

    assert.equal(result.stoppedBy, "silence");
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, 124);
    assert.ok(Date.now() - started < 10_000, `abandonne en ${Date.now() - started}ms`);
  });

  it("laisse tourner une commande lente tant qu'elle ecrit", async () => {
    // Elle depasse largement le silence tolere, mais parle toutes les 200ms.
    const result = await run("for i in 1 2 3 4 5 6 7 8; do echo tick; sleep 0.2; done", {
      cwd: PROJECT_ROOT,
      timeoutMs: 30_000,
      silenceMs: 1_000,
    });

    assert.equal(result.stoppedBy, "exit");
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /tick/);
  });

  it("distingue le plafond du silence dans ce qu'il rend a lire", async () => {
    const silent = await run("sleep 10", { cwd: PROJECT_ROOT, timeoutMs: 10_000, silenceMs: 800 });
    const capped = await run("while true; do echo tick; sleep 0.1; done", {
      cwd: PROJECT_ROOT,
      timeoutMs: 1_500,
      silenceMs: 60_000,
    });

    assert.match(stopReason(silent) ?? "", /sans la moindre sortie/);
    assert.match(stopReason(capped) ?? "", /plafond/);
    assert.equal(capped.stoppedBy, "timeout");
  });

  it("ne dit rien d'une commande qui a rendu son verdict elle-meme", async () => {
    const ok = await run("echo fini", { cwd: PROJECT_ROOT, silenceMs: 5_000 });
    assert.equal(ok.stoppedBy, "exit");
    assert.equal(stopReason(ok), null);
  });

  it("rend le plus long silence traverse, pas seulement le dernier", async () => {
    // C'est ce chiffre qui calibre le seuil. Mesure sur le parc reel : les pires
    // commandes — les FT de sheet-service, les CT de design-system, pres de
    // deux minutes chacune — ne se taisent jamais plus de 8 secondes. Un seuil a
    // 240 laisse donc trente fois la marge observee.
    const result = await run("echo debut; sleep 1.2; echo milieu; sleep 0.2; echo fin", {
      cwd: PROJECT_ROOT,
      timeoutMs: 20_000,
      silenceMs: 10_000,
    });

    assert.equal(result.stoppedBy, "exit");
    assert.ok(result.maxSilentMs >= 1_000, `attendu >= 1000ms, recu ${result.maxSilentMs}`);
    assert.ok(result.maxSilentMs < 10_000, `attendu < 10000ms, recu ${result.maxSilentMs}`);
    // Le dernier silence est court : sans le maximum, on ne verrait rien du trou.
    assert.ok(result.silentForMs < result.maxSilentMs, "le maximum doit depasser le dernier silence");
  });

  it("bat la mesure vers le client pendant qu'une commande tourne", async () => {
    // Sans ces battements, le client tue l'appel et l'agent recoit un timeout
    // qu'il ne sait pas interpreter : c'est ce qui est arrive au run reel.
    const beats: string[] = [];
    await run("for i in 1 2 3 4 5 6; do echo tick; sleep 0.2; done", {
      cwd: PROJECT_ROOT,
      timeoutMs: 20_000,
      silenceMs: 2_000,
      onProgress: (message) => beats.push(message),
    });

    assert.ok(beats.length > 0, "aucun battement emis");
    assert.match(beats[0] ?? "", /\d+s$/);
  });
});

/**
 * Le chien de garde doit abattre l'arbre, pas la racine.
 *
 * `spawn` avec `shell: true` ouvre un `/bin/sh`, qui ouvre `npm`, qui ouvre le
 * runner. `child.kill()` ne tuait que le premier : les deux autres survivaient,
 * rattaches a launchd, en gardant les tubes de sortie ouverts. `close` n'arrive
 * jamais quand un tube reste ouvert, donc la promesse ne se resolvait pas et
 * l'agent restait muet jusqu'au plafond du serveur MCP — huit heures.
 *
 * Constate sur FT-1042 : le `mtr` d'UT du `red-checker` toujours vivant trente
 * minutes apres son abandon, et un autre de l'avant-veille encore la apres un
 * jour et seize heures. Aucun event, aucune escalade, juste un run arrete.
 */
describe("le chien de garde abat le groupe de processus", () => {
  it("rend la main meme quand un petit-fils survit et tient les tubes", async () => {
    const started = Date.now();
    // Un petit-fils muet et long, lance en arriere-plan par le shell : il herite
    // de stdout et le garde ouvert apres la mort de son parent.
    const result = await run('node -e "setTimeout(()=>{}, 600000)" & sleep 600', {
      cwd: PROJECT_ROOT,
      timeoutMs: 60_000,
      silenceMs: 3_000,
    });
    const elapsed = Date.now() - started;

    assert.equal(result.stoppedBy, "silence");
    // Le point du test : ca rend. L'ancienne version restait bloquee ici.
    assert.ok(elapsed < 20_000, `la commande a mis ${elapsed} ms a rendre : la promesse ne se resout pas`);
  });

  it("ne laisse pas le petit-fils derriere lui", async () => {
    const marker = `orphelin-${process.pid}-${Date.now()}`;
    const result = await run(`node -e "process.title='${marker}'; console.log(process.pid); setTimeout(()=>{}, 600000)" & sleep 600`, {
      cwd: PROJECT_ROOT,
      timeoutMs: 60_000,
      silenceMs: 3_000,
    });
    const pid = Number(result.stdout.trim());
    assert.ok(Number.isSafeInteger(pid) && pid > 1, `PID de fixture invalide : ${result.stdout}`);

    // `SIGTERM` puis `SIGKILL` deux secondes plus tard : on laisse passer le delai.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    // `pgrep -f marqueur | wc -l` comptait aussi son propre shell sous Linux.
    // On sonde le PID reel. Un zombie attend son parent adoptif mais n'execute
    // plus rien et ne tient plus les tubes : ce n'est pas un runner survivant.
    let alive = false;
    if (process.platform === "linux") {
      const { readFileSync } = await import("node:fs");
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const state = stat.slice(stat.lastIndexOf(")") + 1).trimStart()[0];
        alive = state !== "Z" && state !== "X";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } else {
      try { process.kill(pid, 0); alive = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    assert.equal(alive, false, `le processus de test ${pid} a survecu a l'abandon de sa commande`);
  });
});
