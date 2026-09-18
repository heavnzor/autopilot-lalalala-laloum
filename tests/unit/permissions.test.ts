import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isTestFile } from "../../plugins/autopilot/mcp/tools/git.ts";
import { ALL_TOOLS, TOOLS_BY_AGENT } from "../../plugins/autopilot/mcp/registry.ts";
import { PROJECT_ROOT } from "../helpers.ts";

/**
 * Claude Code expose les tools d'un plugin sous `mcp__plugin_<plugin>_<serveur>__`,
 * pas sous le nom du serveur seul. Un frontmatter qui declare le mauvais prefixe
 * fait spawner l'agent avec zero tool — et le spawn est refuse. Le prefixe est
 * donc derive du manifeste, jamais recopie a la main.
 */
const MANIFEST = JSON.parse(
  readFileSync(join(PROJECT_ROOT, "plugins", "autopilot", ".claude-plugin", "plugin.json"), "utf8"),
) as { name: string; mcpServers: Record<string, unknown> };
const SERVER = Object.keys(MANIFEST.mcpServers)[0] ?? "";
const PREFIX = `mcp__plugin_${MANIFEST.name}_${SERVER}__`;

/**
 * Un agent ne peut ecrire que dans une seule zone. Cette regle vit dans trois
 * endroits — le frontmatter des agents, la table du registre, le garde-fou du
 * commit — et trois endroits, c'est trois occasions de diverger.
 */

const AGENTS_DIR = join(PROJECT_ROOT, "plugins", "autopilot", "agents");

interface AgentFile {
  name: string;
  model: string;
  tools: string[];
  body: string;
}

function readAgents(): AgentFile[] {
  return readdirSync(AGENTS_DIR)
    .filter((file) => file.endsWith(".md"))
    .map((file) => {
      const raw = readFileSync(join(AGENTS_DIR, file), "utf8");
      const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
      assert.ok(match, `${file} sans frontmatter`);
      const front = match[1] ?? "";
      const read = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(front)?.[1]?.trim() ?? "";
      return {
        name: read("name"),
        model: read("model"),
        tools: read("tools").split(",").map((tool) => tool.trim()).filter(Boolean),
        body: match[2] ?? "",
      };
    });
}

const AGENTS = readAgents();
const TOOL_NAMES = new Set(ALL_TOOLS.map((tool) => tool.name));

describe("les 15 agents", () => {
  it("sont tous la", () => {
    assert.equal(AGENTS.length, 15, AGENTS.map((agent) => agent.name).join(", "));
  });

  it("declarent leurs tools sous le prefixe que le plugin expose reellement", () => {
    // Un mauvais prefixe ne casse rien au chargement : il fait juste spawner
    // l'agent sans aucun tool. Le symptome apparait au premier run reel.
    assert.equal(PREFIX, "mcp__plugin_autopilot_autopilot__");
    for (const agent of AGENTS) {
      const mcpTools = agent.tools.filter((tool) => tool.startsWith("mcp__"));
      assert.ok(mcpTools.length > 0, `${agent.name} n'a aucun tool mcp`);
      for (const tool of mcpTools) {
        assert.ok(tool.startsWith(PREFIX), `${agent.name} : ${tool} ne porte pas ${PREFIX}`);
      }
    }
  });

  it("portent un nom qui correspond a leur fichier et a la table des tools", () => {
    for (const agent of AGENTS) {
      assert.ok(agent.name, "agent sans nom");
      assert.ok(TOOLS_BY_AGENT[agent.name], `${agent.name} absent de TOOLS_BY_AGENT`);
    }
  });

  it("tournent en opus ou en sonnet, jamais en haiku", () => {
    // Un agent assez simple pour tourner en haiku devrait etre un tool.
    for (const agent of AGENTS) {
      assert.ok(["opus", "sonnet"].includes(agent.model), `${agent.name} : ${agent.model}`);
    }
  });

  it("respectent la regle de model : opus juge, sonnet route", () => {
    const expected: Record<string, string> = {
      "doc-scout": "sonnet",
      "functional-grill": "opus",
      "scope-scout": "sonnet",
      "technical-grill": "opus",
      planner: "opus",
      orchestrator: "sonnet",
      "test-writer": "opus",
      "test-adversary": "opus",
      "red-checker": "sonnet",
      developer: "opus",
      "green-checker": "sonnet",
      "code-adversary": "opus",
      "memory-planner": "opus",
      "memory-writer": "sonnet",
      finalizer: "opus",
    };
    for (const agent of AGENTS) {
      assert.equal(agent.model, expected[agent.name], `${agent.name}`);
    }
  });

  it("ne reclament que des tools qui existent", () => {
    for (const agent of AGENTS) {
      for (const tool of agent.tools) {
        if (!tool.startsWith(PREFIX)) continue;
        const bare = tool.replace(PREFIX, "");
        assert.ok(TOOL_NAMES.has(bare), `${agent.name} reclame ${bare}, qui n'existe pas`);
      }
    }
  });

  it("ont un frontmatter aligne sur la table du registre", () => {
    for (const agent of AGENTS) {
      const declared = new Set(
        agent.tools.filter((tool) => tool.startsWith(PREFIX)).map((tool) => tool.replace(PREFIX, "")),
      );
      const expected = new Set(TOOLS_BY_AGENT[agent.name] ?? []);
      const missing = [...expected].filter((tool) => !declared.has(tool));
      const extra = [...declared].filter((tool) => !expected.has(tool));
      assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, `${agent.name}`);
    }
  });

  it("appellent tous push-live-mode-event et escalate-to-human", () => {
    // Pas de cablage central : un agent qui ne pousse pas laisse un trou.
    for (const agent of AGENTS) {
      assert.ok(agent.tools.includes(`${PREFIX}push-live-mode-event`), `${agent.name}`);
      assert.ok(agent.tools.includes(`${PREFIX}escalate-to-human`), `${agent.name}`);
    }
  });
});

describe("zones d'ecriture", () => {
  const writers = new Set(["test-writer", "developer", "memory-writer", "orchestrator", "finalizer"]);

  it("les agents en lecture seule n'ont aucun tool d'ecriture ni Write / Edit", () => {
    const writeTools = ["create-memory", "write-memory", "delete-memory", "create-code-commit", "create-test-commit", "push-branch", "push-tag"];
    for (const agent of AGENTS) {
      if (writers.has(agent.name)) continue;
      for (const tool of writeTools) {
        assert.ok(!agent.tools.includes(`${PREFIX}${tool}`), `${agent.name} peut ${tool}`);
      }
      assert.ok(!agent.tools.includes("Write"), `${agent.name} peut Write`);
      assert.ok(!agent.tools.includes("Edit"), `${agent.name} peut Edit`);
      assert.ok(!agent.tools.includes("Bash"), `${agent.name} peut Bash`);
    }
  });

  it("le memory-writer est le seul a pouvoir ecrire dans memory/", () => {
    for (const agent of AGENTS) {
      if (agent.name === "memory-writer") continue;
      for (const tool of ["create-memory", "write-memory", "delete-memory", "commit-memory"]) {
        assert.ok(!agent.tools.includes(`${PREFIX}${tool}`), `${agent.name} ecrit dans memory/`);
      }
    }
  });

  it("le finalizer est le seul a pouvoir pousser une branche ou publier", () => {
    const remote = ["push-branch", "create-gitlab-mr", "create-slack-channel", "transition-jira-ticket"];
    for (const agent of AGENTS) {
      if (agent.name === "finalizer") continue;
      for (const tool of remote) {
        assert.ok(!agent.tools.includes(`${PREFIX}${tool}`), `${agent.name} peut ${tool}`);
      }
    }
  });

  it("l'orchestrateur peut pousser un tag, et lui seul en dehors du finalizer", () => {
    // Un tag se pousse sans branche, donc sans MR : c'est la seule ecriture
    // distante autorisee avant le point 13.
    for (const agent of AGENTS) {
      if (agent.name === "orchestrator") continue;
      assert.ok(!agent.tools.includes(`${PREFIX}push-tag`), `${agent.name} peut push-tag`);
    }
    assert.ok(TOOLS_BY_AGENT.orchestrator?.includes("push-tag"));
  });

  it("le developer ne peut pas choisir la zone de son outil de commit", () => {
    const developer = AGENTS.find((agent) => agent.name === "developer")!;
    assert.ok(!developer.tools.includes("Bash"));
    assert.ok(developer.tools.includes(`${PREFIX}create-code-commit`));
    assert.ok(!developer.tools.includes(`${PREFIX}create-test-commit`));
    assert.ok(!TOOL_NAMES.has("create-commit"));
    assert.ok(isTestFile("src/features/lab/filter.spec.ts"));
    assert.ok(isTestFile("tests/unit/filter.test.ts"));
    assert.ok(isTestFile("__tests__/filter.ts"));
    assert.ok(isTestFile("e2e/parcours.ts"));
    assert.ok(!isTestFile("src/features/lab/filter.ts"));
    assert.ok(!isTestFile("src/testing-utils.ts"));
  });
});

describe("les tools", () => {
  it("portent tous un nom, une description et un schema", () => {
    for (const tool of ALL_TOOLS) {
      assert.match(tool.name, /^[a-z][a-z0-9-]*$/, tool.name);
      assert.ok(tool.description.length > 40, `${tool.name} : description trop courte`);
      assert.equal(tool.inputSchema.type, "object", tool.name);
      assert.equal(typeof tool.handler, "function", tool.name);
    }
  });

  it("n'ont pas de doublon de nom", () => {
    assert.equal(TOOL_NAMES.size, ALL_TOOLS.length);
  });

  it("decrivent chacun de leurs parametres", () => {
    for (const tool of ALL_TOOLS) {
      const properties = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
      for (const [key, schema] of Object.entries(properties)) {
        assert.ok(schema.description, `${tool.name}.${key} sans description`);
      }
    }
  });

  it("sont tous attribues a au moins un agent", () => {
    const attributed = new Set(Object.values(TOOLS_BY_AGENT).flat());
    // Ceux-la sont appeles par la skill qui pilote le run, pas par un agent.
    // `ask-plan-approval` en fait partie : le gate du point 9 est un moment du
    // workflow, pas le travail d'un agent — c'est la skill qui route les trois
    // sorties, dont un rejet qui renvoie au point 4 ou au point 7.
    const bySkill = new Set(["launch-live-mode", "get-figma-components", "get-figma-component", "get-figma-image", "get-jira-ticket", "get-autopilot-env", "update-jira-ticket", "get-gitlab-branch", "get-gitlab-note", "remove-worktree", "get-slack-channel", "ask-plan-approval"]);
    const orphans = ALL_TOOLS.map((tool) => tool.name).filter((name) => !attributed.has(name) && !bySkill.has(name));
    assert.deepEqual(orphans, []);
  });
});
