import { createHash } from "node:crypto";
import { Prisma, type BedAllocationSource } from "@prisma/client";
import { bookingOwner } from "@/lib/booking-owner";
import { createAuditLog } from "@/lib/audit";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import {
  countNightsDateOnly,
  formatDateOnly,
  isDateOnlyString,
  parseDateOnly,
} from "@/lib/date-only";
import { prisma } from "@/lib/prisma";

export const BED_ALLOCATION_REMOVAL_DIGEST_VERSION = "v1" as const;
export const MAX_BED_ALLOCATION_REMOVAL_WINDOW_NIGHTS = 31;
const MAX_AUDIT_IDENTITIES = 50;
export const BED_ALLOCATION_REMOVAL_QUERY_CHUNK_SIZE = 10_000;

export const BED_ALLOCATION_REMOVAL_CATEGORIES = [
  "AUTO_DRAFT",
  "MANUAL_DRAFT",
  "APPROVED",
] as const;

export type BedAllocationRemovalCategory =
  (typeof BED_ALLOCATION_REMOVAL_CATEGORIES)[number];

export interface BedAllocationRemovalAnchor {
  allocationId: string;
  bookingId: string;
  bookingGuestId: string;
  lodgeId: string;
  stayDate: string;
}

export type BedAllocationRemovalScope =
  | ({ type: "ALLOCATION" } & BedAllocationRemovalAnchor)
  | ({ type: "BOOKING_GUEST" } & BedAllocationRemovalAnchor)
  | ({ type: "BOOKING" } & BedAllocationRemovalAnchor)
  | {
      type: "WINDOW";
      lodgeId: string;
      from: string;
      to: string;
    };

export interface BedAllocationRemovalRequest {
  scope: BedAllocationRemovalScope;
  categories: BedAllocationRemovalCategory[];
}

export interface BedAllocationRemovalApplyRequest
  extends BedAllocationRemovalRequest {
  previewDigest: string;
}

export interface BedAllocationRemovalPromotionPreview {
  allocationId: string;
  bookingId: string;
  bookingGuestId: string;
  guestName: string;
  lodgeId: string;
  roomId: string;
  roomName: string;
  bedId: string;
  bedName: string;
  stayDate: string;
}

export interface BedAllocationRemovalReopenedBookingPreview {
  bookingId: string;
  memberName: string;
}

export interface BedAllocationRemovalPreview {
  digestVersion: typeof BED_ALLOCATION_REMOVAL_DIGEST_VERSION;
  digest: string;
  scope: BedAllocationRemovalScope;
  context: {
    lodgeId: string;
    lodgeName: string;
    from: string;
    to: string;
    bookingId: string | null;
    bookingGuestId: string | null;
    guestName: string | null;
    anchorNight: string | null;
  };
  categories: Record<BedAllocationRemovalCategory, number>;
  matchedRowCount: number;
  affectedBookingCount: number;
  affectedNights: string[];
  promotions: BedAllocationRemovalPromotionPreview[];
  reopenedBookings: BedAllocationRemovalReopenedBookingPreview[];
}

export interface BedAllocationRemovalApplyResult {
  removedRowCount: number;
  promotedRowCount: number;
  affectedBookingCount: number;
  affectedNights: string[];
}

function chunkValues<T>(values: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (
    let offset = 0;
    offset < values.length;
    offset += BED_ALLOCATION_REMOVAL_QUERY_CHUNK_SIZE
  ) {
    chunks.push(
      values.slice(offset, offset + BED_ALLOCATION_REMOVAL_QUERY_CHUNK_SIZE),
    );
  }
  return chunks;
}

/** Test seam and canonical ordering for every ID-expanded removal query. */
export function chunkBedAllocationRemovalIds(ids: readonly string[]): string[][] {
  return chunkValues([...new Set(ids)].sort());
}

export class BedAllocationRemovalError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly refreshedPreview?: BedAllocationRemovalPreview,
  ) {
    super(message);
    this.name = "BedAllocationRemovalError";
  }
}

type RemovalDb = typeof prisma | Prisma.TransactionClient;

const allocationInclude = Prisma.validator<Prisma.BedAllocationInclude>()({
  room: { select: { lodgeId: true, name: true, lodge: { select: { name: true } } } },
  bed: { select: { name: true } },
  bookingGuest: { select: { firstName: true, lastName: true } },
  booking: {
    select: {
      member: { select: { firstName: true, lastName: true } },
      // #3369: the owner may be an Organisation; bookingOwner() reads both.
      organisation: { select: { name: true, email: true } },
    },
  },
});

type RemovalRow = Prisma.BedAllocationGetPayload<{
  include: typeof allocationInclude;
}>;

function personName(person: { firstName: string; lastName: string }): string {
  return `${person.firstName} ${person.lastName}`.trim();
}

function categoryFor(row: {
  source: BedAllocationSource;
  approvedAt: Date | null;
}): BedAllocationRemovalCategory {
  if (row.approvedAt) return "APPROVED";
  return row.source === "AUTO" ? "AUTO_DRAFT" : "MANUAL_DRAFT";
}

function assertCategories(
  categories: BedAllocationRemovalCategory[],
): Set<BedAllocationRemovalCategory> {
  if (categories.length === 0) {
    throw new BedAllocationRemovalError(
      "Select at least one allocation category.",
      400,
    );
  }
  if (new Set(categories).size !== categories.length) {
    throw new BedAllocationRemovalError(
      "Allocation categories must not contain duplicates.",
      400,
    );
  }
  return new Set(categories);
}

function parseWindow(scope: Extract<BedAllocationRemovalScope, { type: "WINDOW" }>) {
  if (!isDateOnlyString(scope.from) || !isDateOnlyString(scope.to)) {
    throw new BedAllocationRemovalError("Invalid removal window.", 400);
  }
  const from = parseDateOnly(scope.from);
  const to = parseDateOnly(scope.to);
  const nights = countNightsDateOnly(from, to);
  if (nights < 1) {
    throw new BedAllocationRemovalError(
      "Removal window date out must be after date in.",
      400,
    );
  }
  if (nights > MAX_BED_ALLOCATION_REMOVAL_WINDOW_NIGHTS) {
    throw new BedAllocationRemovalError(
      `Removal windows cover at most ${MAX_BED_ALLOCATION_REMOVAL_WINDOW_NIGHTS} nights.`,
      400,
    );
  }
  return { from, to };
}

async function resolveAnchor(
  scope: Exclude<BedAllocationRemovalScope, { type: "WINDOW" }>,
  db: RemovalDb,
): Promise<RemovalRow> {
  if (!isDateOnlyString(scope.stayDate)) {
    throw new BedAllocationRemovalError("Invalid anchor night.", 400);
  }
  const anchor = await db.bedAllocation.findUnique({
    where: { id: scope.allocationId },
    include: allocationInclude,
  });
  if (!anchor) {
    throw new BedAllocationRemovalError("Allocation not found.", 404);
  }
  if (
    anchor.bookingId !== scope.bookingId ||
    anchor.bookingGuestId !== scope.bookingGuestId
  ) {
    throw new BedAllocationRemovalError(
      "The allocation anchor does not belong to that booking and guest.",
      400,
    );
  }
  if (
    anchor.room.lodgeId !== scope.lodgeId ||
    formatDateOnly(anchor.stayDate) !== scope.stayDate
  ) {
    throw new BedAllocationRemovalError(
      "The allocation anchor lodge or night no longer matches.",
      409,
    );
  }
  return anchor;
}

function categoryWhere(
  categories: Set<BedAllocationRemovalCategory>,
): Prisma.BedAllocationWhereInput {
  const or: Prisma.BedAllocationWhereInput[] = [];
  if (categories.has("AUTO_DRAFT")) {
    or.push({ source: "AUTO", approvedAt: null });
  }
  if (categories.has("MANUAL_DRAFT")) {
    or.push({ source: "MANUAL", approvedAt: null });
  }
  if (categories.has("APPROVED")) {
    or.push({ approvedAt: { not: null } });
  }
  return { OR: or };
}

function mutableIdentity(row: RemovalRow) {
  return {
    id: row.id,
    bookingId: row.bookingId,
    bookingGuestId: row.bookingGuestId,
    roomId: row.roomId,
    bedId: row.bedId,
    stayDate: formatDateOnly(row.stayDate),
    source: row.source,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    approvedByMemberId: row.approvedByMemberId,
    isSecondOccupant: row.isSecondOccupant,
    bedType: row.bedType,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function canonicalScope(scope: BedAllocationRemovalScope) {
  if (scope.type === "WINDOW") {
    return {
      type: scope.type,
      lodgeId: scope.lodgeId,
      from: scope.from,
      to: scope.to,
    };
  }
  return {
    type: scope.type,
    allocationId: scope.allocationId,
    bookingId: scope.bookingId,
    bookingGuestId: scope.bookingGuestId,
    lodgeId: scope.lodgeId,
    stayDate: scope.stayDate,
  };
}

function digestPreviewState(input: {
  request: BedAllocationRemovalRequest;
  matchingRows: RemovalRow[];
  approvedRows: RemovalRow[];
  causalSiblings: RemovalRow[];
}): string {
  const byId = (a: RemovalRow, b: RemovalRow) => a.id.localeCompare(b.id);
  const canonical = {
    scope: canonicalScope(input.request.scope),
    categories: [...input.request.categories].sort(),
    matchingRows: [...input.matchingRows].sort(byId).map(mutableIdentity),
    approvedRows: [...input.approvedRows].sort(byId).map(mutableIdentity),
    causalSiblings: [...input.causalSiblings].sort(byId).map(mutableIdentity),
    approvedTotals: [...new Set(input.matchingRows.map((row) => row.bookingId))]
      .sort()
      .map((bookingId) => ({
        bookingId,
        count: input.approvedRows.filter((row) => row.bookingId === bookingId)
          .length,
      })),
  };
  const hash = createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
  return `${BED_ALLOCATION_REMOVAL_DIGEST_VERSION}:${hash}`;
}

async function loadPreviewState(
  request: BedAllocationRemovalRequest,
  db: RemovalDb,
  options: { allowStaleAnchor?: boolean } = {},
): Promise<{
  preview: BedAllocationRemovalPreview;
  matchingRows: RemovalRow[];
  causalSiblings: RemovalRow[];
  staleAnchor: boolean;
}> {
  const categories = assertCategories(request.categories);
  let anchor: RemovalRow | null = null;
  let staleAnchor = false;
  let effectiveScope = request.scope;
  let where: Prisma.BedAllocationWhereInput;
  let contextWindow: { from: string; to: string };

  if (request.scope.type === "WINDOW") {
    const range = parseWindow(request.scope);
    where = {
      room: { lodgeId: request.scope.lodgeId },
      stayDate: { gte: range.from, lt: range.to },
    };
    contextWindow = { from: request.scope.from, to: request.scope.to };
  } else {
    try {
      anchor = await resolveAnchor(request.scope, db);
    } catch (error) {
      // Preview calls reject invalid/stale anchors. Apply calls need a different
      // response: every state change after a reviewed preview, including the
      // anchor disappearing or moving, is a stale digest and returns a fresh
      // preview-shaped snapshot with no mutation.
      if (
        !options.allowStaleAnchor ||
        !(error instanceof BedAllocationRemovalError) ||
        (error.status !== 404 && error.status !== 409)
      ) {
        throw error;
      }
      staleAnchor = true;
      anchor = await db.bedAllocation.findUnique({
        where: { id: request.scope.allocationId },
        include: allocationInclude,
      });
      // An aggregate scope is identified by the booking/guest, not forever by
      // the particular row that opened the dialog. If that row disappeared,
      // return a canonical refreshed scope anchored to the first surviving row
      // in the same aggregate. The current apply still fails closed because
      // staleAnchor remains true; adopting this returned scope makes the next
      // reviewed apply possible instead of producing an endless 409 loop.
      if (!anchor && request.scope.type !== "ALLOCATION") {
        const aggregateWhere =
          request.scope.type === "BOOKING_GUEST"
            ? {
                bookingId: request.scope.bookingId,
                bookingGuestId: request.scope.bookingGuestId,
              }
            : { bookingId: request.scope.bookingId };
        anchor = await db.bedAllocation.findFirst({
          where: { AND: [aggregateWhere, categoryWhere(categories)] },
          include: allocationInclude,
          orderBy: { id: "asc" },
        });
      }
      if (anchor) {
        effectiveScope = {
          ...request.scope,
          allocationId: anchor.id,
          bookingId: anchor.bookingId,
          bookingGuestId: anchor.bookingGuestId,
          lodgeId: anchor.room.lodgeId,
          stayDate: formatDateOnly(anchor.stayDate),
        };
      }
    }
    where =
      request.scope.type === "ALLOCATION"
        ? { id: request.scope.allocationId }
        : request.scope.type === "BOOKING_GUEST"
          ? {
              bookingId: request.scope.bookingId,
              bookingGuestId: request.scope.bookingGuestId,
            }
          : { bookingId: request.scope.bookingId };
    contextWindow = {
      from: anchor ? formatDateOnly(anchor.stayDate) : request.scope.stayDate,
      to: anchor ? formatDateOnly(anchor.stayDate) : request.scope.stayDate,
    };
  }

  const matchingRows = await db.bedAllocation.findMany({
    where: { AND: [where, categoryWhere(categories)] },
    include: allocationInclude,
    orderBy: { id: "asc" },
  });

  const affectedBookingIds = [
    ...new Set(matchingRows.map((row) => row.bookingId)),
  ].sort();
  const approvedRows =
    affectedBookingIds.length === 0
      ? []
      : await db.bedAllocation.findMany({
          where: {
            bookingId: { in: affectedBookingIds },
            approvedAt: { not: null },
          },
          include: allocationInclude,
          orderBy: { id: "asc" },
        });

  const selectedIds = new Set(matchingRows.map((row) => row.id));
  const primaryKeys = [
    ...new Map(
      matchingRows
        .filter((row) => !row.isSecondOccupant)
        .map((row) => [
          `${row.bedId}\u0000${row.stayDate.toISOString()}`,
          { bedId: row.bedId, stayDate: row.stayDate },
        ]),
    ).entries(),
  ]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, key]) => key);
  const siblingCandidates = [];
  for (const primaryKeyChunk of chunkValues(primaryKeys)) {
    siblingCandidates.push(
      ...(await db.bedAllocation.findMany({
          where: {
            isSecondOccupant: true,
            OR: primaryKeyChunk,
          },
          include: allocationInclude,
          orderBy: { id: "asc" },
        })),
    );
  }
  const causalSiblings = siblingCandidates
    .filter((row) => !selectedIds.has(row.id))
    .sort((left, right) => left.id.localeCompare(right.id));

  const approvedIdsByBooking = new Map<string, Set<string>>();
  for (const row of approvedRows) {
    const ids = approvedIdsByBooking.get(row.bookingId) ?? new Set<string>();
    ids.add(row.id);
    approvedIdsByBooking.set(row.bookingId, ids);
  }
  for (const row of matchingRows) {
    if (!row.approvedAt) continue;
    approvedIdsByBooking.get(row.bookingId)?.delete(row.id);
  }
  const reopenedBookingIds = affectedBookingIds.filter(
    (bookingId) => (approvedIdsByBooking.get(bookingId)?.size ?? 0) === 0 &&
      approvedRows.some((row) => row.bookingId === bookingId),
  );
  const bookingMemberName = new Map(
    matchingRows.map((row) => [row.bookingId, personName(bookingOwner(row.booking).member)]),
  );

  const categoryCounts: Record<BedAllocationRemovalCategory, number> = {
    AUTO_DRAFT: 0,
    MANUAL_DRAFT: 0,
    APPROVED: 0,
  };
  for (const row of matchingRows) categoryCounts[categoryFor(row)] += 1;

  const lodgeId = effectiveScope.lodgeId;
  const lodge = await db.lodge.findUnique({
    where: { id: lodgeId },
    select: { name: true },
  });
  if (!lodge) {
    throw new BedAllocationRemovalError("Lodge not found.", 404);
  }

  const digest = digestPreviewState({
    request: { scope: effectiveScope, categories: request.categories },
    matchingRows,
    approvedRows,
    causalSiblings,
  });
  const affectedNights = [
    ...new Set(matchingRows.map((row) => formatDateOnly(row.stayDate))),
  ].sort();

  return {
    matchingRows,
    causalSiblings,
    staleAnchor,
    preview: {
      digestVersion: BED_ALLOCATION_REMOVAL_DIGEST_VERSION,
      digest,
      scope: effectiveScope,
      context: {
        lodgeId,
        lodgeName: lodge.name,
        from: contextWindow.from,
        to: contextWindow.to,
        bookingId: anchor?.bookingId ?? null,
        bookingGuestId: anchor?.bookingGuestId ?? null,
        guestName: anchor ? personName(anchor.bookingGuest) : null,
        anchorNight: anchor ? formatDateOnly(anchor.stayDate) : null,
      },
      categories: categoryCounts,
      matchedRowCount: matchingRows.length,
      affectedBookingCount: affectedBookingIds.length,
      affectedNights,
      promotions: causalSiblings.map((row) => ({
        allocationId: row.id,
        bookingId: row.bookingId,
        bookingGuestId: row.bookingGuestId,
        guestName: personName(row.bookingGuest),
        lodgeId: row.room.lodgeId,
        roomId: row.roomId,
        roomName: row.room.name,
        bedId: row.bedId,
        bedName: row.bed.name,
        stayDate: formatDateOnly(row.stayDate),
      })),
      reopenedBookings: reopenedBookingIds.map((bookingId) => ({
        bookingId,
        memberName: bookingMemberName.get(bookingId) ?? bookingId,
      })),
    },
  };
}

export async function previewBedAllocationRemoval(
  request: BedAllocationRemovalRequest,
  db: RemovalDb = prisma,
): Promise<BedAllocationRemovalPreview> {
  return (await loadPreviewState(request, db)).preview;
}

async function resolveImmutableLodgeKeys(
  request: BedAllocationRemovalRequest,
): Promise<string[]> {
  if (request.scope.type === "WINDOW") return [request.scope.lodgeId];
  // Resolve only stable identity keys before global lock acquisition. The
  // booking's lodge is the canonical allocation partition; the reviewed
  // anchor's lodge is retained as a second key so a historical row already
  // drifted from that partition is still handled safely. Never derive the lock
  // set from mutable BedAllocation -> room edges. A later under-lock check
  // refuses any third-lodge anomaly rather than mutating it without its lock.
  const booking = await prisma.booking.findUnique({
    where: { id: request.scope.bookingId },
    select: { lodgeId: true },
  });
  return [
    ...new Set(
      [booking?.lodgeId, request.scope.lodgeId].filter(
        (lodgeId): lodgeId is string => Boolean(lodgeId),
      ),
    ),
  ].sort();
}

function assertRemovalRowsUseLockedLodges(
  state: Pick<
    Awaited<ReturnType<typeof loadPreviewState>>,
    "matchingRows" | "causalSiblings" | "preview"
  >,
  lodgeIds: string[],
): void {
  const lockedLodgeIds = new Set(lodgeIds);
  const unlockedLodgeIds = [
    ...new Set(
      [...state.matchingRows, ...state.causalSiblings]
        .map((row) => row.room.lodgeId)
        .filter((lodgeId) => !lockedLodgeIds.has(lodgeId)),
    ),
  ].sort();
  if (unlockedLodgeIds.length === 0) return;
  throw new BedAllocationRemovalError(
    "Matching allocations include a historical lodge outside the reviewed booking and anchor. Nothing was removed; remove that allocation separately.",
    409,
    state.preview,
  );
}

function boundedIdentities(ids: string[]) {
  return {
    ids: ids.slice(0, MAX_AUDIT_IDENTITIES),
    omittedCount: Math.max(0, ids.length - MAX_AUDIT_IDENTITIES),
  };
}

export async function applyBedAllocationRemoval(input: {
  request: BedAllocationRemovalApplyRequest;
  actorMemberId: string;
}): Promise<BedAllocationRemovalApplyResult> {
  const lodgeIds = await resolveImmutableLodgeKeys(input.request);

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    for (const lodgeId of lodgeIds) {
      await acquireLodgeCapacityLock(tx, lodgeId);
    }

    const initial = await loadPreviewState(input.request, tx, {
      allowStaleAnchor: true,
    });
    assertRemovalRowsUseLockedLodges(initial, lodgeIds);
    const lockIds = chunkBedAllocationRemovalIds([
      ...initial.matchingRows.map((row) => row.id),
      ...initial.causalSiblings.map((row) => row.id),
    ]);
    for (const lockIdChunk of lockIds) {
      await tx.$executeRaw`
        SELECT 1
        FROM "BedAllocation"
        WHERE "id" IN (${Prisma.join(lockIdChunk)})
        ORDER BY "id"
        FOR UPDATE
      `;
    }

    const authoritative = await loadPreviewState(input.request, tx, {
      allowStaleAnchor: true,
    });
    assertRemovalRowsUseLockedLodges(authoritative, lodgeIds);
    if (
      authoritative.staleAnchor ||
      authoritative.preview.digest !== input.request.previewDigest
    ) {
      throw new BedAllocationRemovalError(
        "Bed allocations changed after the preview. Review the refreshed counts before applying.",
        409,
        authoritative.preview,
      );
    }

    const selectedIds = authoritative.matchingRows.map((row) => row.id);
    if (selectedIds.length === 0) {
      throw new BedAllocationRemovalError(
        "No allocations match this removal.",
        409,
        authoritative.preview,
      );
    }

    for (const selectedIdChunk of chunkBedAllocationRemovalIds(selectedIds)) {
      const deleted = await tx.bedAllocation.deleteMany({
        where: { id: { in: selectedIdChunk } },
      });
      if (deleted.count !== selectedIdChunk.length) {
        throw new BedAllocationRemovalError(
          "Bed allocations changed while the removal was applying.",
          409,
        );
      }
    }

    const siblingIds = authoritative.causalSiblings.map((sibling) => sibling.id);
    if (siblingIds.length > 0) {
      for (const siblingIdChunk of chunkBedAllocationRemovalIds(siblingIds)) {
        const promoted = await tx.bedAllocation.updateMany({
          where: { id: { in: siblingIdChunk }, isSecondOccupant: true },
          data: { isSecondOccupant: false },
        });
        if (promoted.count !== siblingIdChunk.length) {
          throw new BedAllocationRemovalError(
            "A shared double changed while the removal was applying.",
            409,
          );
        }
      }
    }

    const selectedIdentitySummary = boundedIdentities([...selectedIds].sort());
    const affectedBookingIdentitySummary = boundedIdentities(
      [...new Set(authoritative.matchingRows.map((row) => row.bookingId))].sort(),
    );
    const affectedNightSummary = boundedIdentities(
      [...authoritative.preview.affectedNights].sort(),
    );
    const reopenedBookingIdentitySummary = boundedIdentities(
      authoritative.preview.reopenedBookings
        .map((booking) => booking.bookingId)
        .sort(),
    );
    const searchableAffectedBookingIds = affectedBookingIdentitySummary.ids.slice(
      0,
      30,
    );
    await createAuditLog(
      {
        action: "BED_ALLOCATION_REMOVAL_APPLIED",
        memberId: input.actorMemberId,
        targetId:
          authoritative.preview.context.bookingId ??
          authoritative.matchingRows[0]?.bookingId,
        entityType: "BedAllocationRemoval",
        category: "lodge",
        outcome: "success",
        summary: "Bed allocations removed through reviewed preview",
        details: `Affected bookings: ${searchableAffectedBookingIds.join(", ")}${authoritative.preview.affectedBookingCount > searchableAffectedBookingIds.length ? `. Showing ${searchableAffectedBookingIds.length} of ${authoritative.preview.affectedBookingCount} booking IDs; metadata.affectedBookingIds contains a bounded sample of ${affectedBookingIdentitySummary.ids.length} IDs and omits ${affectedBookingIdentitySummary.omittedCount}.` : ""}`,
        metadata: {
          digestVersion: authoritative.preview.digestVersion,
          previewDigest: authoritative.preview.digest,
          scope: input.request.scope,
          selectedCategories: input.request.categories,
          removedRowCount: selectedIds.length,
          categoryCounts: authoritative.preview.categories,
          affectedBookingCount: authoritative.preview.affectedBookingCount,
          affectedBookingIds: affectedBookingIdentitySummary.ids,
          omittedAffectedBookingIdCount:
            affectedBookingIdentitySummary.omittedCount,
          affectedNights: affectedNightSummary.ids,
          omittedAffectedNightCount: affectedNightSummary.omittedCount,
          promotedRowCount: authoritative.causalSiblings.length,
          reopenedBookingIds: reopenedBookingIdentitySummary.ids,
          omittedReopenedBookingIdCount:
            reopenedBookingIdentitySummary.omittedCount,
          allocationIds: selectedIdentitySummary.ids,
          omittedAllocationIdCount: selectedIdentitySummary.omittedCount,
          autoAllocationTriggered: false,
        },
      },
      tx,
    );

    if (authoritative.causalSiblings.length > 0) {
      const promotedBookingIds = [
        ...new Set(
          authoritative.causalSiblings.map((sibling) => sibling.bookingId),
        ),
      ].sort();
      const searchableBookingIds = promotedBookingIds.slice(0, 30);
      const promotionIdentitySummary = authoritative.causalSiblings
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, MAX_AUDIT_IDENTITIES)
        .map((sibling) => ({
          allocationId: sibling.id,
          bookingId: sibling.bookingId,
          bookingGuestId: sibling.bookingGuestId,
          bedId: sibling.bedId,
          stayDate: formatDateOnly(sibling.stayDate),
        }));
      await createAuditLog(
        {
          action: "BED_ALLOCATION_PARTNERS_PROMOTED",
          memberId: input.actorMemberId,
          targetId:
            authoritative.preview.context.bookingId ??
            authoritative.matchingRows[0]?.bookingId,
          entityType: "BedAllocation",
          category: "lodge",
          outcome: "success",
          summary: `${authoritative.causalSiblings.length} second occupant${authoritative.causalSiblings.length === 1 ? "" : "s"} auto-promoted to primary after reviewed allocation removal`,
          details: `Promoted partner bookings: ${searchableBookingIds.join(", ")}${promotedBookingIds.length > searchableBookingIds.length ? `. Showing ${searchableBookingIds.length} of ${promotedBookingIds.length} booking IDs; metadata.promotions contains a bounded sample of ${promotionIdentitySummary.length} of ${authoritative.causalSiblings.length} promotion records and omits ${authoritative.causalSiblings.length - promotionIdentitySummary.length}.` : ""}`,
          metadata: {
            removalPreviewDigest: authoritative.preview.digest,
            promotedCount: authoritative.causalSiblings.length,
            promotions: promotionIdentitySummary,
            omittedPromotionCount:
              authoritative.causalSiblings.length - promotionIdentitySummary.length,
            promotionsTruncated:
              authoritative.causalSiblings.length > MAX_AUDIT_IDENTITIES,
          },
        },
        tx,
      );
    }

    return {
      removedRowCount: selectedIds.length,
      promotedRowCount: authoritative.causalSiblings.length,
      affectedBookingCount: authoritative.preview.affectedBookingCount,
      affectedNights: authoritative.preview.affectedNights,
    };
  });
}
