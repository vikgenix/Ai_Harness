import type { JsonSchemaProperty, ToolInputSchema } from "../model/types.js";

/**
 * Checks tool input against its schema. Models sometimes send wrong types or
 * forget fields, and streamed input can arrive cut off, so nothing is run
 * before this passes. Returns an error message for the model, or null if valid.
 */
export function validateInput(schema: ToolInputSchema, input: unknown): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "input must be a JSON object";
  }
  const obj = input as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    if (obj[key] === undefined || obj[key] === null) return `missing required field '${key}'`;
  }
  for (const [key, value] of Object.entries(obj)) {
    const prop = schema.properties[key];
    if (!prop) {
      if (schema.additionalProperties === false) {
        return `unknown field '${key}' (expected: ${Object.keys(schema.properties).join(", ")})`;
      }
      continue;
    }
    // Optional fields sent as null are treated as absent.
    if (value === null && !schema.required?.includes(key)) continue;
    const err = checkValue(prop, value, key);
    if (err) return err;
  }
  return null;
}

function checkValue(prop: JsonSchemaProperty, value: unknown, path: string): string | null {
  const got = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  switch (prop.type) {
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return `'${path}' must be an integer, got ${got}`;
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return `'${path}' must be a number, got ${got}`;
      break;
    case "array":
      if (!Array.isArray(value)) return `'${path}' must be an array, got ${got}`;
      if (prop.items) {
        for (let i = 0; i < value.length; i++) {
          const err = checkValue(prop.items, value[i], `${path}[${i}]`);
          if (err) return err;
        }
      }
      break;
    case "object":
      if (got !== "object") return `'${path}' must be an object, got ${got}`;
      break;
    default:
      if (typeof value !== prop.type) return `'${path}' must be a ${prop.type}, got ${got}`;
  }
  if (prop.minimum !== undefined && typeof value === "number" && value < prop.minimum) {
    return `'${path}' must be at least ${prop.minimum}`;
  }
  if (prop.enum && !prop.enum.includes(value as string)) {
    return `'${path}' must be one of: ${prop.enum.join(", ")}`;
  }
  return null;
}
