import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfigCache } from "../../plugins/autopilot/mcp/lib/config.ts";
import { resetEnvCache } from "../../plugins/autopilot/mcp/lib/env.ts";
import { closeEventLogs, resetSeqCache } from "../../plugins/autopilot/mcp/lib/events.ts";
import { ToolError } from "../../plugins/autopilot/mcp/lib/errors.ts";
import { ensureMemoryLayout, serializeNote, type Frontmatter } from "../../plugins/autopilot/mcp/lib/memory.ts";
import type { ToolContext } from "../../plugins/autopilot/mcp/lib/tool.ts";
import { validate } from "../../plugins/autopilot/mcp/lib/schema.ts";
import { ALL_TOOLS, toolByName } from "../../plugins/autopilot/mcp/registry.ts";
import { type FakeGitLab, type FakeJira, type FakeSlack, fakeGitLab, fakeJira, fakeSlack } from "../fixtures/servers.ts";
import { type FixtureRepo, materialize } from "../fixtures/repos.ts";

/**
 * La sandbox d'un test de workflow.
 *
 * Il n'y a pas de `--dry-run` dans autopilot, et c'est volontaire : un flag se
 * contourne et ne verifie rien, une sandbox verifie ce qui s'est reellement
 * passe. Ici, git est reel, les services externes sont substitues, et
 * `~/.autopilot` est jetable.
 */

export interface Sandbox {
  readonly root: string;
  readonly home: string;
  readonly projectRoot: string;
  readonly repos: readonly FixtureRepo[];
  readonly jira: FakeJira;
  readonly slack: FakeSlack;
  readonly gitlab: FakeGitLab;
  call<T = any>(tool: string, input?: Record<string, unknown>, context?: ToolContext): Promise<T>;
  /** Appelle un tool en s'attendant a un echec, et rend le message. */
  expectFailure(tool: string, input?: Record<string, unknown>): Promise<string>;
  repo(name: string): FixtureRepo;
  cleanup(): Promise<void>;
}

export interface SandboxOptions {
  readonly ticket?: { key: string; summary: string; status?: string; issueType?: string; description?: string };
  readonly slackUsers?: Record<string, string>;
  readonly slackAllowlist?: Record<string, string[]>;
  readonly memory?: { path: string; frontmatter: Frontmatter; body: string }[];
}

const TEST_CONTEXT: ToolContext = {
  canAskHuman: false,
  heartbeat: () => {},
  askHuman: async () => ({ action: "cancel", content: null }),
};

export async function createSandbox(options: SandboxOptions = {}): Promise<Sandbox> {
  const root = mkdtempSync(join(tmpdir(), "autopilot-wf-"));
  const home = join(root, "autopilot-home");
  const projectRoot = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });

  const repos = materialize(root);
  const ticket = options.ticket ?? { key: "TJ-100", summary: "Ajouter le filtre par periode" };

  const jira = await fakeJira([ticket]);
  const slack = await fakeSlack(options.slackUsers ?? {});
  const gitlab = await fakeGitLab();

  writeFileSync(join(projectRoot, "repositories.yaml"), registryYaml(repos), "utf8");
  writeFileSync(join(projectRoot, "autopilot.yaml"), configYaml(options.slackAllowlist ?? {}), "utf8");

  // Les bases d'API ne sont jamais renseignees en production : c'est ce qui
  // permet de substituer les services sans qu'aucun tool sache qu'il tourne en
  // sandbox.
  const previous = { ...process.env };
  Object.assign(process.env, {
    AUTOPILOT_HOME: home,
    AUTOPILOT_PROJECT_ROOT: projectRoot,
    AUTOPILOT_ENV_FILE: join(root, "absent.env"),
    GITLAB_HOST: gitlab.url,
    GITLAB_TOKEN: "fake-gitlab",
    JIRA_SITE_URL: jira.url,
    JIRA_EMAIL: "fixture@test",
    JIRA_API_TOKEN: "fake-jira",
    SLACK_API_BASE: slack.url,
    SLACK_USER_TOKEN: "xoxp-fake",
  });
  resetConfigCache();
  resetEnvCache();

  ensureMemoryLayout(join(home, "memory"));
  for (const note of options.memory ?? []) {
    const absolute = join(home, "memory", note.path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, serializeNote(note.frontmatter, note.body), "utf8");
  }

  async function call<T>(name: string, input: Record<string, unknown> = {}, context: ToolContext = TEST_CONTEXT): Promise<T> {
    const tool = toolByName(name);
    if (!tool) throw new Error(`Tool inconnu : ${name}. Connus : ${ALL_TOOLS.map((t) => t.name).join(", ")}`);
    validate(tool.inputSchema, input, name);
    return (await tool.handler(input, context)) as T;
  }

  return {
    root,
    home,
    projectRoot,
    repos,
    jira,
    slack,
    gitlab,
    call,
    async expectFailure(name, input = {}) {
      try {
        await call(name, input);
      } catch (error) {
        if (error instanceof ToolError) {
          // Le message ET l'indice : c'est ce que l'agent appelant recoit.
          return error.hint ? `${error.message}\n\n${error.hint}` : error.message;
        }
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error(`${name} aurait du echouer`);
    },
    repo(name) {
      const found = repos.find((entry) => entry.name === name);
      if (!found) throw new Error(`Repo de fixture inconnu : ${name}`);
      return found;
    },
    async cleanup() {
      await Promise.all([jira.close(), slack.close(), gitlab.close()]);
      // Le compteur de seq et le descripteur du log vivent dans le process :
      // sans ca, la sandbox suivante heriterait du fichier de la precedente.
      closeEventLogs();
      resetSeqCache();
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) delete process.env[key];
      }
      Object.assign(process.env, previous);
      resetConfigCache();
      resetEnvCache();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function registryYaml(repos: readonly FixtureRepo[]): string {
  const entries = repos
    .map(
      (repo) => `  - name: ${repo.name}
    level: ${repo.level}
    path: ${repo.path}
    gitlabProject: fixtures/${repo.name}
    baseBranch: ${repo.baseBranch}
    layer: eval
    packageManager: npm
    monorepoTool: ${repo.monorepoTool ?? "null"}
    packageName: ${repo.packageName ? `"${repo.packageName}"` : "null"}
    dependsOn: [${repo.dependsOn.join(", ")}]
    commands:
      lint: null
      typecheck: null
      ut: npm run test:unit
      it: null
      ft: null
      ct: null
      e2e: null
    ciJobsToWatch: [build, test]
    description: Depot de fixture ${repo.name}
    keywords: [fixture]`,
    )
    .join("\n\n");

  return `schemaVersion: 1\n\nrepositories:\n${entries}\n\nevalOnly:\n  repos: []\n  jiraProjects: []\n`;
}

function configYaml(allowlist: Record<string, string[]>): string {
  const bySquad = Object.entries(allowlist)
    .map(([squad, emails]) => `      ${squad}:\n${emails.map((email) => `        - ${email}`).join("\n") || "        []"}`)
    .join("\n");

  return `schemaVersion: 1

budgets:
  testAdversary: 3
  redChecker: 3
  testDispute: 3
  greenChecker: 3
  codeAdversary: 3
  disputeBeforeEscalation: 2

timeouts:
  ciPipelineSeconds: 5
  askUserSeconds: 2
  repoSetupSeconds: 300
  commandSeconds: 120

memory:
  maxNoteLines: 100
  docScout:
    maxFilesRead: 15
    maxOutputLines: 200

naming:
  types: [feature, bugfix, hotfix, documentation, chore, refactor, test, style, task]
  branch: "{type}/{ticket}-{slug}"
  mergeRequest: "{type}/{ticket}: {titre}"
  slackChannel: "{ticket}-{slug}"
  devVersionSuffix: "-{n}"
  slugMaxLength: 40
  typeFromJiraIssueType:
    Story: feature
    Bug: bugfix
    default: task

gitlab:
  mrDraft: true
  mrDescriptionLanguage: fr
  commitLanguage: en
  commitConvention: conventional

jira:
  baseUrl: https://jira.test
  assignToSelf: true
  transitions:
    default:
      apresMr: VALIDATION
    bySquad:
      TJ:
        apresMr: En cours

slack:
  channelVisibility: private
  invitees:
    default: []
    bySquad:
${bySquad || "      {}"}

liveMode:
  portRange: [12000, 13000]
  openBrowser: false
`;
}
