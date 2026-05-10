import type { AuditLog, Prisma } from "@prisma/client";

export const AUDIT_TIMELINE_CATEGORY_OPTIONS = [
  { value: "all", label: "All" },
  { value: "account", label: "Account" },
  { value: "booking", label: "Bookings" },
  { value: "payment", label: "Payments" },
  { value: "family", label: "Family" },
  { value: "admin", label: "Admin" },
  { value: "security", label: "Security" },
  { value: "lodge", label: "Lodge" },
  { value: "xero", label: "Xero" },
  { value: "communication", label: "Communication" },
  { value: "privacy", label: "Privacy" },
] as const;

export type AuditTimelineCategory =
  (typeof AUDIT_TIMELINE_CATEGORY_OPTIONS)[number]["value"];

export const MEMBER_VISIBLE_AUDIT_CATEGORIES = [
  "account",
  "booking",
  "payment",
  "family",
  "security",
  "communication",
  "privacy",
] as const;

export const MEMBER_AUDIT_TIMELINE_CATEGORY_OPTIONS =
  AUDIT_TIMELINE_CATEGORY_OPTIONS.filter(
    (option) =>
      option.value === "all" ||
      MEMBER_VISIBLE_AUDIT_CATEGORIES.includes(
        option.value as MemberVisibleAuditCategory
      )
  );

export type MemberVisibleAuditCategory =
  (typeof MEMBER_VISIBLE_AUDIT_CATEGORIES)[number];

const AUDIT_TIMELINE_CATEGORY_SET = new Set<string>(
  AUDIT_TIMELINE_CATEGORY_OPTIONS.map((option) => option.value)
);

const MEMBER_VISIBLE_AUDIT_CATEGORY_SET = new Set<string>([
  "all",
  ...MEMBER_VISIBLE_AUDIT_CATEGORIES,
]);

export function isAuditTimelineCategory(
  value: string
): value is AuditTimelineCategory {
  return AUDIT_TIMELINE_CATEGORY_SET.has(value);
}

export function isMemberVisibleAuditCategory(
  value: string
): value is MemberVisibleAuditCategory | "all" {
  return MEMBER_VISIBLE_AUDIT_CATEGORY_SET.has(value);
}

export function buildMemberAuditLogWhere(
  memberId: string
): Prisma.AuditLogWhereInput {
  return {
    OR: [
      { subjectMemberId: memberId },
      { AND: [{ subjectMemberId: null }, { actorMemberId: memberId }] },
      { AND: [{ subjectMemberId: null }, { memberId }] },
      { AND: [{ subjectMemberId: null }, { targetId: memberId }] },
    ],
  };
}

export function getAuditLogActorMemberId(
  log: Pick<AuditLog, "actorMemberId" | "memberId">
): string | null {
  return log.actorMemberId ?? log.memberId ?? null;
}

function actionStartsWith(prefix: string): Prisma.AuditLogWhereInput {
  return { action: { startsWith: prefix } };
}

function actionContains(value: string): Prisma.AuditLogWhereInput {
  return { action: { contains: value } };
}

const LEGACY_AUDIT_CATEGORY_ACTION_FILTERS: Record<
  Exclude<AuditTimelineCategory, "all">,
  Prisma.AuditLogWhereInput[]
> = {
  account: [
    actionStartsWith("member."),
    actionStartsWith("MEMBERSHIP_APPLICATION"),
    actionStartsWith("EMAIL_"),
  ],
  booking: [
    actionStartsWith("booking."),
    actionStartsWith("BOOKING_"),
    actionStartsWith("waitlist."),
  ],
  payment: [
    actionContains("payment"),
    actionContains("PAYMENT"),
    actionContains("refund"),
    actionContains("REFUND"),
    actionContains("credit"),
    actionContains("INVOICE"),
  ],
  family: [
    actionStartsWith("FAMILY_"),
    actionStartsWith("family-"),
    actionContains("dependent"),
    actionContains("DEPENDENT"),
  ],
  admin: [
    actionStartsWith("ADMIN_"),
    actionContains("policy"),
    actionContains("promo"),
    actionContains("season."),
  ],
  security: [
    actionContains("password"),
    actionContains("PASSWORD"),
    actionContains("login"),
    actionContains("LOGIN"),
    actionStartsWith("EMAIL_CHANGE"),
  ],
  lodge: [actionStartsWith("LODGE_"), actionContains("lodge")],
  xero: [
    actionStartsWith("XERO_"),
    actionStartsWith("xero_"),
    actionContains("XERO"),
  ],
  communication: [
    actionContains("COMMUNICATION"),
    actionContains("communication"),
    actionContains("email"),
  ],
  privacy: [
    actionContains("deletion"),
    actionContains("DELETION"),
    actionContains("data-export"),
    actionContains("DATA_EXPORT"),
  ],
};

function buildLegacyAuditCategoryWhere(
  category: Exclude<AuditTimelineCategory, "all">
): Prisma.AuditLogWhereInput | null {
  const filters = LEGACY_AUDIT_CATEGORY_ACTION_FILTERS[category];
  if (!filters.length) {
    return null;
  }

  return { OR: filters };
}

export function buildAuditCategoryWhere(
  category: AuditTimelineCategory
): Prisma.AuditLogWhereInput | null {
  if (category === "all") {
    return null;
  }

  const legacyWhere = buildLegacyAuditCategoryWhere(category);
  return {
    OR: [
      { category },
      ...(legacyWhere
        ? [{ AND: [{ category: null }, legacyWhere] }]
        : []),
    ],
  };
}

export function buildMemberVisibleAuditLogWhere(
  memberId: string
): Prisma.AuditLogWhereInput {
  const legacyVisibleFilters = MEMBER_VISIBLE_AUDIT_CATEGORIES.flatMap(
    (category) => {
      const where = buildLegacyAuditCategoryWhere(category);
      return where ? [where] : [];
    }
  );

  return {
    AND: [
      buildMemberAuditLogWhere(memberId),
      {
        OR: [
          { category: { in: [...MEMBER_VISIBLE_AUDIT_CATEGORIES] } },
          {
            AND: [
              { category: null },
              { OR: legacyVisibleFilters },
            ],
          },
        ],
      },
    ],
  };
}

export const auditTimelineSelect = {
  id: true,
  action: true,
  memberId: true,
  targetId: true,
  details: true,
  ipAddress: true,
  createdAt: true,
  actorMemberId: true,
  subjectMemberId: true,
  entityType: true,
  entityId: true,
  category: true,
  severity: true,
  outcome: true,
  summary: true,
  metadata: true,
  requestId: true,
  userAgent: true,
  retentionClass: true,
} satisfies Prisma.AuditLogSelect;

const auditActorSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  role: true,
} satisfies Prisma.MemberSelect;

type AuditTimelineLog = Prisma.AuditLogGetPayload<{
  select: typeof auditTimelineSelect;
}>;

type AuditTimelineActorRecord = Prisma.MemberGetPayload<{
  select: typeof auditActorSelect;
}>;

export type AuditTimelineActor = {
  id: string;
  firstName: string;
  lastName: string;
  email?: string;
  role?: string;
};

export type AuditTimelineEntry = {
  id: string;
  action: string;
  category: string;
  severity: string | null;
  outcome: string | null;
  summary: string;
  details: string | null;
  createdAt: string;
  actor: AuditTimelineActor | null;
  actorDisplayName: string;
  entityType: string | null;
  entityId: string | null;
  metadata: Prisma.JsonValue | null;
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  retentionClass?: string | null;
};

export type AuditTimelineResponse = {
  data: AuditTimelineEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  category: AuditTimelineCategory;
  categories: ReadonlyArray<{ value: string; label: string }>;
};

type AuditTimelineClient = {
  auditLog: {
    findMany(args: Prisma.AuditLogFindManyArgs): Promise<AuditTimelineLog[]>;
    count(args: Prisma.AuditLogCountArgs): Promise<number>;
  };
  member: {
    findMany(args: Prisma.MemberFindManyArgs): Promise<AuditTimelineActorRecord[]>;
  };
};

function parseJsonObject(value: string | null): Prisma.JsonObject | null {
  if (!value?.trim().startsWith("{")) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Prisma.JsonObject;
    }
  } catch {
    return null;
  }

  return null;
}

function titleCaseAction(action: string): string {
  return action
    .replace(/[._-]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((word) => {
      const lower = word.toLowerCase();
      return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
    })
    .join(" ");
}

export function inferAuditCategoryFromAction(action: string): string {
  const normalized = action.toLowerCase();

  if (normalized.includes("deletion") || normalized.includes("data-export")) {
    return "privacy";
  }
  if (
    normalized.startsWith("family") ||
    normalized.includes("dependent")
  ) {
    return "family";
  }
  if (normalized.startsWith("booking.") || normalized.startsWith("waitlist.")) {
    return "booking";
  }
  if (
    normalized.includes("payment") ||
    normalized.includes("refund") ||
    normalized.includes("credit") ||
    normalized.includes("invoice")
  ) {
    return "payment";
  }
  if (normalized.startsWith("xero") || normalized.includes("_xero")) {
    return "xero";
  }
  if (
    normalized.includes("password") ||
    normalized.includes("login") ||
    normalized.startsWith("email_change") ||
    normalized.startsWith("email_")
  ) {
    return "security";
  }
  if (
    normalized.startsWith("member.") ||
    normalized.startsWith("membership_application")
  ) {
    return "account";
  }
  if (normalized.includes("communication") || normalized.includes("email")) {
    return "communication";
  }
  if (normalized.includes("lodge")) {
    return "lodge";
  }
  if (
    normalized.startsWith("admin") ||
    normalized.includes("policy") ||
    normalized.includes("promo") ||
    normalized.includes("season.")
  ) {
    return "admin";
  }

  return "system";
}

function getActorName(actor: AuditTimelineActorRecord | undefined): string {
  if (!actor) {
    return "Unknown member";
  }

  const fullName = `${actor.firstName} ${actor.lastName}`.trim();
  return fullName || actor.email || "Unknown member";
}

function getSummary(log: AuditTimelineLog): string {
  if (log.summary) {
    return log.summary;
  }

  const parsedDetails = parseJsonObject(log.details);
  if (
    (log.action === "member.setup-invite-sent" ||
      log.action === "member.password-reset-sent") &&
    typeof parsedDetails?.recipientEmail === "string"
  ) {
    return log.action === "member.setup-invite-sent"
      ? `Setup invite sent to ${parsedDetails.recipientEmail}`
      : `Password reset sent to ${parsedDetails.recipientEmail}`;
  }

  return titleCaseAction(log.action);
}

function serializeActorForAudience(params: {
  actorMemberId: string | null;
  actor: AuditTimelineActorRecord | undefined;
  audience: "admin" | "member";
  currentMemberId?: string;
}): { actor: AuditTimelineActor | null; actorDisplayName: string } {
  const { actorMemberId, actor, audience, currentMemberId } = params;

  if (!actorMemberId) {
    return { actor: null, actorDisplayName: "System" };
  }

  if (audience === "member") {
    if (actorMemberId === currentMemberId) {
      return {
        actor: actor
          ? {
              id: actor.id,
              firstName: actor.firstName,
              lastName: actor.lastName,
              role: actor.role,
            }
          : null,
        actorDisplayName: "You",
      };
    }

    if (actor?.role === "ADMIN") {
      return { actor: null, actorDisplayName: "Club admin" };
    }

    return {
      actor: actor
        ? {
            id: actor.id,
            firstName: actor.firstName,
            lastName: actor.lastName,
            role: actor.role,
          }
        : null,
      actorDisplayName: actor ? getActorName(actor) : "Another member",
    };
  }

  return {
    actor: actor
      ? {
          id: actor.id,
          firstName: actor.firstName,
          lastName: actor.lastName,
          email: actor.email,
          role: actor.role,
        }
      : null,
    actorDisplayName: actor ? getActorName(actor) : "Unknown member",
  };
}

function serializeAuditTimelineLog(params: {
  log: AuditTimelineLog;
  actorById: Map<string, AuditTimelineActorRecord>;
  audience: "admin" | "member";
  currentMemberId?: string;
}): AuditTimelineEntry {
  const { log, actorById, audience, currentMemberId } = params;
  const actorMemberId = getAuditLogActorMemberId(log);
  const actorResult = serializeActorForAudience({
    actorMemberId,
    actor: actorMemberId ? actorById.get(actorMemberId) : undefined,
    audience,
    currentMemberId,
  });
  const legacyMetadata = parseJsonObject(log.details);
  const hasLegacyMetadata = Boolean(legacyMetadata);

  return {
    id: log.id,
    action: log.action,
    category: log.category ?? inferAuditCategoryFromAction(log.action),
    severity: log.severity,
    outcome: log.outcome,
    summary: getSummary(log),
    details: hasLegacyMetadata ? null : log.details,
    createdAt:
      log.createdAt instanceof Date
        ? log.createdAt.toISOString()
        : new Date(log.createdAt).toISOString(),
    actor: actorResult.actor,
    actorDisplayName: actorResult.actorDisplayName,
    entityType: log.entityType,
    entityId: log.entityId,
    metadata:
      audience === "admin"
        ? log.metadata ?? legacyMetadata
        : null,
    requestId: audience === "admin" ? log.requestId : undefined,
    ipAddress: audience === "admin" ? log.ipAddress : undefined,
    userAgent: audience === "admin" ? log.userAgent : undefined,
    retentionClass: audience === "admin" ? log.retentionClass : undefined,
  };
}

export async function getAuditTimelinePage(params: {
  db: AuditTimelineClient;
  where: Prisma.AuditLogWhereInput;
  page: number;
  pageSize: number;
  category: AuditTimelineCategory;
  audience: "admin" | "member";
  currentMemberId?: string;
}): Promise<AuditTimelineResponse> {
  const { db, where, page, pageSize, category, audience, currentMemberId } =
    params;
  const [logs, total] = await Promise.all([
    db.auditLog.findMany({
      where,
      select: auditTimelineSelect,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.auditLog.count({ where }),
  ]);

  const actorIds = Array.from(
    new Set(
      logs
        .map((log) => getAuditLogActorMemberId(log))
        .filter((memberId): memberId is string => Boolean(memberId))
    )
  );
  const actors =
    actorIds.length > 0
      ? await db.member.findMany({
          where: { id: { in: actorIds } },
          select: auditActorSelect,
        })
      : [];
  const actorById = new Map(actors.map((actor) => [actor.id, actor]));

  return {
    data: logs.map((log) =>
      serializeAuditTimelineLog({
        log,
        actorById,
        audience,
        currentMemberId,
      })
    ),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    category,
    categories: AUDIT_TIMELINE_CATEGORY_OPTIONS,
  };
}
