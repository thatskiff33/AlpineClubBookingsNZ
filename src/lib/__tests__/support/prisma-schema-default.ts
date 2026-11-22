/** Read a field's `@default(...)` straight from the Prisma schema text. */

/** The raw token inside `@default(...)` for a field, or null when it has none. */
export function schemaDefaultToken(
  schema: string,
  modelName: string,
  fieldName: string,
): string | null {
  const lines = schema.split(/\r?\n/);
  let inModel = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.match(new RegExp(`^model\\s+${modelName}\\s*\\{`))) {
      inModel = true;
      continue;
    }
    if (inModel && line.startsWith("}")) break;
    if (inModel && line.match(new RegExp(`^${fieldName}\\s`))) {
      const m = line.match(/@default\(([^)]*)\)/);
      return m?.[1] === undefined ? null : m[1].replace(/^"|"$/g, "");
    }
  }
  return null;
}
