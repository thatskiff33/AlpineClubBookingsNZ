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

/**
 * Exact SQLSTATE 55P03 (`lock_not_available`: a `NOWAIT` lock that was held,
 * or a `lock_timeout`) for direct pg and nested Prisma adapter errors.
 */
export function isPostgresLockNotAvailable(
  error: unknown,
  depth = 0,
): boolean {
  if (depth > 5 || !error || typeof error !== "object") return false;
  const candidate = error as Record<string, unknown>;
  if (candidate.code === "55P03" || candidate.originalCode === "55P03") {
    return true;
  }
  return ["meta", "driverAdapterError", "cause"].some((key) =>
    isPostgresLockNotAvailable(candidate[key], depth + 1),
  );
}

/**
 * Prisma's interactive-transaction contention codes: P2028 (its `maxWait` or
 * `timeout` ran out, or the transaction had already closed) and P2034 (a write
 * conflict or deadlock). Nothing the transaction wrote was committed.
 *
 * The one reading (#4656): the linked date move, the refund-note create's
 * record, `waitlist-confirm/route.ts`, `admin/site-style/route.ts`, the
 * deletion release, the return to the waitlist, the group invoice email
 * fence (#4919) and the booking create route (#4933) all ask it. This list is
 * a sample, not the census: search for the callers. A few settings writers ask
 * `isSingletonUpsertContention` below instead, because theirs also counts
 * `P2002`.
 */
export function isTransactionContention(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "P2028" || code === "P2034";
}

/**
 * `isTransactionContention` plus `P2002`, for the settings writers where a
 * unique-constraint violation can only mean a concurrent save won a race (the
 * create arm of a constant-id singleton upsert, or club-tax's same-date
 * period) and the loser wrote nothing, so it is retried as contention there.
 * Everywhere else `P2002` is a real unique-constraint violation.
 *
 * Whether `P2002` is safe depends on every table that transaction writes, so
 * each caller states its own reason (or a pointer to it) directly above the
 * call, and must stop using this if that reason stops holding. Find the callers
 * with `git grep -n "isSingletonUpsertContention("` rather than a list here.
 */
export function isSingletonUpsertContention(error: unknown): boolean {
  return (
    isTransactionContention(error) ||
    (error as { code?: unknown } | null)?.code === "P2002"
  );
}

/**
 * Any object whose `code` is `P2002`, recognised by shape rather than class, so
 * a test double or an error that crossed a module boundary still counts.
 *
 * One of two spellings of the test (#5407 item 6). A site that requires
 * Prisma's own error class asks `isPrismaKnownUniqueConstraintError` in
 * `prisma-known-errors.ts` instead: the same code test plus the class, kept
 * there because this module imports nothing. Moving such a site here would
 * widen what it catches. Three sites add a condition of their own on top of
 * the class and code (the `joinCode` collision in `group-booking.ts`, the
 * occurrence key in `edit-financial-review.ts`, the open-slot key in
 * `booking-exception-request-service.ts`), and the bed range assignment
 * retries a set of codes; `prisma-p2002-census.test.ts` lists what it allows.
 * A site that must know which constraint collided reads
 * `describeUniqueConstraintTarget` below.
 */
export function isPrismaUniqueConstraintError(error: unknown) {
  return hasPrismaErrorCode(error, "P2002");
}

/** `P2025`: an `update`/`delete` whose `where` matched no row. */
export function isPrismaRecordNotFoundError(error: unknown) {
  return hasPrismaErrorCode(error, "P2025");
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
