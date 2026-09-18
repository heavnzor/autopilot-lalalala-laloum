import { arr, bool, num, obj, str, validate, type JsonSchema } from "./schema.ts";

const text = () => str("Valeur non vide", { minLength: 1 });
const texts = () => arr("Liste", text(), { uniqueItems: true });
const positive = () => num("Entier positif", { type: "integer", minimum: 1 });
const nullableText: JsonSchema = { anyOf: [text(), { type: "null" }] };
const bySquad = (value: JsonSchema) => obj({ default: value, bySquad: { type: "object", additionalProperties: value } }, ["default", "bySquad"]);
const commands = ["lint", "typecheck", "ut", "it", "ft", "ct", "e2e"];
const commandMap = (value: JsonSchema) => obj(Object.fromEntries(commands.map((kind) => [kind, value])));

const configSchema = obj({
  schemaVersion: { const: 1 },
  budgets: obj(Object.fromEntries(["testAdversary", "redChecker", "testDispute", "greenChecker", "codeAdversary", "disputeBeforeEscalation", "developerBatchLines"].map((key) => [key, positive()])), ["testAdversary", "redChecker", "testDispute", "greenChecker", "codeAdversary", "disputeBeforeEscalation"]),
  timeouts: obj(Object.fromEntries(["ciPipelineSeconds", "askUserSeconds", "repoSetupSeconds", "commandSeconds", "commandSilenceSeconds", "containerStartSeconds", "imagePullSeconds"].map((key) => [key, positive()])), ["ciPipelineSeconds", "repoSetupSeconds", "commandSeconds"]),
  memory: obj({ maxNoteLines: positive(), docScout: obj({ maxFilesRead: positive(), maxOutputLines: positive() }, ["maxFilesRead", "maxOutputLines"]) }, ["maxNoteLines", "docScout"]),
  naming: obj({ types: { ...texts(), minItems: 1 }, branch: text(), mergeRequest: text(), slackChannel: text(), devVersionSuffix: text(), slugMaxLength: positive(), typeFromJiraIssueType: { type: "object", additionalProperties: text() } }, ["types", "branch", "mergeRequest", "slackChannel", "devVersionSuffix", "slugMaxLength", "typeFromJiraIssueType"]),
  git: { anyOf: [obj({ committer: obj({ name: text(), email: text() }, ["name", "email"]) }), { type: "null" }] },
  gitlab: obj({ mrDraft: bool("Brouillon"), mrDescriptionLanguage: text(), commitLanguage: text(), commitConvention: text() }, ["mrDraft", "mrDescriptionLanguage", "commitLanguage", "commitConvention"]),
  jira: obj({ baseUrl: text(), assignToSelf: bool("Assignation"), transitions: bySquad(obj({ apresMr: text() }, ["apresMr"])), workflow2: { type: "object" } }, ["baseUrl", "assignToSelf", "transitions"]),
  slack: obj({ channelVisibility: { enum: ["private", "public"] }, invitees: bySquad(texts()) }, ["channelVisibility", "invitees"]),
  liveMode: obj({ portRange: arr("Plage de ports", num("Port", { type: "integer", minimum: 1024, maximum: 65535 }), { minItems: 2, maxItems: 2 }), openBrowser: bool("Ouvrir le navigateur") }, ["portRange", "openBrowser"]),
  limits: obj({ commandOutputBytes: positive() }),
}, ["schemaVersion", "budgets", "timeouts", "memory", "naming", "gitlab", "jira", "slack", "liveMode"]);

const repoSchema = obj({
  name: str("Nom du depot", { pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
  level: num("Niveau", { type: "integer", minimum: 0 }), path: text(),
  gitlabProject: str("Projet GitLab", { pattern: "^[^\\s/?#]+(?:/[^\\s/?#]+)+$" }),
  baseBranch: text(), layer: { enum: ["front", "backend", "data", "eval"] },
  packageManager: { enum: ["npm", "pnpm", "yarn"] }, monorepoTool: { enum: ["turbo", "lerna", null] },
  packageName: nullableText, dependsOn: texts(), commands: commandMap(nullableText), withoutTests: bool("Sans suite"),
  localFiles: texts(), reports: commandMap(text()), targeting: commandMap(nullableText),
  containers: obj({ required: bool("Runtime requis"), images: texts() }, ["required", "images"]),
  ciJobsToWatch: texts(), description: text(), keywords: texts(),
}, ["name", "level", "path", "gitlabProject", "baseBranch", "layer", "packageManager", "monorepoTool", "packageName", "dependsOn", "commands", "ciJobsToWatch", "description", "keywords"]);

const registrySchema = obj({
  schemaVersion: { const: 1 },
  repositories: arr("Depots", repoSchema, { minItems: 1 }),
  evalOnly: obj({ repos: texts(), jiraProjects: texts() }, ["repos", "jiraProjects"]),
}, ["schemaVersion", "repositories", "evalOnly"]);

export function validateConfig(value: unknown): void { validate(configSchema, value, "autopilot.yaml"); }
export function validateRegistry(value: unknown): void { validate(registrySchema, value, "repositories.yaml"); }
