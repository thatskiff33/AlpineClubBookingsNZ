import type { AuditLog, Prisma } from "@prisma/client";

import {
  AUDIT_CATEGORIES,
  AUDIT_CATEGORY_LABELS,
  type AuditCategory,
} from "./audit-categories";
import { formatCents } from "./utils";

/**
 * The Admin Audit Log's category filter, DERIVED from the canonical taxonomy
 * (#2581) rather than hand-listed beside it. The two lists had already drifted
 * once — `family` was in this one and missing from the writer union — and a
 * category the filter does not offer is a category an operator cannot search
 * for, however many rows carry it.
 */
export const AUDIT_TIMELINE_CATEGORY_OPTIONS: readonly {
  value: AuditTimelineCategory;
  label: string;
}[] = [
  { value: "all", label: "All" },
  ...AUDIT_CATEGORIES.map((category) => ({
    value: category,
    label: AUDIT_CATEGORY_LABELS[category],
  })),
];

export type AuditTimelineCategory = "all" | AuditCategory;

/**
 * The categories a MEMBER may see in their own timeline.
 *
 * Deliberately a separate reviewed list rather than a filter over the canonical
 * taxonomy (#2581): membership of the platform's taxonomy must never publish a
 * category to members as a side effect of adding it. `satisfies` keeps every
 * entry a real canonical value while leaving the subset a decision — a new
 * category is invisible to members until someone adds it here on purpose.
 */
const MEMBER_VISIBLE_AUDIT_CATEGORIES = [
  "account",
  "booking",
  "payment",
  "family",
  "security",
  "communication",
  "privacy",
] as const satisfies readonly AuditCategory[];

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

export type AuditMemberScope = "involves" | "actor" | "subject";

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

export function buildAuditMemberScopeWhere(
  memberId: string,
  scope: AuditMemberScope = "involves"
): Prisma.AuditLogWhereInput {
  const actorWhere: Prisma.AuditLogWhereInput = {
    OR: [{ actorMemberId: memberId }, { memberId }],
  };
  const subjectWhere: Prisma.AuditLogWhereInput = {
    OR: [
      { subjectMemberId: memberId },
      { AND: [{ subjectMemberId: null }, { entityType: "Member" }, { entityId: memberId }] },
      { AND: [{ subjectMemberId: null }, { targetId: memberId }] },
    ],
  };

  if (scope === "actor") {
    return actorWhere;
  }
  if (scope === "subject") {
    return subjectWhere;
  }

  return { OR: [actorWhere, subjectWhere] };
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

function getAuditLogSubjectMemberId(
  log: Pick<
    AuditLog,
    "action" | "subjectMemberId" | "entityType" | "entityId" | "targetId"
  >
): string | null {
  if (log.subjectMemberId) {
    return log.subjectMemberId;
  }
  if (log.entityType === "Member" && log.entityId) {
    return log.entityId;
  }

  const normalized = log.action.toLowerCase();
  if (
    log.targetId &&
    (normalized.startsWith("member.") ||
      normalized.startsWith("admin.member.") ||
      normalized.startsWith("membership_application") ||
      normalized.includes("notification_preferences") ||
      normalized.includes("deletion_"))
  ) {
    return log.targetId;
  }

  return null;
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
    actionStartsWith("membership_cancellation."),
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
    actionStartsWith("member_lifecycle.delete"),
    actionContains("deletion"),
    actionContains("DELETION"),
    actionContains("data-export"),
    actionContains("DATA_EXPORT"),
  ],
  system: [],
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

const auditTimelineSelect = {
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

type AuditTimelineMember = {
  id: string;
  firstName: string;
  lastName: string;
  email?: string;
  role?: string;
};

type AuditTimelineActor = AuditTimelineMember;

export type AuditDrilldownLink = {
  label: string;
  href: string;
  kind: "member" | "booking" | "payment" | "xero" | "admin" | "external";
  primary?: boolean;
};

export type AuditTimelineEntry = {
  id: string;
  action: string;
  category: string;
  severity: string | null;
  outcome: string | null;
  summary: string;
  description: string | null;
  details: string | null;
  createdAt: string;
  actor: AuditTimelineActor | null;
  actorDisplayName: string;
  subject: AuditTimelineMember | null;
  subjectDisplayName: string | null;
  subjectMemberId: string | null;
  entityType: string | null;
  entityId: string | null;
  drilldowns: AuditDrilldownLink[];
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

function humanizeKey(key: string): string {
  return titleCaseAction(
    key
      .replace(/Cents$/i, "")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  );
}

function jsonObjectValue(
  metadata: Prisma.JsonValue | Prisma.JsonObject | null | undefined,
  keys: string[]
): Prisma.JsonValue | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(metadata, key)) {
      return metadata[key];
    }
  }

  return undefined;
}

function stringMetadataValue(
  metadata: Prisma.JsonValue | Prisma.JsonObject | null | undefined,
  keys: string[]
): string | null {
  const value = jsonObjectValue(metadata, keys);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// test seam (#3302): this used to be its own hard-coded "$" + toFixed(2)
// formatter with no fixture; exported so the switch to the shared,
// currency-aware `formatCents` is asserted rather than merely claimed.
export function formatMetadataFragment(key: string, value: Prisma.JsonValue): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value === "number" && /cents$/i.test(key)) {
    return `${humanizeKey(key)} ${formatCents(value)}`;
  }
  if (typeof value === "boolean") {
    return `${humanizeKey(key)} ${value ? "yes" : "no"}`;
  }
  if (typeof value === "string") {
    if (!value.trim()) {
      return null;
    }
    return `${humanizeKey(key)} ${value}`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return null;
    }
    const preview = value
      .slice(0, 4)
      .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
      .join(", ");
    return `${humanizeKey(key)} ${preview}${value.length > 4 ? ", ..." : ""}`;
  }

  return null;
}

function formatMetadataDescription(
  metadata: Prisma.JsonValue | Prisma.JsonObject | null
): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }

  const priorityKeys = [
    "changedFields",
    "fieldNames",
    "amountCents",
    "approvedAmountCents",
    "requestedAmountCents",
    "priceDiffCents",
    "refundAmountCents",
    "changeFeeCents",
    "bookingId",
    "paymentId",
    "paymentIntentId",
    "xeroContactId",
    "xeroInvoiceId",
    "recipientFilter",
    "eligibleRecipients",
    "totalRecipients",
    "requestId",
  ];

  const fragments: string[] = [];
  for (const key of priorityKeys) {
    const value = jsonObjectValue(metadata, [key]);
    if (value === undefined) {
      continue;
    }
    const fragment = formatMetadataFragment(key, value);
    if (fragment) {
      fragments.push(fragment);
    }
    if (fragments.length >= 4) {
      break;
    }
  }

  if (fragments.length > 0) {
    return fragments.join(" · ");
  }

  return Object.entries(metadata)
    .slice(0, 4)
    .map(([key, value]) =>
      value === undefined ? null : formatMetadataFragment(key, value)
    )
    .filter((value): value is string => Boolean(value))
    .join(" · ") || null;
}

// test seam
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
    normalized.startsWith("membership_cancellation.") ||
    normalized.startsWith("membership_application")
  ) {
    return "account";
  }
  if (normalized.startsWith("member_lifecycle.delete")) {
    return "privacy";
  }
  if (normalized.startsWith("member_lifecycle.")) {
    return "admin";
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

function getDescription(
  log: AuditTimelineLog,
  metadata: Prisma.JsonValue | Prisma.JsonObject | null
): string | null {
  const legacyMetadata = parseJsonObject(log.details);
  if (log.details && !legacyMetadata) {
    return log.details;
  }

  return formatMetadataDescription(metadata);
}

function addDrilldownLink(
  links: AuditDrilldownLink[],
  next: AuditDrilldownLink | null
) {
  if (!next || links.some((link) => link.href === next.href)) {
    return;
  }
  links.push(next);
}

function entityDrilldownLink(
  entityType: string | null,
  entityId: string | null
): AuditDrilldownLink | null {
  if (!entityType || !entityId) {
    return null;
  }

  switch (entityType) {
    case "Member":
      return {
        label: "Open member",
        href: `/admin/members/${encodeURIComponent(entityId)}`,
        kind: "member",
        primary: true,
      };
    case "Booking":
      return {
        label: "Open booking",
        href: `/bookings/${encodeURIComponent(entityId)}`,
        kind: "booking",
        primary: true,
      };
    case "Payment":
    case "BookingModification":
    case "MemberSubscription":
      return {
        label: `${titleCaseAction(entityType)} activity`,
        href: `/admin/xero/records/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`,
        kind: entityType === "Payment" ? "payment" : "xero",
        primary: true,
      };
    case "RefundRequest":
      return {
        label: "Open refunds",
        href: "/admin/refund-requests",
        kind: "admin",
        primary: true,
      };
    case "DeletionRequest":
      return {
        label: "Open deletion requests",
        href: "/admin/deletion-requests",
        kind: "admin",
        primary: true,
      };
    case "MembershipCancellationRequest":
      return {
        label: "Open cancellations",
        href: "/admin/membership-cancellations",
        kind: "admin",
        primary: true,
      };
    case "MemberLifecycleActionRequest":
      return {
        label: "Open lifecycle audit",
        href: `/admin/audit-log?entityType=MemberLifecycleActionRequest&q=${encodeURIComponent(entityId)}`,
        kind: "admin",
        primary: true,
      };
    case "FamilyGroup":
      return {
        label: "Open family groups",
        href: "/admin/family-groups",
        kind: "admin",
        primary: true,
      };
    case "Communication":
      return {
        label: "Open communications",
        href: "/admin/communications",
        kind: "admin",
        primary: true,
      };
    default:
      return null;
  }
}

function actionFallbackDrilldownLink(
  action: string,
  targetId: string | null
): AuditDrilldownLink | null {
  const normalized = action.toLowerCase();

  if (targetId) {
    if (normalized.startsWith("booking.") || normalized.startsWith("waitlist.")) {
      return {
        label: "Open booking",
        href: `/bookings/${encodeURIComponent(targetId)}`,
        kind: "booking",
        primary: true,
      };
    }
    if (
      normalized.startsWith("member.") ||
      normalized.startsWith("admin.member.") ||
      normalized.startsWith("membership_application") ||
      normalized === "xero_link" ||
      normalized === "xero_unlink" ||
      normalized === "xero_push"
    ) {
      return {
        label: "Open member",
        href: `/admin/members/${encodeURIComponent(targetId)}`,
        kind: "member",
        primary: true,
      };
    }
  }

  if (normalized.includes("refund")) {
    return {
      label: "Open refunds",
      href: "/admin/refund-requests",
      kind: "admin",
      primary: true,
    };
  }
  if (normalized.includes("deletion")) {
    return {
      label: "Open deletion requests",
      href: "/admin/deletion-requests",
      kind: "admin",
      primary: true,
    };
  }
  if (normalized.startsWith("membership_cancellation.")) {
    return {
      label: "Open cancellations",
      href: "/admin/membership-cancellations",
      kind: "admin",
      primary: true,
    };
  }
  if (normalized.includes("communication") || normalized.includes("email")) {
    return {
      label: "Open communications",
      href: "/admin/communications",
      kind: "admin",
      primary: true,
    };
  }
  if (normalized.includes("xero")) {
    return {
      label: "Open Xero",
      href: "/admin/xero",
      kind: "xero",
      primary: true,
    };
  }
  if (normalized.includes("policy")) {
    return {
      label: "Open booking policies",
      href: "/admin/booking-policies",
      kind: "admin",
      primary: true,
    };
  }
  if (normalized.includes("promo")) {
    return {
      label: "Open promo codes",
      href: "/admin/promo-codes",
      kind: "admin",
      primary: true,
    };
  }
  if (normalized.includes("season")) {
    return {
      label: "Open seasons",
      href: "/admin/seasons",
      kind: "admin",
      primary: true,
    };
  }
  if (normalized.includes("chore")) {
    return {
      label: "Open chores",
      href: "/admin/chores",
      kind: "admin",
      primary: true,
    };
  }
  if (normalized.includes("hut-leader")) {
    return {
      label: "Open hut leaders",
      href: "/admin/hut-leaders",
      kind: "admin",
      primary: true,
    };
  }
  if (normalized.includes("lodge")) {
    return {
      label: "Open lodge",
      href: "/admin/lodge",
      kind: "admin",
      primary: true,
    };
  }

  return null;
}

// test seam
export function buildAuditDrilldownLinks(params: {
  action: string;
  targetId: string | null;
  subjectMemberId: string | null;
  entityType: string | null;
  entityId: string | null;
  metadata: Prisma.JsonValue | Prisma.JsonObject | null;
}): AuditDrilldownLink[] {
  const links: AuditDrilldownLink[] = [];

  if (params.subjectMemberId) {
    addDrilldownLink(links, {
      label: "Open member",
      href: `/admin/members/${encodeURIComponent(params.subjectMemberId)}`,
      kind: "member",
      primary: true,
    });
  }

  addDrilldownLink(
    links,
    entityDrilldownLink(params.entityType, params.entityId)
  );

  const bookingId = stringMetadataValue(params.metadata, [
    "bookingId",
    "bookingID",
  ]);
  if (bookingId) {
    addDrilldownLink(links, {
      label: "Open booking",
      href: `/bookings/${encodeURIComponent(bookingId)}`,
      kind: "booking",
      primary: links.length === 0,
    });
  }

  const paymentId = stringMetadataValue(params.metadata, ["paymentId"]);
  if (paymentId) {
    addDrilldownLink(links, {
      label: "Payment activity",
      href: `/admin/xero/records/Payment/${encodeURIComponent(paymentId)}`,
      kind: "payment",
      primary: links.length === 0,
    });
  }

  addDrilldownLink(
    links,
    actionFallbackDrilldownLink(params.action, params.targetId)
  );

  if (links.length > 1 && !links.some((link) => link.primary)) {
    links[0].primary = true;
  }

  return links;
}

/**
 * Prefix for synthetic (non-member) audit actor ids written by system
 * processes — e.g. the boot-time config bootstrap importer writes
 * `system:config-bootstrap` (`SYSTEM_AUDIT_ACTOR_PREFIX` in
 * `src/lib/config-transfer/bootstrap-import.ts`). Kept as a local constant so
 * the display layer does not import the server-only bootstrap module.
 */
const SYSTEM_ACTOR_ID_PREFIX = "system:";

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

  // Synthetic `system:` actors are not Member rows; render them as "System"
  // for every audience instead of "Unknown member".
  if (actorMemberId.startsWith(SYSTEM_ACTOR_ID_PREFIX)) {
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

function serializeSubjectForAudience(params: {
  subjectMemberId: string | null;
  subject: AuditTimelineActorRecord | undefined;
  audience: "admin" | "member";
  currentMemberId?: string;
}): { subject: AuditTimelineMember | null; subjectDisplayName: string | null } {
  const { subjectMemberId, subject, audience, currentMemberId } = params;

  if (!subjectMemberId) {
    return { subject: null, subjectDisplayName: null };
  }

  if (audience === "member") {
    if (subjectMemberId === currentMemberId) {
      return {
        subject: subject
          ? {
              id: subject.id,
              firstName: subject.firstName,
              lastName: subject.lastName,
              role: subject.role,
            }
          : null,
        subjectDisplayName: "You",
      };
    }

    return {
      subject: subject
        ? {
            id: subject.id,
            firstName: subject.firstName,
            lastName: subject.lastName,
            role: subject.role,
          }
        : null,
      subjectDisplayName: subject ? getActorName(subject) : "Another member",
    };
  }

  return {
    subject: subject
      ? {
          id: subject.id,
          firstName: subject.firstName,
          lastName: subject.lastName,
          email: subject.email,
          role: subject.role,
        }
      : null,
    subjectDisplayName: subject ? getActorName(subject) : "Unknown member",
  };
}

function serializeAuditTimelineLog(params: {
  log: AuditTimelineLog;
  memberById: Map<string, AuditTimelineActorRecord>;
  audience: "admin" | "member";
  currentMemberId?: string;
}): AuditTimelineEntry {
  const { log, memberById, audience, currentMemberId } = params;
  const actorMemberId = getAuditLogActorMemberId(log);
  const subjectMemberId = getAuditLogSubjectMemberId(log);
  const actorResult = serializeActorForAudience({
    actorMemberId,
    actor: actorMemberId ? memberById.get(actorMemberId) : undefined,
    audience,
    currentMemberId,
  });
  const subjectResult = serializeSubjectForAudience({
    subjectMemberId,
    subject: subjectMemberId ? memberById.get(subjectMemberId) : undefined,
    audience,
    currentMemberId,
  });
  const legacyMetadata = parseJsonObject(log.details);
  const hasLegacyMetadata = Boolean(legacyMetadata);
  const metadata =
    audience === "admin"
      ? log.metadata ?? legacyMetadata
      : null;
  const description =
    audience === "admin"
      ? getDescription(log, metadata)
      : hasLegacyMetadata
        ? null
        : log.details;

  return {
    id: log.id,
    action: log.action,
    category: log.category ?? inferAuditCategoryFromAction(log.action),
    severity: log.severity,
    outcome: log.outcome,
    summary: getSummary(log),
    description,
    details: hasLegacyMetadata ? null : log.details,
    createdAt:
      log.createdAt instanceof Date
        ? log.createdAt.toISOString()
        : new Date(log.createdAt).toISOString(),
    actor: actorResult.actor,
    actorDisplayName: actorResult.actorDisplayName,
    subject: subjectResult.subject,
    subjectDisplayName: subjectResult.subjectDisplayName,
    subjectMemberId,
    entityType: log.entityType,
    entityId: log.entityId,
    drilldowns:
      audience === "admin"
        ? buildAuditDrilldownLinks({
            action: log.action,
            targetId: log.targetId,
            subjectMemberId,
            entityType: log.entityType,
            entityId: log.entityId,
            metadata,
          })
        : [],
    metadata,
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

  const memberIds = Array.from(
    new Set(
      logs
        .flatMap((log) => [
          getAuditLogActorMemberId(log),
          getAuditLogSubjectMemberId(log),
        ])
        .filter((memberId): memberId is string => Boolean(memberId))
    )
  );
  const members =
    memberIds.length > 0
      ? await db.member.findMany({
          where: { id: { in: memberIds } },
          select: auditActorSelect,
        })
      : [];
  const memberById = new Map(members.map((member) => [member.id, member]));

  return {
    data: logs.map((log) =>
      serializeAuditTimelineLog({
        log,
        memberById,
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
