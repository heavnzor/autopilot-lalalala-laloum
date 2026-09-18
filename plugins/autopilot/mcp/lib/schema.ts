import { Ajv, type ValidateFunction } from "ajv";
import { ToolError } from "./errors.ts";

/**
 * Les schemas d'entree sont ecrits une seule fois, en JSON Schema, parce que
 * c'est exactement ce que le modele lit avant d'appeler un tool. Les decrire en
 * double — une fois pour le modele, une fois pour la validation — c'est
 * s'offrir deux verites qui divergent au troisieme changement.
 */

export type JsonSchema = Record<string, unknown>;

export function str(description: string, extra: JsonSchema = {}): JsonSchema {
  return { type: "string", description, ...extra };
}

export function num(description: string, extra: JsonSchema = {}): JsonSchema {
  return { type: "number", description, ...extra };
}

export function bool(description: string, extra: JsonSchema = {}): JsonSchema {
  return { type: "boolean", description, ...extra };
}

export function enumOf(description: string, values: readonly string[], extra: JsonSchema = {}): JsonSchema {
  return { type: "string", description, enum: [...values], ...extra };
}

export function arr(description: string, items: JsonSchema, extra: JsonSchema = {}): JsonSchema {
  return { type: "array", description, items, ...extra };
}

export function obj(
  properties: Record<string, JsonSchema>,
  required: readonly string[] = [],
  extra: JsonSchema = {},
): JsonSchema {
  return { type: "object", properties, required: [...required], additionalProperties: false, ...extra };
}

export function anyValue(description: string): JsonSchema {
  return { description };
}

// Le schema annonce au client est aussi celui qui s'applique. Le validateur
// precedent ignorait additionalProperties, pattern et les bornes numeriques.
const ajv = new Ajv({ allErrors: true, strict: true, strictNumbers: true, ownProperties: true });
const validators = new WeakMap<JsonSchema, ValidateFunction>();

export function validate(schema: JsonSchema, value: unknown, path = "input"): void {
  let check = validators.get(schema);
  if (!check) {
    check = ajv.compile(schema);
    validators.set(schema, check);
  }
  if (!check(value)) {
    const issues = (check.errors ?? []).map((issue) => `${path}${issue.instancePath} : ${issue.message}`).join(" ; ");
    throw new ToolError(issues || `${path} : entree invalide.`);
  }
}
