import { prisma } from "./prisma";
import type { Prisma } from "@prisma/client";
import logger from "@/lib/logger";
export {
  buildMemberAuditLogWhere,
  getAuditLogActorMemberId,
} from "./audit-query";

export type AuditCategory =
  | "account"
  | "booking"
  | "payment"
  | "admin"
  | "security"
  | "lodge"
  | "xero"
  | "communication"
  | "privacy"
  | "system"
  | (string & {});

export type AuditSeverity = "info" | "important" | "critical";
export type AuditOutcome = "success" | "failure" | "blocked";
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
  category?: AuditCategory | null;
  severity?: AuditSeverity | null;
  outcome?: AuditOutcome | null;
  summary?: string | null;
  metadata?: unknown;
  requestId?: string | null;
  userAgent?: string | null;
  retentionClass?: AuditRetentionClass | null;
  expiresAt?: Date | null;
  archivedAt?: Date | null;
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
};

type AuditLogClient = Prisma.TransactionClient | typeof prisma;

const REDACTED = "[REDACTED]";
const REDACTED_LONG_HTML = "[REDACTED_LONG_HTML]";
const TRUNCATED = "[TRUNCATED]";
const MAX_METADATA_DEPTH = 6;
const MAX_METADATA_ARRAY_ITEMS = 50;
const MAX_METADATA_OBJECT_KEYS = 75;
const MAX_METADATA_STRING_LENGTH = 1000;
const MAX_METADATA_JSON_LENGTH = 24000;

const SECRET_VALUE_PATTERN =
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+|\b(?:pi|seti|si|cs)_[A-Za-z0-9]+_secret_[A-Za-z0-9]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/;

type SanitizedMetadataValue = Prisma.InputJsonValue | null;

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

function sanitizeMetadataString(value: string): string {
  if (SECRET_VALUE_PATTERN.test(value)) {
    return REDACTED;
  }
  if (isLongHtml(value)) {
    return REDACTED_LONG_HTML;
  }
  if (value.length > MAX_METADATA_STRING_LENGTH) {
    return `${value.slice(0, MAX_METADATA_STRING_LENGTH)}...${TRUNCATED}`;
  }
  return value;
}

function sanitizeMetadataValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>
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
    return sanitizeMetadataString(value);
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
      seen
    );
  }

  if (Array.isArray(value)) {
    const sanitizedItems = value
      .slice(0, MAX_METADATA_ARRAY_ITEMS)
      .map((item) => sanitizeMetadataValue(item, depth + 1, seen))
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

    const sanitizedChild = sanitizeMetadataValue(childValue, depth + 1, seen);
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
  metadata: unknown
): Prisma.InputJsonValue | undefined {
  const sanitized = sanitizeMetadataValue(metadata, 0, new WeakSet<object>());
  if (sanitized === undefined || sanitized === null) {
    return undefined;
  }

  const serialized = JSON.stringify(sanitized);
  if (serialized.length <= MAX_METADATA_JSON_LENGTH) {
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

function buildAuditLogCreateData(
  params: AuditLogParams
): Prisma.AuditLogUncheckedCreateInput {
  const retentionClass =
    params.retentionClass || params.category || params.severity
      ? classifyAuditRetention(params)
      : undefined;
  const metadata =
    params.metadata === undefined
      ? undefined
      : sanitizeAuditMetadata(params.metadata);

  return compactCreateData({
    action: params.action,
    memberId: params.memberId ?? undefined,
    targetId: params.targetId ?? undefined,
    details: params.details ?? undefined,
    ipAddress: params.ipAddress ?? undefined,
    actorMemberId: params.actorMemberId ?? params.memberId ?? undefined,
    subjectMemberId: params.subjectMemberId ?? undefined,
    entityType: params.entityType ?? undefined,
    entityId: params.entityId ?? undefined,
    category: params.category ?? undefined,
    severity: params.severity ?? undefined,
    outcome: params.outcome ?? undefined,
    summary: params.summary ?? undefined,
    metadata,
    requestId: params.requestId ?? undefined,
    userAgent: params.userAgent ?? undefined,
    retentionClass,
    expiresAt:
      params.expiresAt === null
        ? undefined
        : params.expiresAt ??
          (retentionClass
            ? getAuditRetentionExpiresAt(retentionClass)
            : undefined),
    archivedAt: params.archivedAt ?? undefined,
  });
}

function buildStructuredAuditLogCreateData(
  event: StructuredAuditEvent
): Prisma.AuditLogUncheckedCreateInput {
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
    details: event.details ?? undefined,
    ipAddress: event.request?.ipAddress ?? undefined,
    actorMemberId,
    subjectMemberId,
    entityType: event.entity?.type ?? undefined,
    entityId,
    category: event.category,
    severity: event.severity ?? undefined,
    outcome: event.outcome ?? "success",
    summary: event.summary ?? undefined,
    metadata: sanitizeAuditMetadata(event.metadata),
    requestId: event.request?.id ?? undefined,
    userAgent: event.request?.userAgent ?? undefined,
    retentionClass,
    expiresAt,
  });
}

export function buildStructuredAuditLogCreateArgs(
  event: StructuredAuditEvent
): Prisma.AuditLogCreateArgs {
  return {
    data: buildStructuredAuditLogCreateData(event),
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

/**
 * Fire-and-forget structured audit logging for non-critical supplementary paths.
 */
export function logStructuredAudit(event: StructuredAuditEvent): void {
  void createStructuredAuditLog(event).catch((err) => {
    logger.error({ err }, "Failed to write structured audit log");
  });
}
