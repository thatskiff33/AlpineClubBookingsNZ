function hasPrismaErrorCode(
  error: unknown,
  code: string
): error is { code: string } {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === code
  );
}

/**
 * Collect the stable database error text Prisma and adapter-pg may place at
 * different wrapper depths. The walker is deliberately cycle-safe: adapter
 * errors are foreign objects and tests have caught versions that retain their
 * parent through `cause`. Only the named error-bearing fields are traversed so
 * request data or arbitrary model values cannot accidentally become a match.
 */
export function collectPrismaErrorText(error: unknown): string {
  const visited = new WeakSet<object>();

  function collect(value: unknown, depth: number): string[] {
    if (depth > 8 || value == null) return [];
    if (typeof value === "string") return [value];
    if (typeof value !== "object") return [];
    if (visited.has(value)) return [];
    visited.add(value);

    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of ["message", "detail", "constraint", "originalMessage"]) {
      if (typeof record[key] === "string") parts.push(record[key] as string);
    }
    for (const key of ["meta", "driverAdapterError", "cause"]) {
      if (record[key] != null) parts.push(...collect(record[key], depth + 1));
    }
    return parts;
  }

  return collect(error, 0).join("\n");
}

export function isPrismaUniqueConstraintError(error: unknown) {
  return hasPrismaErrorCode(error, "P2002");
}

/**
 * Lowercase, drop the backticks and double quotes the shapes below carry, and
 * put a composite list on one separator. Shape 2 hands over a field ARRAY
 * (joined with a space) while shape 3 captures Prisma's rendered list verbatim
 * (`` (`memberId`,`seasonYear`) ``), so without this the same composite
 * constraint would describe itself differently depending on whether Postgres
 * sent the `Key (…)` detail. Callers get one answer per constraint, whatever
 * shape carried it.
 */
function normaliseConstraintTarget(raw: string): string {
  return raw
    .replace(/[`"]/g, "")
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean)
    .join(" ");
}

function readStringArray(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0
  );
}

/**
 * Names what a unique-constraint failure (SQLSTATE 23505 / P2002) actually
 * collided on — lowercased, quotes and backticks stripped, composite lists
 * space-separated — or null when the error carries nothing identifiable.
 *
 * Unique constraints only. A CHECK or trigger violation loses its constraint
 * name entirely under the driver adapter, which is why
 * `booking-envelope-invariants.ts` scans nested message text instead.
 *
 * ## What `@prisma/adapter-pg` really populates (measured, #2412)
 *
 * Measured on 1 Aug 2026 against PostgreSQL 16 with Prisma 7.9.0 + the `pg`
 * driver adapter, using this repo's own migration tree:
 *
 * - **`meta.target` is NEVER populated.** Not for a schema-level `@unique`, not
 *   for a hand-written partial index. It was the old Rust query engine's field;
 *   the driver adapter does not fill it. Any code that only reads `meta.target`
 *   is dead under this stack — that is exactly how the `joinCode` collision
 *   retry in `group-booking.ts` silently stopped firing.
 * - **The real signal is `meta.driverAdapterError.cause.constraint.fields`,** a
 *   string array. The adapter builds it by parsing the `Key (…)` detail of the
 *   SQLSTATE 23505 error, so it lists COLUMNS, never the index name — a raw
 *   partial index reports its column just like a schema `@unique` does. There is
 *   NO observable difference between the two index kinds here; the long-assumed
 *   "schema `@unique` behaves differently from a raw partial index" distinction
 *   is not real.
 * - **Column names arrive quoted exactly as Postgres quoted them.** A camelCase
 *   column comes back as `"joinCode"` (with literal double quotes), a lowercase
 *   one as `email`. Hence the quote stripping — and hence any caller comparing
 *   names must do it case-insensitively.
 * - The formatted `error.message` is rendered from the same field list
 *   (``Unique constraint failed on the fields: (`"joinCode"`)``), wrapped in an
 *   "Invalid `prisma.x.y()` invocation in …" preamble plus a source excerpt.
 *
 * Verbatim `meta` for a duplicate `GroupBooking.joinCode` (schema `@unique`):
 *
 *     {"modelName":"GroupBooking","driverAdapterError":{"name":"DriverAdapterError",
 *      "cause":{"originalCode":"23505","originalMessage":"duplicate key value violates
 *      unique constraint \"GroupBooking_joinCode_key\"","kind":"UniqueConstraintViolation",
 *      "constraint":{"fields":["\"joinCode\""]}}}}
 *
 * and for a duplicate on the raw partial index `Member_email_login_unique`:
 *
 *     {"modelName":"Member","driverAdapterError":{"name":"DriverAdapterError",
 *      "cause":{"originalCode":"23505","originalMessage":"duplicate key value violates
 *      unique constraint \"Member_email_login_unique\"","kind":"UniqueConstraintViolation",
 *      "constraint":{"fields":["email"]}}}}
 *
 * All four shapes are still read, most trustworthy first, so this keeps working
 * if the driver adapter is ever dropped (`meta.target` returns) or if Postgres
 * withholds the `Key (…)` detail (only the message is left).
 */
export function describeUniqueConstraintTarget(error: unknown): string | null {
  const meta = (error as { meta?: Record<string, unknown> } | null)?.meta;

  // 1. The pre-driver-adapter query engine's field. Empty under adapter-pg, but
  //    read first so behaviour is preserved if the adapter is ever dropped.
  const targets = readStringArray(meta?.target);
  if (targets.length > 0) {
    return normaliseConstraintTarget(targets.join(" "));
  }

  // 2. What adapter-pg actually populates.
  const constraint = (
    meta?.driverAdapterError as
      | { cause?: { constraint?: { fields?: unknown; index?: unknown } } }
      | undefined
  )?.cause?.constraint;
  const fields = readStringArray(constraint?.fields);
  if (fields.length > 0) {
    return normaliseConstraintTarget(fields.join(" "));
  }
  if (typeof constraint?.index === "string" && constraint.index.length > 0) {
    return normaliseConstraintTarget(constraint.index);
  }

  // 3. The formatted message, which is rendered from the same field list. The
  //    real message wraps the sentence in an "Invalid `prisma.x.y()` invocation
  //    in …" preamble plus a source excerpt of the call, so the sentence is
  //    matched anywhere rather than at the start — but on Prisma's whole
  //    sentence, because that excerpt renders CALL ARGUMENTS. Member free text
  //    reading `fields: (googleSub)` would otherwise be matched first and name
  //    the wrong column.
  const message = error instanceof Error ? error.message : "";
  const messageFields = message.match(
    /Unique constraint failed on the fields: \(([^)]*)\)/i
  )?.[1];
  if (messageFields) {
    return normaliseConstraintTarget(messageFields);
  }
  const index = message.match(
    /Unique constraint failed on the constraint: `([^`]*)`/i
  )?.[1];
  if (index) {
    return normaliseConstraintTarget(index);
  }
  return null;
}
