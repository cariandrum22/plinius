/**
 * Minimal JSON Schema validator (draft-07 subset).
 *
 * Supports the keywords needed by structural benchmark checks: type, required,
 * properties, additionalProperties (boolean), items, enum, minItems, maxItems,
 * minLength, pattern. This is intentionally small and dependency-free; it is
 * not a general-purpose validator.
 */
export interface JsonSchemaError {
  path: string;
  message: string;
}

type Schema = Record<string, unknown>;

export function validateJsonSchema(
  value: unknown,
  schema: Schema,
): JsonSchemaError[] {
  const errors: JsonSchemaError[] = [];
  walk(value, schema, "$", errors);
  return errors;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  if (type === "number") return actual === "number" || actual === "integer";
  if (type === "integer") return actual === "integer";
  return actual === type;
}

function walk(
  value: unknown,
  schema: Schema,
  path: string,
  errors: JsonSchemaError[],
): void {
  if (typeof schema.type === "string" && !matchesType(value, schema.type)) {
    errors.push({
      path,
      message: `expected type ${schema.type}, got ${typeOf(value)}`,
    });
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) {
    errors.push({ path, message: `value not in enum` });
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push({ path, message: `shorter than minLength ${schema.minLength}` });
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
      errors.push({ path, message: `does not match pattern ${schema.pattern}` });
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push({ path, message: `fewer than minItems ${schema.minItems}` });
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push({ path, message: `more than maxItems ${schema.maxItems}` });
    }
    if (schema.items && typeof schema.items === "object") {
      value.forEach((item, i) =>
        walk(item, schema.items as Schema, `${path}[${i}]`, errors),
      );
    }
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties as Record<string, Schema>) ?? {};

    if (Array.isArray(schema.required)) {
      for (const key of schema.required as string[]) {
        if (!(key in record)) {
          errors.push({ path: `${path}.${key}`, message: `missing required property` });
        }
      }
    }

    for (const [key, child] of Object.entries(record)) {
      if (properties[key]) {
        walk(child, properties[key], `${path}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push({ path: `${path}.${key}`, message: `additional property not allowed` });
      }
    }
  }
}

/**
 * Best-effort extraction of a JSON value from model prose. Tries whole-string
 * parse, then a fenced ```json block, then the first balanced object/array.
 */
export function extractJson(text: string): { value?: unknown; error?: string } {
  const attempts: string[] = [];
  const trimmed = text.trim();
  attempts.push(trimmed);

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) attempts.push(fence[1].trim());

  const firstBrace = trimmed.search(/[[{]/);
  if (firstBrace !== -1) {
    const lastBrace = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
    if (lastBrace > firstBrace) attempts.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const attempt of attempts) {
    try {
      return { value: JSON.parse(attempt) };
    } catch {
      // try next
    }
  }
  return { error: "no valid JSON found in output" };
}
