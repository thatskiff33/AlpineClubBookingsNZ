import type { Lodge, Prisma, PrismaClient } from "@prisma/client";

// Callers pass their own Prisma client/transaction so this module stays free
// of the app prisma singleton and safe to import from prisma/seed.ts.
type LodgeDb = Pick<PrismaClient, "lodge">;

// Lodge management helpers. Multi-lodge is core (ADR-005): the Lodge table is
// always present and every deployment has at least one row; these helpers
// manage lodge identity only. Capacity, pricing, and booking scoping live
// elsewhere.

export const lodgeSelect = {
  id: true,
  name: true,
  slug: true,
  active: true,
  address: true,
  doorCode: true,
  travelNote: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.LodgeSelect;

export type LodgeRecord = Pick<Lodge, keyof typeof lodgeSelect>;

/**
 * The lodge VOCABULARY (#2925): the four fields an admin surface needs to say
 * WHICH lodge it is talking about, and nothing else.
 *
 * `GET /api/admin/lodges` serves this to a caller who is an admitted admin but
 * holds no `lodge:view`. Built from nothing rather than trimmed from
 * `lodgeSelect`, so a column added to `Lodge` later is excluded by default
 * instead of joining the response silently:
 *
 * - `id` — the value every lodge-scoped request sends back.
 * - `name` — the label in every selector, badge and heading.
 * - `slug` — the URL identifier. Derived from `name` by `slugifyLodgeName`, so
 *   it discloses nothing the name does not already disclose.
 * - `active` — load-bearing, not decorative: `useLodgeOptions` and the four
 *   lobby-display consumers filter on `active !== false`, so omitting it would
 *   offer a deactivated lodge as a bookable option.
 *
 * Deliberately EXCLUDED, and each for its own reason:
 *
 * - `doorCode` — a physical-access secret. `redactLodgeForAudit` already keeps
 *   it out of audit metadata; this keeps it out of the response for every role
 *   the access relaxation admits.
 * - `address` — the lodge's physical location, admin-editable operational data.
 * - `travelNote` — arrival instructions. Its only vocabulary consumer is the
 *   MEMBER booking wizard, which reads `/api/lodges`, not this route.
 * - `createdAt` / `updatedAt` — record metadata no vocabulary consumer reads.
 * - `displayConfig`, `displayNotice`, `displayNameGranularity`,
 *   `showGuestPhonesOnScreens`, `isDefault` — never in either payload; listed
 *   so the enumeration is complete rather than partial.
 */
export const lodgeIdentitySelect = {
  id: true,
  name: true,
  slug: true,
  active: true,
} satisfies Prisma.LodgeSelect;

export type LodgeIdentityRecord = Pick<
  Lodge,
  keyof typeof lodgeIdentitySelect
>;

export interface SerializedLodgeIdentity {
  id: string;
  name: string;
  slug: string;
  active: boolean;
}

export interface SerializedLodge {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  address: string | null;
  doorCode: string | null;
  travelNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export function serializeLodge(lodge: LodgeRecord): SerializedLodge {
  return {
    id: lodge.id,
    name: lodge.name,
    slug: lodge.slug,
    active: lodge.active,
    address: lodge.address,
    doorCode: lodge.doorCode,
    travelNote: lodge.travelNote,
    createdAt: lodge.createdAt.toISOString(),
    updatedAt: lodge.updatedAt.toISOString(),
  };
}

/**
 * Serialize the vocabulary payload (#2925).
 *
 * Names its four fields explicitly rather than spreading, so it is a second,
 * independent barrier: even if a caller hands it a row read with the full
 * `lodgeSelect`, no excluded field can reach the response. `lodgeIdentitySelect`
 * stops the secret leaving the database; this stops it leaving the process.
 */
export function serializeLodgeIdentity(
  lodge: LodgeIdentityRecord,
): SerializedLodgeIdentity {
  return {
    id: lodge.id,
    name: lodge.name,
    slug: lodge.slug,
    active: lodge.active,
  };
}

// Audit-log shape: the door code is a physical-access secret and must never be
// stored in audit metadata — record only whether one is set (same convention
// as the retired email-settings redactor).
export function redactLodgeForAudit(
  lodge: SerializedLodge,
): Omit<SerializedLodge, "doorCode"> & { doorCode: "[set]" | null } {
  return {
    ...lodge,
    doorCode: lodge.doorCode ? "[set]" : null,
  };
}

export function lodgeOrderBy() {
  return [{ createdAt: "asc" }, { id: "asc" }] satisfies
    Prisma.LodgeOrderByWithRelationInput[];
}

export function normalizeLodgeText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function slugifyLodgeName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "lodge";
}

export async function buildUniqueLodgeSlug(
  db: LodgeDb,
  name: string,
  excludeLodgeId?: string,
): Promise<string> {
  const base = slugifyLodgeName(name);
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}-${suffix + 1}`;
    const clash = await db.lodge.findFirst({
      where: {
        slug: candidate,
        ...(excludeLodgeId ? { id: { not: excludeLodgeId } } : {}),
      },
      select: { id: true },
    });
    if (!clash) return candidate;
  }
  throw new Error(`Could not derive a unique lodge slug from "${name}"`);
}

export async function countActiveLodges(db: LodgeDb): Promise<number> {
  return db.lodge.count({ where: { active: true } });
}

/**
 * INV-CAP-039: the lodge fields a booking LIST row selects so it can name its
 * lodge. Spread into each list query's `select` (`lodge: BOOKING_LIST_LODGE_SELECT`)
 * so every list asks the same question of the same row.
 */
export const BOOKING_LIST_LODGE_SELECT = {
  select: { name: true, active: true },
} as const satisfies Prisma.LodgeDefaultArgs;

/**
 * INV-CAP-039: the lodge name a booking LIST row shows, or null for none — the
 * one place the ADR-002 single-lodge presentation rule is decided for member
 * booking lists (My Bookings and the dashboard's rows).
 *
 * Exactly one active lodge hides the name, so a single-lodge club's lists look
 * as they always have. Any other count shows it, and 0 is deliberately on that
 * side: a count that says "no lodges" is not evidence the club has one. A row at
 * a lodge that is no longer active is always named whatever the count, so a club
 * that archived its second lodge never shows a booking still there unlabelled.
 *
 * The name is always the BOOKING's own lodge, never the club default (#2918,
 * #2919). The screens that ask a member to review or pay for one booking (the
 * booking page, the pay link) name it unconditionally and do not ask this.
 */
export function bookingListLodgeLabel(
  activeLodgeCount: number,
  lodge: { name: string; active: boolean },
): string | null {
  return activeLodgeCount !== 1 || !lodge.active ? lodge.name : null;
}

// Prisma where-fragment scoping a query to exactly one lodge. Named for the
// historical expand-release null tolerance; the entity tables it is used on now
// have a NOT NULL lodgeId, so it is a strict match (see below).
export function lodgeNullTolerantScope(lodgeId: string) {
  // The entity tables this scopes (Booking, Season, LodgeRoom, Locker,
  // ChoreTemplate, HutLeaderAssignment) are NOT NULL on lodgeId, so a strict
  // per-lodge match is exact — there are no null-lodge rows to tolerate. (Policy
  // tables keep nullable lodgeId and scope via resolvePolicyRowsForLodge, not
  // this helper.)
  return { lodgeId };
}

// Resolve the club-wide-with-override policy pattern (ADR-001 resolved
// question 3) for one lodge: rows with a matching lodgeId are that lodge's
// override set and REPLACE the club-wide (null lodgeId) rows entirely — never
// merged. Rows belonging to other lodges are always excluded. All three
// policy types (CancellationPolicy, MinimumStayPolicy, BookingPeriod) must
// resolve through this helper so the replace-not-merge rule cannot drift
// (docs/multi-lodge/lodge-scoping-contract.md).
export function resolvePolicyRowsForLodge<
  T extends { lodgeId?: string | null },
>(rows: readonly T[], lodgeId: string): T[] {
  const lodgeRows = rows.filter((row) => row.lodgeId === lodgeId);
  if (lodgeRows.length > 0) return lodgeRows;
  // Loose null check: rows from narrow selects (or fixtures) may omit the
  // column entirely; a missing lodgeId means club-wide, same as null.
  return rows.filter((row) => row.lodgeId == null);
}

// Phase-2 bridging resolver: writers that do not yet receive an explicit
// lodge from their caller stamp new rows with the club's default lodge (the
// oldest active one — the phase-1 seeded lodge in every current deployment).
// Phases 3+ replace call sites with real lodge context threaded from the
// request; do not add new callers once a surface carries its own lodgeId.
//
// Durable default-lodge resolution (#1656 / #1627 option b): the club default
// is the lodge flagged Lodge.isDefault, not the earliest-createdAt row. The old
// createdAt ordering silently inverted on non-UTC databases (a lodge created in
// the seed's TZ-skew window sorted before the seeded lodge and became the
// default); the isDefault flag removes that class entirely. The old ordering
// survives only as a fallback for the pathological case of no flagged row.
//
// MIRROR CONTRACT: this resolution (flagged isDefault first, else oldest active
// lodge, else oldest lodge of any state) must stay byte-identical to the
// default_lodge_id() SQL function replaced in migration 20260709120000 — that
// function backs the column DEFAULT that keeps the entity tables' lodgeId NOT
// NULLs old-code-compatible during a blue/green cutover. Any change to the
// order/fallback here must be mirrored by a new migration that replaces the SQL
// function (and vice versa), or a cutover could stamp different lodges from the
// two code paths. The default lodge should be reassigned before it is
// deactivated: while an inactive lodge stays flagged it deliberately remains the
// default (both sides agree), rather than silently falling through to createdAt.
// A third copy of this resolution lives in email-message-settings.ts
// resolveLodgeIdentity (it needs identity fields and never-throw semantics, so
// it cannot call this helper); it shares lodgeOrderBy() and must be updated in
// the same change as this function and the SQL function.
export async function getDefaultLodgeId(db: LodgeDb): Promise<string> {
  const lodge =
    (await db.lodge.findFirst({
      where: { isDefault: true },
      select: { id: true },
    })) ??
    (await db.lodge.findFirst({
      where: { active: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    })) ??
    (await db.lodge.findFirst({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    }));

  if (!lodge) {
    throw new Error(
      "No Lodge row exists; run migrations/seed before creating lodge-scoped records",
    );
  }
  return lodge.id;
}

// Resolve an admin-supplied optional lodgeId: a provided id must name an
// active lodge (returns null when it does not, so callers can 400), and an
// omitted id falls back to the club's default lodge. One helper so the
// admin create/update routes cannot drift on how they validate lodge input.
export async function resolveOptionalActiveLodgeId(
  db: LodgeDb,
  requestedLodgeId: string | null | undefined,
): Promise<string | null> {
  if (requestedLodgeId) {
    const lodge = await db.lodge.findUnique({
      where: { id: requestedLodgeId },
      select: { id: true, active: true },
    });
    return lodge?.active ? lodge.id : null;
  }
  return getDefaultLodgeId(db);
}
