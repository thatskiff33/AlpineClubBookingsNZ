/**
 * `import "server-only"` makes the production build REFUSE this module in a
 * browser bundle, at any depth (`INV-OPS-013`, #2850). Operator CLIs reach it
 * under plain Node, where that marker would throw at import, so every `tsx`
 * invocation that reaches it runs with `--conditions=react-server` — which
 * resolves `server-only` to an empty module. `cli-server-only-reach-census.test.ts`
 * enforces that pairing; `docs/invariants/operations.md` carries the reasoning.
 */
import "server-only";

import { prisma } from "./prisma";
import type { Prisma, PrismaClient } from "@prisma/client";
import logger from "@/lib/logger";
import { isAuditCategory, type AuditCategory } from "./audit-categories";
// test seam
export { buildMemberAuditLogWhere } from "./audit-query";

/**
 * The writer's category type is the canonical CLOSED taxonomy (#2581), re-exported
 * here so every existing `import type { AuditCategory } from "@/lib/audit"` keeps
 * resolving.
 *
 * It used to be an eleven-member union ending in `| (string & {})`, which accepts
 * any string at all. Two invented values reached the database through that escape
 * — `membership` from three nomination writers and `auth` from the auth-bounce
 * writer — and each produced rows that no Admin filter and no Diagnostics
 * correlation tool could select, because every reader filters on the named values.
 * A typo would have done the same thing without anyone noticing. `family` had the
 * mirror-image problem: 27 sites wrote it while it was missing from the union, so
 * it was only ever accepted BY the escape.
 *
 * See `audit-categories.ts` for the list itself and for which permission each
 * category's evidence sits behind.
 */
export type { AuditCategory };

export type AuditSeverity = "info" | "important" | "critical";
// The auth-bounce diagnostics (#1669) store their classification reason in
// the outcome column so bounce records stay queryable via the existing
// (outcome, createdAt) index.
type AuditOutcome =
  | "success"
  | "failure"
  | "blocked"
  | "cookie-present-no-session"
  | "session-invalidated";
export type AuditRetentionClass =
  | "critical"
  | "sensitive_access"
  | "diagnostic_high_volume"
  | "standard";

export type AuditLogParams = {
  action: string;
  memberId?: string | null;
  targetId?: string | null;
  details?: string | null;
  ipAddress?: string | null;
  actorMemberId?: string | null;
  subjectMemberId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  /**
   * REQUIRED, and non-null — the third and last part of #2581's writer contract
   * (owner decisions 5 and 6: "make category mandatory for all production audit
   * writers", "prevent recurrence through BOTH type-level and CI contract
   * enforcement").
   *
   * It was `category?: AuditCategory | null` until every production writer had
   * one. That was deliberate — child 1 established the closed taxonomy and the
   * census, child 2's sweep classified all 82 omitting sites — but it left the
   * type saying the opposite of the rule: omission still compiled, and the only
   * thing standing between a new writer and a permanently unreadable row was a
   * census test the author had to run. Now omission does not compile, so the
   * census contract is a second line rather than the only one.
   *
   * A row with no category is read by NOBODY: every AI Diagnostics correlation
   * tool selects `category = ANY ($1)`, which is NULL — not true — for a NULL
   * column. It is also kept forever, because `buildAuditLogCreateData` derived
   * retention only when a category, severity or retention class was present.
   *
   * `StructuredAuditEvent.category` (below) has always been required; this makes
   * the two writer shapes agree.
   */
  category: AuditCategory;
  severity?: AuditSeverity | null;
  outcome?: AuditOutcome | null;
  summary?: string | null;
  metadata?: unknown;
  requestId?: string | null;
  userAgent?: string | null;
  retentionClass?: AuditRetentionClass | null;
  expiresAt?: Date | null;
  archivedAt?: Date | null;
  incidentPreserved?: boolean | null;
};

export type StructuredAuditEvent = {
  action: string;
  actor?: {
    memberId?: string | null;
  };
  subject?: {
    memberId?: string | null;
  };
  entity?: {
    type?: string | null;
    id?: string | null;
  };
  category: AuditCategory;
  severity?: AuditSeverity | null;
  outcome?: AuditOutcome | null;
  summary?: string | null;
  details?: string | null;
  metadata?: unknown;
  request?: {
    id?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  };
  retentionClass?: AuditRetentionClass | null;
  expiresAt?: Date | null;
  incidentPreserved?: boolean | null;
};

/**
 * Any client that can write an audit row.
 *
 * A structural `Pick` rather than `Prisma.TransactionClient | typeof prisma`
 * (#2576): the services that record audit rows take NARROW `Pick<PrismaClient, ...>`
 * clients so their tests can pass a double, and a union of the two full client types
 * refuses those even though every real caller passes a `tx` or the module client.
 * Both of those still satisfy this, so no existing caller changes.
 */
export type AuditLogClient = Pick<PrismaClient, "auditLog">;

const REDACTED = "[REDACTED]";
const REDACTED_CARD = "[REDACTED_CARD]";
const REDACTED_LONG_HTML = "[REDACTED_LONG_HTML]";
const TRUNCATED = "[TRUNCATED]";
const MAX_METADATA_DEPTH = 6;
const MAX_METADATA_ARRAY_ITEMS = 50;
const MAX_METADATA_OBJECT_KEYS = 75;
const MAX_METADATA_STRING_LENGTH = 1000;
const MAX_METADATA_JSON_LENGTH = 24000;

const SECRET_VALUE_PATTERN =
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+|\bwhsec_[A-Za-z0-9]+|\b(?:pi|seti|si|cs)_[A-Za-z0-9]+_secret_[A-Za-z0-9]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\/membership-cancellation\/[A-Za-z0-9_-]+/;
const SENSITIVE_TEXT_KEY_VALUE_PATTERN =
  /\b(password|passcode|token|secret|authorization|cookie|card(?:number)?|cvc|cvv)\s*[:=]\s*("[^"]*"|'[^']*'|(?:\d[ -]?){12,18}\d|[^,\s;]+)/gi;
const PAYMENT_CARD_NUMBER_PATTERN = /\b(?:\d[ -]?){13,19}\b/g;

type SanitizedMetadataValue = Prisma.InputJsonValue | null;

/**
 * ARCHIVE MODE for audit metadata (#2269 review).
 *
 * The defaults above are tuned for INCIDENTAL metadata — a payload echoed into
 * an audit row so an operator can see what happened. Clipping such a value at
 * 1000 characters loses nothing that matters.
 *
 * A few audit rows are different in kind: the metadata IS the record. #2269's
 * Restore Default deletes a club's own email wording with one click and no undo
 * in the product, and the audit row is the only copy afterwards; a 1748-char
 * body was measured stored as 1014 characters ending "[TRUNCATED]", which is
 * not a copy of anything. Those callers pass this.
 *
 * WHAT IT DOES NOT RELAX, because these are the parts that protect people
 * rather than the parts that save space:
 *
 *   - secret/API-key redaction (SECRET_VALUE_PATTERN) still runs;
 *   - `password: …` / `token: …` style key-value redaction still runs;
 *   - payment-card-number redaction (Luhn-checked) still runs;
 *   - sensitive KEY names are still replaced wholesale.
 *
 * What it does relax is size: strings are kept whole up to `maxStringLength`
 * instead of 1000, the JSON envelope gets matching headroom (JSON escaping can
 * double a value made mostly of newlines), and a long value is not swapped for
 * [REDACTED_LONG_HTML] merely because it contains angle brackets. That last
 * placeholder exists to keep giant rendered HTML emails out of the audit log,
 * a size concern the caller has already answered by bounding the value — the
 * email-template columns are capped at 500 and 10,000 characters by the save
 * route — and letting it fire would put a club's wording back out of reach for
 * the sake of a "<see the noticeboard>" somewhere in the middle of it.
 */
export interface AuditMetadataOptions {
  archiveText?: {
    /** Longest single string kept whole. Bound it from the caller's own cap. */
    maxStringLength: number;
  };
}

function metadataStringLimit(options?: AuditMetadataOptions): number {
  return options?.archiveText?.maxStringLength ?? MAX_METADATA_STRING_LENGTH;
}

function metadataJsonLimit(options?: AuditMetadataOptions): number {
  const archived = options?.archiveText?.maxStringLength;
  // Headroom for one archived value on top of the ordinary envelope. Two bytes
  // per character is what JSON escaping costs at worst for ORDINARY text — a
  // value that is entirely newlines, quotes or backslashes. A value stuffed
  // with C0 control characters escapes to six bytes each and could still
  // overflow; that falls back to the {_truncated, preview} stub, which is
  // degraded but never wrong, and no email template body reaches this shape.
  return archived === undefined
    ? MAX_METADATA_JSON_LENGTH
    : MAX_METADATA_JSON_LENGTH + archived * 2;
}

function sanitizeAuditDetails(value?: string | null): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return sanitizeAuditArchiveText(value) ?? undefined;
}

/**
 * THIS LIST DELIBERATELY REDACTS LESS THAN THE LOG REDACTOR — INV-PRIV-011
 * (#2683).
 *
 * It redacts credentials, tokens, card numbers and long HTML. It does NOT
 * redact person fields, so an `AuditLog` row keeps first name, last name and
 * street address where the caller recorded them. That is the decision, not an
 * oversight: the log/Sentry redactor
 * (`src/lib/redact-sensitive-json.ts`) strips all of those, and an `AuditLog`
 * row is different in kind — a permission-gated, retention-classed evidence
 * record whose job is to say who did what to whom, which stops being evidence
 * if "who" is unreadable. The owner confirmed it on 10 Aug 2026 against the
 * blanket-redaction recommendation. This schema holds no special-category data,
 * which is what bounds the exposure, and the ARCHIVE MODE note above records
 * what over-redaction had already cost once.
 *
 * The boundary is this module, not anyone's intent: a value keeps a person field
 * only by being written as an audit row through this file. There is no flag or
 * "audit context" marker on the redactor for a later change to copy, so do not
 * add person fields here as part of a tidy-up that makes the two key lists
 * "consistent" — the difference IS the decision. `audit.test.ts` pins all three
 * fields in both directions at once, so a change to either side fails it.
 */
function isSensitiveMetadataKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();

  return (
    normalized.includes("password") ||
    normalized.includes("passwordhash") ||
    normalized.includes("resettoken") ||
    normalized.includes("verificationtoken") ||
    normalized.includes("nominationtoken") ||
    normalized.includes("sessiontoken") ||
    normalized.includes("accesstoken") ||
    normalized.includes("refreshtoken") ||
    normalized.includes("authtoken") ||
    normalized.includes("authsecret") ||
    normalized.includes("clientsecret") ||
    normalized.includes("paymentmethodsecret") ||
    normalized.includes("paymentintentsecret") ||
    normalized.includes("setupintentsecret") ||
    normalized.includes("stripesignature") ||
    normalized.includes("authorization") ||
    normalized.includes("cookie") ||
    normalized.includes("secret") ||
    normalized === "token" ||
    normalized === "rawbody" ||
    normalized === "requestbody" ||
    normalized === "body" ||
    normalized === "html" ||
    normalized === "emailhtml" ||
    normalized === "htmlbody" ||
    normalized === "emailbody" ||
    normalized === "messagehtml" ||
    normalized === "card" ||
    normalized === "cardnumber" ||
    normalized === "cardcvc" ||
    normalized === "cardcvv" ||
    normalized === "cvc" ||
    normalized === "cvv"
  );
}

function isLongHtml(value: string): boolean {
  return value.length > 500 && /<\/?[a-z][\s\S]*>/i.test(value);
}

function isLikelyPaymentCardNumber(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) {
    return false;
  }

  let sum = 0;
  let shouldDouble = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(SENSITIVE_TEXT_KEY_VALUE_PATTERN, (_match, key: string) => {
      return `${key}=${REDACTED}`;
    })
    .replace(PAYMENT_CARD_NUMBER_PATTERN, (candidate) => {
      return isLikelyPaymentCardNumber(candidate) ? REDACTED_CARD : candidate;
    });
}

function sanitizeMetadataString(
  value: string,
  options?: AuditMetadataOptions
): string {
  if (SECRET_VALUE_PATTERN.test(value)) {
    return REDACTED;
  }
  const redacted = redactSensitiveText(value);
  if (isLongHtml(value) && !options?.archiveText) {
    return REDACTED_LONG_HTML;
  }
  const limit = metadataStringLimit(options);
  if (redacted.length > limit) {
    return `${redacted.slice(0, limit)}...${TRUNCATED}`;
  }
  return redacted;
}

/**
 * Sanitize a free-text audit value at the ORDINARY limits (the 1000-character
 * clip included). "Archive" here is about the `details` column rather than
 * about AuditMetadataOptions.archiveText, which is what keeps a value whole.
 */
export function sanitizeAuditArchiveText(
  value?: string | null
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return sanitizeMetadataString(value);
}

function sanitizeMetadataValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  options?: AuditMetadataOptions
): SanitizedMetadataValue | undefined {
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    return undefined;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return sanitizeMetadataString(value, options);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (depth >= MAX_METADATA_DEPTH) {
    return TRUNCATED;
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (seen.has(value)) {
    return "[Circular]";
  }

  seen.add(value);

  if (value instanceof Error) {
    return sanitizeMetadataValue(
      {
        name: value.name,
        message: value.message,
      },
      depth + 1,
      seen,
      options
    );
  }

  if (Array.isArray(value)) {
    const sanitizedItems = value
      .slice(0, MAX_METADATA_ARRAY_ITEMS)
      .map((item) => sanitizeMetadataValue(item, depth + 1, seen, options))
      .filter((item): item is SanitizedMetadataValue => item !== undefined);

    if (value.length > MAX_METADATA_ARRAY_ITEMS) {
      sanitizedItems.push(TRUNCATED);
    }

    return sanitizedItems;
  }

  const sanitizedObject: Record<string, SanitizedMetadataValue> = {};
  const entries = Object.entries(value).slice(0, MAX_METADATA_OBJECT_KEYS);

  for (const [key, childValue] of entries) {
    if (isSensitiveMetadataKey(key)) {
      sanitizedObject[key] = REDACTED;
      continue;
    }

    const sanitizedChild = sanitizeMetadataValue(
      childValue,
      depth + 1,
      seen,
      options
    );
    if (sanitizedChild !== undefined) {
      sanitizedObject[key] = sanitizedChild;
    }
  }

  if (Object.keys(value).length > MAX_METADATA_OBJECT_KEYS) {
    sanitizedObject._truncatedKeys = true;
  }

  return sanitizedObject;
}

export function sanitizeAuditMetadata(
  metadata: unknown,
  options?: AuditMetadataOptions
): Prisma.InputJsonValue | undefined {
  const sanitized = sanitizeMetadataValue(
    metadata,
    0,
    new WeakSet<object>(),
    options
  );
  if (sanitized === undefined || sanitized === null) {
    return undefined;
  }

  const serialized = JSON.stringify(sanitized);
  if (serialized.length <= metadataJsonLimit(options)) {
    return sanitized;
  }

  return {
    _truncated: true,
    _originalLength: serialized.length,
    preview: serialized.slice(0, MAX_METADATA_STRING_LENGTH),
  };
}

export function classifyAuditRetention(params: {
  action: string;
  category?: AuditCategory | null;
  severity?: AuditSeverity | null;
  retentionClass?: AuditRetentionClass | null;
}): AuditRetentionClass {
  if (params.retentionClass) {
    return params.retentionClass;
  }
  if (params.severity === "critical") {
    return "critical";
  }

  const action = params.action.toLowerCase();
  const isAccessEvent = /\b(view|access|login|logout|search)\b/.test(
    action.replace(/[._-]/g, " ")
  );

  if (
    isAccessEvent &&
    (params.category === "security" || params.category === "admin")
  ) {
    return "sensitive_access";
  }

  if (params.category === "system" && params.severity === "info") {
    return "standard";
  }

  return "critical";
}

// test seam
export function getAuditRetentionExpiresAt(
  retentionClass: AuditRetentionClass,
  from: Date = new Date()
): Date {
  const expiresAt = new Date(from);

  if (retentionClass === "diagnostic_high_volume") {
    expiresAt.setUTCDate(expiresAt.getUTCDate() + 90);
    return expiresAt;
  }
  if (retentionClass === "sensitive_access") {
    expiresAt.setUTCMonth(expiresAt.getUTCMonth() + 24);
    return expiresAt;
  }

  expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + 7);
  return expiresAt;
}

function compactCreateData(
  data: Prisma.AuditLogUncheckedCreateInput
): Prisma.AuditLogUncheckedCreateInput {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined)
  ) as Prisma.AuditLogUncheckedCreateInput;
}

/**
 * Thrown when a category reaches the write boundary that the closed taxonomy
 * does not contain — including `undefined` and `null`.
 *
 * Named rather than a bare `Error` so a caller that genuinely wants to tolerate
 * it can, and so the message in a log names the action rather than only the
 * value.
 */
export class AuditCategoryError extends Error {
  readonly action: string;
  readonly received: unknown;

  constructor(action: string, received: unknown) {
    super(
      `Audit write "${action}" supplied no canonical category (received ` +
        `${JSON.stringify(received) ?? String(received)}). ` +
        "A row without a canonical category is returned by no AI Diagnostics " +
        "correlation tool and is kept forever. Pass one of AUDIT_CATEGORIES " +
        "from @/lib/audit-categories.",
    );
    this.name = "AuditCategoryError";
    this.action = action;
    this.received = received;
  }
}

/**
 * The RUNTIME half of the mandatory-category contract (#2581).
 *
 * The type is the first line and catches every ordinary writer. This is the
 * second, and it exists because the type has three documented holes that a
 * security-relevant field should not rely on being closed: a `as never` /
 * `as AuditLogParams` cast (this repository uses `as never` freely in test
 * doubles), a value crossing from untyped JavaScript or JSON, and a category
 * read back out of a stored row and forwarded. `isAuditCategory` is the same
 * predicate every reader uses, so writer and reader cannot drift.
 *
 * BOTH builders call it, which is what makes it complete: every one of the four
 * approved boundaries funnels through one of the two.
 *
 *   createAuditLog            -> buildAuditLogCreateData
 *   logAudit                  -> createAuditLog -> buildAuditLogCreateData
 *   createStructuredAuditLog  -> buildStructuredAuditLogCreateData
 *   buildStructuredAuditLogCreateArgs -> buildStructuredAuditLogCreateData
 *
 * FAILURE SEMANTICS ARE DELIBERATELY UNCHANGED, not newly invented. Throwing
 * here behaves exactly as a failed `auditLog.create` already does at each
 * boundary, which is why no caller needs to change:
 *
 *  - `logAudit` is fire-and-forget: the throw becomes a rejected promise and is
 *    caught by its existing `.catch`, logged, and the business operation
 *    continues. Unchanged.
 *  - An awaited `createAuditLog`/`createStructuredAuditLog` inside a
 *    `$transaction` propagates and rolls the transaction back — the same
 *    "the audit row and the change it describes commit together" behaviour a
 *    database error already produces. Unchanged.
 *  - `buildStructuredAuditLogCreateArgs` throws synchronously at the call site,
 *    which is inside the same transaction callback, so it rolls back the same
 *    way. Unchanged.
 *
 * No production path can reach it today: the census measures 0 uncategorised,
 * 0 conditional and 1 forwarded site, and that one forwards a typed
 * `StructuredAuditEvent` whose five callers all pass a literal. It is
 * defence-in-depth for the next writer, not a live code path.
 */
function assertCanonicalAuditCategory(
  action: string,
  category: unknown,
): asserts category is AuditCategory {
  if (!isAuditCategory(category)) {
    throw new AuditCategoryError(action, category);
  }
}

function buildAuditLogCreateData(
  params: AuditLogParams
): Prisma.AuditLogUncheckedCreateInput {
  assertCanonicalAuditCategory(params.action, params.category);

  // Unconditional now that the category is mandatory. It used to be gated on
  // `params.retentionClass || params.category || params.severity`, and that gate
  // is precisely what kept the 82 uncategorised writers' rows at
  // `retentionClass = NULL, expiresAt = NULL` — never archived, never pruned,
  // kept forever. With a category always present the gate can never be false,
  // so it is removed rather than left as a branch that reads as if it can.
  const retentionClass = classifyAuditRetention(params);
  const metadata =
    params.metadata === undefined
      ? undefined
      : sanitizeAuditMetadata(params.metadata);

  return compactCreateData({
    action: params.action,
    memberId: params.memberId ?? undefined,
    targetId: params.targetId ?? undefined,
    details: sanitizeAuditDetails(params.details),
    ipAddress: params.ipAddress ?? undefined,
    actorMemberId: params.actorMemberId ?? params.memberId ?? undefined,
    subjectMemberId: params.subjectMemberId ?? undefined,
    entityType: params.entityType ?? undefined,
    entityId: params.entityId ?? undefined,
    category: params.category,
    severity: params.severity ?? undefined,
    outcome: params.outcome ?? undefined,
    summary: params.summary ?? undefined,
    metadata,
    requestId: params.requestId ?? undefined,
    userAgent: params.userAgent ?? undefined,
    retentionClass,
    // `expiresAt: null` stays the deliberate "keep this row forever" escape
    // hatch — it is named at the deletion-decision writer and is the owner's to
    // use. Everything else now derives an expiry, where before a writer that
    // passed no category derived neither a class nor an expiry.
    expiresAt:
      params.expiresAt === null
        ? undefined
        : params.expiresAt ?? getAuditRetentionExpiresAt(retentionClass),
    archivedAt: params.archivedAt ?? undefined,
    incidentPreserved: params.incidentPreserved ? true : undefined,
  });
}

function buildStructuredAuditLogCreateData(
  event: StructuredAuditEvent,
  options?: AuditMetadataOptions
): Prisma.AuditLogUncheckedCreateInput {
  assertCanonicalAuditCategory(event.action, event.category);

  const actorMemberId = event.actor?.memberId ?? undefined;
  const subjectMemberId = event.subject?.memberId ?? undefined;
  const entityId = event.entity?.id ?? undefined;
  const retentionClass = classifyAuditRetention(event);
  const expiresAt =
    event.expiresAt === null
      ? undefined
      : event.expiresAt ?? getAuditRetentionExpiresAt(retentionClass);

  return compactCreateData({
    action: event.action,
    memberId: actorMemberId,
    targetId: subjectMemberId ?? entityId,
    details: sanitizeAuditDetails(event.details),
    ipAddress: event.request?.ipAddress ?? undefined,
    actorMemberId,
    subjectMemberId,
    entityType: event.entity?.type ?? undefined,
    entityId,
    category: event.category,
    severity: event.severity ?? undefined,
    outcome: event.outcome ?? "success",
    summary: event.summary ?? undefined,
    metadata: sanitizeAuditMetadata(event.metadata, options),
    requestId: event.request?.id ?? undefined,
    userAgent: event.request?.userAgent ?? undefined,
    retentionClass,
    expiresAt,
    incidentPreserved: event.incidentPreserved ? true : undefined,
  });
}

export function buildStructuredAuditLogCreateArgs(
  event: StructuredAuditEvent,
  options?: AuditMetadataOptions
): Prisma.AuditLogCreateArgs {
  return {
    data: buildStructuredAuditLogCreateData(event, options),
  };
}

export function getAuditRequestContext(
  request: Request
): StructuredAuditEvent["request"] {
  const forwarded = request.headers.get("x-forwarded-for");
  const forwardedParts = forwarded
    ?.split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const ipAddress =
    forwardedParts?.[forwardedParts.length - 1] ??
    request.headers.get("x-real-ip") ??
    "unknown";

  return {
    id:
      request.headers.get("x-request-id") ??
      request.headers.get("x-correlation-id"),
    ipAddress,
    userAgent: request.headers.get("user-agent"),
  };
}

export function getAuditEmailDomain(email?: string | null): string | null {
  if (!email) {
    return null;
  }

  const [, domain] = email.toLowerCase().trim().split("@");
  return domain || null;
}

/**
 * Persist an audit record synchronously. Callers that need audit durability
 * should await this and, when relevant, pass the current transaction client.
 */
export async function createAuditLog(
  params: AuditLogParams,
  db: AuditLogClient = prisma
): Promise<void> {
  await db.auditLog.create({ data: buildAuditLogCreateData(params) });
}

/**
 * Persist a structured audit record with explicit actor/subject/entity fields.
 */
export async function createStructuredAuditLog(
  event: StructuredAuditEvent,
  db: AuditLogClient = prisma
): Promise<void> {
  await db.auditLog.create({ data: buildStructuredAuditLogCreateData(event) });
}

/**
 * Log a sensitive action for audit trail purposes.
 * Fire-and-forget: failures are logged but don't block the calling operation.
 */
export function logAudit(params: AuditLogParams): void {
  void createAuditLog(params)
    .catch((err) => {
      logger.error({ err }, "Failed to write audit log");
    });
}
