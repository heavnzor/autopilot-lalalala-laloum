import type { AnyTool } from "./lib/tool.ts";
import { configTools } from "./tools/config.ts";
import { figmaTools } from "./tools/figma.ts";
import { gitTools } from "./tools/git.ts";
import { gitlabTools } from "./tools/gitlab.ts";
import { humanTools } from "./tools/human.ts";
import { jiraTools } from "./tools/jira.ts";
import { memoryTools } from "./tools/memory.ts";
import { preflightTools } from "./tools/preflight.ts";
import { qualityTools } from "./tools/quality.ts";
import { slackTools } from "./tools/slack.ts";
import { stateTools } from "./tools/state.ts";
import { voiceTools } from "./tools/voice.ts";
import { workflowTools } from "./tools/workflow.ts";

export const ALL_TOOLS: readonly AnyTool[] = [
  ...configTools,
  ...stateTools,
  ...memoryTools,
  ...gitTools,
  ...preflightTools,
  ...qualityTools,
  ...gitlabTools,
  ...jiraTools,
  ...slackTools,
  ...figmaTools,
  ...voiceTools,
  ...humanTools,
  ...workflowTools,
];

export function toolByName(name: string): AnyTool | undefined {
  return ALL_TOOLS.find((tool) => tool.name === name);
}

/**
 * Chaque agent ne recoit que les tools de son role : on ne charge pas les
 * cinquante schemas dans les quinze agents. Cette table est la source de verite
 * du decoupage, et le frontmatter des agents doit lui rester aligne — le test
 * unitaire `permissions` echoue sinon.
 */
export const TOOLS_BY_AGENT: Readonly<Record<string, readonly string[]>> = {
  "doc-scout": ["get-ticket", "get-memory", "contradict-memory", "push-live-mode-event", "escalate-to-human"],

  "functional-grill": [
    "ask-user",
    "get-ticket",
    "get-figma-components",
    "get-figma-component",
    "get-memory",
    "write-store-ticket",
    "push-live-mode-event",
    "escalate-to-human",
  ],

  "scope-scout": [
    "get-repositories-registry",
    "get-memory",
    "contradict-memory",
    "get-ticket",
    "push-live-mode-event",
    "escalate-to-human",
  ],

  "technical-grill": [
    "ask-user",
    "get-memory",
    "get-repositories-registry",
    "get-ticket",
    "write-store-ticket",
    "push-live-mode-event",
    "escalate-to-human",
  ],

  planner: [
    "get-ticket",
    "get-memory",
    "get-repositories-registry",
    "get-autopilot-config",
    "generate-branch-name",
    "push-live-mode-event",
    "escalate-to-human",
  ],

  orchestrator: [
    "advance-workflow",
    "acquire-ticket-lock",
    "release-ticket-lock",
    "write-store-ticket",
    "get-store-ticket",
    "get-ticket",
    "get-autopilot-config",
    "get-repositories-registry",
    "create-worktree",
    "setup-repo",
    "preflight-repo",
    "remove-worktree",
    "monorepo-filter",
    "push-tag",
    "create-gitlab-tag",
    "watch-gitlab-pipeline",
    "get-gitlab-pipeline",
    "push-live-mode-event",
    "escalate-to-human",
  ],

  "test-writer": [
    "get-repositories-registry",
    "get-memory",
    "get-ticket",
    "create-test-commit",
    "generate-commit-message",
    "push-live-mode-event",
    "escalate-to-human",
  ],

  "test-adversary": ["get-memory", "get-ticket", "get-repositories-registry", "push-live-mode-event", "escalate-to-human"],

  "red-checker": [
    "run-test-ut",
    "run-test-it",
    "run-test-ft",
    "run-test-ct",
    "run-test-e2e",
    "preflight-repo",
    "get-repositories-registry",
    "push-live-mode-event",
    "escalate-to-human",
  ],

  developer: [
    "get-ticket",
    "get-memory",
    "get-repositories-registry",
    "generate-commit-message",
    "create-code-commit",
    "get-repo-diff",
    "run-lint",
    "run-typecheck",
    "monorepo-filter",
    "contradict-memory",
    "push-live-mode-event",
    "escalate-to-human",
  ],

  "green-checker": [
    "run-test-ut",
    "run-test-it",
    "run-test-ft",
    "run-test-ct",
    "run-test-e2e",
    "run-lint",
    "run-typecheck",
    "preflight-repo",
    "get-repositories-registry",
    "push-live-mode-event",
    "escalate-to-human",
  ],

  "code-adversary": [
    "get-repo-diff",
    "get-memory",
    "get-ticket",
    "get-repositories-registry",
    "monorepo-filter",
    "push-live-mode-event",
    "escalate-to-human",
  ],

  "memory-planner": ["get-memory", "get-ticket", "get-autopilot-config", "push-live-mode-event", "escalate-to-human"],

  "memory-writer": [
    "create-memory",
    "write-memory",
    "delete-memory",
    "commit-memory",
    "get-memory",
    "push-live-mode-event",
    "escalate-to-human",
  ],

  finalizer: [
    "get-ticket",
    "get-store-ticket",
    "push-branch",
    "generate-branch-name",
    "generate-mr-name",
    "create-gitlab-mr",
    "update-gitlab-mr",
    "get-gitlab-mr",
    "create-gitlab-note",
    "transition-jira-ticket",
    "create-jira-comment",
    "create-slack-channel",
    "get-slack-channel",
    "invite-slack-users",
    "post-slack-message",
    "create-slack-bookmark",
    "writer-voice-tone",
    "write-store-ticket",
    "push-live-mode-event",
    "escalate-to-human",
  ],
};
