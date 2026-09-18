import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { createAuditLog } from "@/lib/audit";
import { isAdultAgeTier } from "@/lib/bed-allocation";
import { BED_ALLOCATABLE_BOOKING_STATUSES } from "@/lib/bed-allocation-lifecycle";
import {
  bookingHoldsCapacity,
  isCapacityHoldingBookingStatus,
} from "@/lib/booking-status";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import {
  addDaysDateOnly,
  formatDateOnly,
  parseDateOnly,
} from "@/lib/date-only";
import {
  findCustodianBedHolds,
  holdCoversNight,
} from "@/lib/custodian-occupancy";
import {
  isBlockingWholeLodgeHold,
  wholeLodgeHoldCoversNight,
} from "@/lib/exclusive-hold-occupancy";
import { isOperationallyPresentConsent } from "@/lib/member-guest-consent";
import { acquireMemberLifecycleLocks } from "@/lib/member-lifecycle-lock";
import { acquireMemberPartnerLinkLocks } from "@/lib/member-partner-lock";
import {
  canonicalPartnerPair,
  PARTNER_LINK_CONFIRMED,
} from "@/lib/member-partner-link-shared";
import { prisma } from "@/lib/prisma";

export const BED_ALLOCATION_MOVE_DIGEST_VERSION = "v1" as const;
export const MAX_BED_ALLOCATION_PERSON_MOVE_NIGHTS = 366;

export const BED_ALLOCATION_MOVE_SCOPES = [
  "ALLOCATION_NIGHT",
  "BOOKING_GUEST",
] as const;

export type BedAllocationMoveScope =
  (typeof BED_ALLOCATION_MOVE_SCOPES)[number];

export interface BedAllocationMoveRequest {
  anchorAllocationId: string;
  destinationBedId: string;
  scope: BedAllocationMoveScope;
}

export interface BedAllocationMoveApplyRequest
  extends BedAllocationMoveRequest {
  previewDigest: string;
}

export interface BedAllocationMoveDetail {
  allocationId: string;
  stayDate: string;
  source: "AUTO" | "MANUAL";
  approved: boolean;
  sourceRoomName: string;
  sourceBedName: string;
}

export interface BedAllocationMovePromotionPreview {
  stayDate: string;
  bedName: string;
}

export type BedAllocationMoveConflictCode =
  | "ALLOCATION_UNAVAILABLE"
  | "DESTINATION_UNAVAILABLE"
  | "LODGE_MISMATCH"
  | "BOOKING_NOT_ALLOCATABLE"
  | "GUEST_NOT_STAYING"
  | "GUEST_NOT_PRESENT"
  | "BED_TAKEN"
  | "SHARED_DOUBLE_INELIGIBLE"
  | "ADULT_MINOR_MIX"
  | "CUSTODIAN_HOLD"
  | "WHOLE_LODGE_HOLD";

export interface BedAllocationMoveConflict {
  allocationId: string;
  stayDate: string | null;
  code: BedAllocationMoveConflictCode;
  message: string;
}

export interface BedAllocationMovePreview {
  digestVersion: typeof BED_ALLOCATION_MOVE_DIGEST_VERSION;
  digest: string;
  scope: BedAllocationMoveScope;
  anchor: {
    allocationId: string;
    guestName: string | null;
    stayDate: string | null;
  };
  destination: {
    bedId: string;
    label: string;
    available: boolean;
  };
  resolvedRowCount: number;
  changedRowCount: number;
  unchangedRowCount: number;
  approvedToDraftCount: number;
  changed: BedAllocationMoveDetail[];
  unchanged: BedAllocationMoveDetail[];
  promotions: BedAllocationMovePromotionPreview[];
  conflicts: BedAllocationMoveConflict[];
}

export interface BedAllocationMoveApplyResult {
  noop: boolean;
  movedRowCount: number;
  promotedRowCount: number;
  affectedNights: string[];
}

export type BedAllocationMoveErrorCode =
  | "STALE_PREVIEW"
  | "MOVE_CONFLICT"
  | "INVALID_MOVE";

export class BedAllocationMoveError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code: BedAllocationMoveErrorCode = "INVALID_MOVE",
    public readonly refreshedPreview?: BedAllocationMovePreview,
  ) {
    super(message);
    this.name = "BedAllocationMoveError";
  }
}

const MAX_AUDIT_IDENTITIES = 50;
const MAX_SEARCHABLE_PROMOTED_BOOKING_IDS = 30;

const bookingFactsSelect = {
  id: true,
  status: true,
  deletedAt: true,
  lodgeId: true,
  wholeLodgeHold: true,
  checkIn: true,
  checkOut: true,
  adminCapacityHoldAt: true,
  updatedAt: true,
  originBookingRequest: { select: { id: true } },
} satisfies Prisma.BookingSelect;

const moveAllocationInclude = Prisma.validator<Prisma.BedAllocationInclude>()({
  booking: { select: bookingFactsSelect },
  bookingGuest: {
    include: {
      booking: { select: bookingFactsSelect },
      member: {
        select: { id: true, active: true, ageTier: true, updatedAt: true },
      },
      nights: { select: { id: true, stayDate: true, priceCents: true } },
    },
  },
  room: {
    select: {
      id: true,
      name: true,
      active: true,
      lodgeId: true,
      updatedAt: true,
    },
  },
  bed: {
    select: {
      id: true,
      roomId: true,
      name: true,
      active: true,
      bedType: true,
      updatedAt: true,
    },
  },
});

const destinationInclude = Prisma.validator<Prisma.LodgeBedInclude>()({
  room: {
    select: {
      id: true,
      name: true,
      active: true,
      lodgeId: true,
      updatedAt: true,
    },
  },
});

type MoveAllocationRow = Prisma.BedAllocationGetPayload<{
  include: typeof moveAllocationInclude;
}>;
type MoveDestination = Prisma.LodgeBedGetPayload<{
  include: typeof destinationInclude;
}>;
type MoveDb = Pick<
  typeof prisma,
  | "bedAllocation"
  | "booking"
  | "bookingGuest"
  | "hutLeaderAssignment"
  | "lodgeBed"
  | "lodgeRoom"
  | "member"
  | "memberPartnerLink"
>;

interface MoveBaseState {
  request: BedAllocationMoveRequest;
  anchor: MoveAllocationRow;
  destination: MoveDestination;
  selectedRows: MoveAllocationRow[];
  changedRows: MoveAllocationRow[];
  lodgeIds: string[];
}

interface MoveMemberFact {
  id: string;
  active: boolean;
  ageTier: string;
  updatedAt: Date;
}

interface MovePartnerFact {
  id: string;
  memberAId: string;
  memberBId: string;
  status: string;
  updatedAt: Date;
}

interface MoveWholeHoldFact {
  id: string;
  status: string;
  checkIn: Date;
  checkOut: Date;
  lodgeId: string;
  wholeLodgeHold: boolean;
  adminCapacityHoldAt: Date | null;
  updatedAt: Date;
  originBookingRequest: { id: string } | null;
}

interface MoveState extends MoveBaseState {
  relatedRows: MoveAllocationRow[];
  members: MoveMemberFact[];
  partnerLinks: MovePartnerFact[];
  memberIds: string[];
  custodianHolds: Awaited<ReturnType<typeof findCustodianBedHolds>>;
  wholeLodgeHolds: MoveWholeHoldFact[];
  targetSecondByAllocationId: Map<string, boolean>;
  promotionRows: MoveAllocationRow[];
  preview: BedAllocationMovePreview;
}

function personName(person: { firstName: string; lastName: string }) {
  return `${person.firstName} ${person.lastName}`.trim();
}

function destinationLabel(destination: MoveDestination) {
  return `${destination.room.name} / ${destination.name}`;
}

function assertMoveScope(scope: BedAllocationMoveScope) {
  if (!BED_ALLOCATION_MOVE_SCOPES.includes(scope)) {
    throw new BedAllocationMoveError("Invalid allocation move scope", 400);
  }
}

function assertMoveIdentity(
  anchor: MoveAllocationRow,
  rows: readonly MoveAllocationRow[],
) {
  const guestBookingId = anchor.bookingGuest.bookingId;
  if (
    anchor.bookingGuestId !== anchor.bookingGuest.id ||
    anchor.bookingId !== guestBookingId ||
    anchor.booking.id !== anchor.bookingId ||
    anchor.bookingGuest.booking.id !== guestBookingId
  ) {
    throw new BedAllocationMoveError(
      "The allocation no longer belongs to a consistent booking and guest.",
      409,
    );
  }
  for (const row of rows) {
    if (
      row.bookingGuestId !== anchor.bookingGuestId ||
      row.bookingGuestId !== row.bookingGuest.id ||
      row.bookingId !== guestBookingId ||
      row.booking.id !== row.bookingId ||
      row.bookingGuest.bookingId !== guestBookingId ||
      row.bookingGuest.booking.id !== guestBookingId ||
      row.roomId !== row.room.id ||
      row.bedId !== row.bed.id ||
      row.bed.roomId !== row.roomId
    ) {
      throw new BedAllocationMoveError(
        "The selected allocation rows no longer share one consistent booking and guest.",
        409,
      );
    }
  }
}

async function loadMoveBase(
  request: BedAllocationMoveRequest,
  db: MoveDb,
): Promise<MoveBaseState> {
  assertMoveScope(request.scope);
  const [anchor, destination] = await Promise.all([
    db.bedAllocation.findUnique({
      where: { id: request.anchorAllocationId },
      include: moveAllocationInclude,
    }),
    db.lodgeBed.findUnique({
      where: { id: request.destinationBedId },
      include: destinationInclude,
    }),
  ]);
  if (!anchor) {
    throw new BedAllocationMoveError("Allocation not found", 404);
  }
  if (!destination) {
    throw new BedAllocationMoveError("Destination bed not found", 404);
  }
  if (destination.roomId !== destination.room.id) {
    throw new BedAllocationMoveError(
      "The destination bed no longer belongs to a consistent room.",
      409,
    );
  }

  const selectedRows =
    request.scope === "ALLOCATION_NIGHT"
      ? [anchor]
      : await db.bedAllocation.findMany({
          where: { bookingGuestId: anchor.bookingGuestId },
          include: moveAllocationInclude,
          orderBy: [{ stayDate: "asc" }, { id: "asc" }],
        });
  if (selectedRows.length > MAX_BED_ALLOCATION_PERSON_MOVE_NIGHTS) {
    throw new BedAllocationMoveError(
      `Cannot move more than ${MAX_BED_ALLOCATION_PERSON_MOVE_NIGHTS} existing allocation nights for one person`,
      400,
    );
  }
  assertMoveIdentity(anchor, selectedRows);

  const changedRows = selectedRows.filter(
    (row) => row.bedId !== request.destinationBedId,
  );
  const lodgeIds = [
    ...new Set([
      destination.room.lodgeId,
      anchor.booking.lodgeId,
      anchor.bookingGuest.booking.lodgeId,
      ...selectedRows.flatMap((row) => [
        row.room.lodgeId,
        row.booking.lodgeId,
        row.bookingGuest.booking.lodgeId,
      ]),
    ]),
  ].sort();

  return {
    request,
    anchor,
    destination,
    selectedRows,
    changedRows,
    lodgeIds,
  };
}

function guestStaysOn(row: MoveAllocationRow, stayDate: Date) {
  const guest = row.bookingGuest;
  if (guest.nights.length > 0) {
    const wanted = formatDateOnly(stayDate);
    return guest.nights.some(
      (night) => formatDateOnly(night.stayDate) === wanted,
    );
  }
  return guest.stayStart <= stayDate && stayDate < guest.stayEnd;
}

function holdingBooking(booking: MoveAllocationRow["booking"]) {
  return bookingHoldsCapacity({
    status: booking.status,
    isRequestConverted: Boolean(booking.originBookingRequest),
    hasAdminCapacityHold: Boolean(booking.adminCapacityHoldAt),
  });
}

function rowDetail(row: MoveAllocationRow): BedAllocationMoveDetail {
  return {
    allocationId: row.id,
    stayDate: formatDateOnly(row.stayDate),
    source: row.source,
    approved: Boolean(row.approvedAt),
    sourceRoomName: row.room.name,
    sourceBedName: row.bed.name,
  };
}

function dateKey(value: Date) {
  return formatDateOnly(value);
}

function timestamp(value: Date | null | undefined) {
  return value?.toISOString() ?? null;
}

function compareRows(left: MoveAllocationRow, right: MoveAllocationRow) {
  return (
    left.bedId.localeCompare(right.bedId) ||
    dateKey(left.stayDate).localeCompare(dateKey(right.stayDate)) ||
    Number(left.isSecondOccupant) - Number(right.isSecondOccupant) ||
    left.id.localeCompare(right.id)
  );
}

function canonicalBooking(booking: MoveAllocationRow["booking"]) {
  return {
    id: booking.id,
    status: booking.status,
    deletedAt: timestamp(booking.deletedAt),
    lodgeId: booking.lodgeId,
    wholeLodgeHold: booking.wholeLodgeHold,
    checkIn: dateKey(booking.checkIn),
    checkOut: dateKey(booking.checkOut),
    adminCapacityHoldAt: timestamp(booking.adminCapacityHoldAt),
    originBookingRequestId: booking.originBookingRequest?.id ?? null,
    holdsCapacity: holdingBooking(booking),
    updatedAt: timestamp(booking.updatedAt),
  };
}

function canonicalAllocation(row: MoveAllocationRow) {
  return {
    id: row.id,
    bookingId: row.bookingId,
    bookingGuestId: row.bookingGuestId,
    roomId: row.roomId,
    bedId: row.bedId,
    stayDate: dateKey(row.stayDate),
    source: row.source,
    approvedByMemberId: row.approvedByMemberId,
    approvedAt: timestamp(row.approvedAt),
    isSecondOccupant: row.isSecondOccupant,
    bedType: row.bedType,
    createdAt: timestamp(row.createdAt),
    updatedAt: timestamp(row.updatedAt),
    room: {
      id: row.room.id,
      lodgeId: row.room.lodgeId,
      name: row.room.name,
      active: row.room.active,
      updatedAt: timestamp(row.room.updatedAt),
    },
    bed: {
      id: row.bed.id,
      roomId: row.bed.roomId,
      name: row.bed.name,
      active: row.bed.active,
      bedType: row.bed.bedType,
      updatedAt: timestamp(row.bed.updatedAt),
    },
    booking: canonicalBooking(row.booking),
    bookingGuest: {
      id: row.bookingGuest.id,
      bookingId: row.bookingGuest.bookingId,
      firstName: row.bookingGuest.firstName,
      lastName: row.bookingGuest.lastName,
      ageTier: row.bookingGuest.ageTier,
      isMember: row.bookingGuest.isMember,
      memberId: row.bookingGuest.memberId,
      stayStart: dateKey(row.bookingGuest.stayStart),
      stayEnd: dateKey(row.bookingGuest.stayEnd),
      consentStatus: row.bookingGuest.consentStatus,
      consentRequestedAt: timestamp(row.bookingGuest.consentRequestedAt),
      consentRespondedAt: timestamp(row.bookingGuest.consentRespondedAt),
      consentRespondedByMemberId:
        row.bookingGuest.consentRespondedByMemberId,
      consentExpiresAt: timestamp(row.bookingGuest.consentExpiresAt),
      member: row.bookingGuest.member
        ? {
            id: row.bookingGuest.member.id,
            active: row.bookingGuest.member.active,
            ageTier: row.bookingGuest.member.ageTier,
            updatedAt: timestamp(row.bookingGuest.member.updatedAt),
          }
        : null,
      nights: row.bookingGuest.nights
        .map((night) => ({
          id: night.id,
          stayDate: dateKey(night.stayDate),
          priceCents: night.priceCents,
        }))
        .sort(
          (left, right) =>
            left.stayDate.localeCompare(right.stayDate) ||
            left.id.localeCompare(right.id),
        ),
      booking: canonicalBooking(row.bookingGuest.booking),
    },
  };
}

function sortedUnique(values: readonly string[]) {
  return [...new Set(values.filter(Boolean))].sort();
}

function changedDateKeys(base: MoveBaseState) {
  return sortedUnique(base.changedRows.map((row) => dateKey(row.stayDate)));
}

function selectedIdSet(base: MoveBaseState) {
  return new Set(base.selectedRows.map((row) => row.id));
}

function conflict(
  row: MoveAllocationRow,
  code: BedAllocationMoveConflictCode,
  message: string,
): BedAllocationMoveConflict {
  return {
    allocationId: row.id,
    stayDate: dateKey(row.stayDate),
    code,
    message,
  };
}

async function loadRelatedRows(base: MoveBaseState, db: MoveDb) {
  const dates = base.changedRows.map((row) => row.stayDate);
  if (dates.length === 0) return [];
  const oldBedNights = base.changedRows.map((row) => ({
    bedId: row.bedId,
    stayDate: row.stayDate,
  }));
  const rows = await db.bedAllocation.findMany({
    where: {
      OR: [
        { roomId: base.destination.roomId, stayDate: { in: dates } },
        ...oldBedNights,
      ],
    },
    include: moveAllocationInclude,
    orderBy: [
      { bedId: "asc" },
      { stayDate: "asc" },
      { isSecondOccupant: "asc" },
      { id: "asc" },
    ],
  });
  for (const row of rows) {
    if (
      row.bookingId !== row.booking.id ||
      row.bookingGuestId !== row.bookingGuest.id ||
      row.bookingGuest.bookingId !== row.bookingId ||
      row.bookingGuest.booking.id !== row.bookingId ||
      row.roomId !== row.room.id ||
      row.bedId !== row.bed.id ||
      row.bed.roomId !== row.roomId
    ) {
      throw new BedAllocationMoveError(
        "A related allocation no longer belongs to a consistent booking, guest, room and bed.",
        409,
      );
    }
  }
  return rows;
}

function moveLodgeIds(
  base: MoveBaseState,
  relatedRows: MoveAllocationRow[],
) {
  return sortedUnique([
    ...base.lodgeIds,
    ...relatedRows.flatMap((row) => [
      row.room.lodgeId,
      row.booking.lodgeId,
      row.bookingGuest.booking.lodgeId,
    ]),
  ]);
}

async function loadWholeLodgeHolds(base: MoveBaseState, db: MoveDb) {
  // Both ends of the changed nights: no changed night is no window to look in
  // (#2800, half-open per INV-DATE).
  const nights = changedDateKeys(base);
  const firstNightKey = nights[0];
  const lastNightKey = nights.at(-1);
  if (firstNightKey === undefined || lastNightKey === undefined) return [];
  const from = parseDateOnly(firstNightKey);
  const toExclusive = addDaysDateOnly(parseDateOnly(lastNightKey), 1);
  return db.booking.findMany({
    where: {
      lodgeId: base.destination.room.lodgeId,
      wholeLodgeHold: true,
      checkIn: { lt: toExclusive },
      checkOut: { gt: from },
    },
    select: bookingFactsSelect,
    orderBy: [{ checkIn: "asc" }, { id: "asc" }],
  });
}

async function loadCustodianHolds(base: MoveBaseState, db: MoveDb) {
  const nights = changedDateKeys(base);
  const firstNightKey = nights[0];
  const lastNightKey = nights.at(-1);
  if (firstNightKey === undefined || lastNightKey === undefined) return [];
  return findCustodianBedHolds({
    lodgeId: base.destination.room.lodgeId,
    bedIds: [base.destination.id],
    from: parseDateOnly(firstNightKey),
    toExclusive: addDaysDateOnly(parseDateOnly(lastNightKey), 1),
    db,
  });
}

function moveMemberIds(
  base: MoveBaseState,
  relatedRows: MoveAllocationRow[],
) {
  if (base.changedRows.length === 0) return [];
  return sortedUnique(
    [...base.changedRows, ...relatedRows]
      .map((row) => row.bookingGuest.memberId)
      .filter((memberId): memberId is string => Boolean(memberId)),
  );
}

async function loadMoveState(
  base: MoveBaseState,
  db: MoveDb,
): Promise<MoveState> {
  const [relatedRows, custodianHolds, wholeLodgeHolds] = await Promise.all([
    loadRelatedRows(base, db),
    loadCustodianHolds(base, db),
    loadWholeLodgeHolds(base, db),
  ]);
  const memberIds = moveMemberIds(base, relatedRows);
  const [members, partnerLinks] = await Promise.all([
    memberIds.length === 0
      ? []
      : db.member.findMany({
          where: { id: { in: memberIds } },
          select: { id: true, active: true, ageTier: true, updatedAt: true },
          orderBy: { id: "asc" },
        }),
    memberIds.length < 2
      ? []
      : db.memberPartnerLink.findMany({
          where: {
            memberAId: { in: memberIds },
            memberBId: { in: memberIds },
          },
          select: {
            id: true,
            memberAId: true,
            memberBId: true,
            status: true,
            updatedAt: true,
          },
          orderBy: [{ memberAId: "asc" }, { memberBId: "asc" }],
        }),
  ]);

  const evaluated = evaluateMove({
    ...base,
    relatedRows,
    members,
    partnerLinks,
    memberIds,
    custodianHolds,
    wholeLodgeHolds,
  });
  return {
    ...base,
    relatedRows,
    members,
    partnerLinks,
    memberIds,
    custodianHolds,
    wholeLodgeHolds,
    ...evaluated,
  };
}

function evaluateMove(input: Omit<MoveState, "preview" | "targetSecondByAllocationId" | "promotionRows">) {
  const selectedIds = selectedIdSet(input);
  const membersById = new Map(input.members.map((member) => [member.id, member]));
  const partnerStatuses = new Map(
    input.partnerLinks.map((link) => [
      `${link.memberAId}\u0000${link.memberBId}`,
      link.status,
    ]),
  );
  const targetSecondByAllocationId = new Map<string, boolean>();
  const conflicts: BedAllocationMoveConflict[] = [];
  const promotionById = new Map<string, MoveAllocationRow>();

  for (const row of input.changedRows) {
    const night = dateKey(row.stayDate);
    if (!input.destination.active || !input.destination.room.active) {
      conflicts.push(
        conflict(
          row,
          "DESTINATION_UNAVAILABLE",
          "The destination bed or room is inactive.",
        ),
      );
    }
    if (input.destination.room.lodgeId !== row.bookingGuest.booking.lodgeId) {
      conflicts.push(
        conflict(
          row,
          "LODGE_MISMATCH",
          "The destination bed belongs to a different lodge than the booking.",
        ),
      );
    }
    if (
      row.booking.deletedAt ||
      row.bookingGuest.booking.deletedAt ||
      !BED_ALLOCATABLE_BOOKING_STATUSES.includes(
        row.booking.status as (typeof BED_ALLOCATABLE_BOOKING_STATUSES)[number],
      ) ||
      !BED_ALLOCATABLE_BOOKING_STATUSES.includes(
        row.bookingGuest.booking
          .status as (typeof BED_ALLOCATABLE_BOOKING_STATUSES)[number],
      ) ||
      row.booking.wholeLodgeHold ||
      row.bookingGuest.booking.wholeLodgeHold
    ) {
      conflicts.push(
        conflict(
          row,
          "BOOKING_NOT_ALLOCATABLE",
          "The booking is not eligible for per-bed allocation.",
        ),
      );
    }
    if (!guestStaysOn(row, row.stayDate)) {
      conflicts.push(
        conflict(
          row,
          "GUEST_NOT_STAYING",
          "The guest is not staying on this lodge night.",
        ),
      );
    }
    if (!isOperationallyPresentConsent(row.bookingGuest.consentStatus)) {
      conflicts.push(
        conflict(
          row,
          "GUEST_NOT_PRESENT",
          "The guest is not operationally present on the booking.",
        ),
      );
    }
    if (
      input.custodianHolds.some((hold) =>
        holdCoversNight(hold, night),
      )
    ) {
      conflicts.push(
        conflict(
          row,
          "CUSTODIAN_HOLD",
          "The destination bed is held for lodge staff on this night.",
        ),
      );
    }
    if (
      input.wholeLodgeHolds.some(
        (hold) =>
          isBlockingWholeLodgeHold(hold) &&
          wholeLodgeHoldCoversNight(
            {
              checkInKey: dateKey(hold.checkIn),
              checkOutKey: dateKey(hold.checkOut),
            },
            night,
          ),
      )
    ) {
      conflicts.push(
        conflict(
          row,
          "WHOLE_LODGE_HOLD",
          "A whole-lodge hold blocks per-bed placement on this night.",
        ),
      );
    }

    const roomOccupants = input.relatedRows.filter(
      (candidate) =>
        candidate.roomId === input.destination.roomId &&
        dateKey(candidate.stayDate) === night &&
        !selectedIds.has(candidate.id),
    );
    const movingAdult = isAdultAgeTier(row.bookingGuest.ageTier);
    if (
      roomOccupants.some(
        (occupant) =>
          occupant.bookingId !== row.bookingId &&
          isAdultAgeTier(occupant.bookingGuest.ageTier) !== movingAdult,
      )
    ) {
      conflicts.push(
        conflict(
          row,
          "ADULT_MINOR_MIX",
          "This move would mix an adult and a minor from different bookings in one room-night.",
        ),
      );
    }

    const destinationOccupants = roomOccupants.filter(
      (candidate) => candidate.bedId === input.destination.id,
    );
    // "Exactly one primary occupant" said as a first with no rest, so the
    // share check below holds the occupant itself (#2800).
    const [primary, ...extraOccupants] = destinationOccupants;
    if (primary === undefined) {
      targetSecondByAllocationId.set(row.id, false);
    } else if (
      input.destination.bedType !== "DOUBLE" ||
      extraOccupants.length > 0 ||
      primary.isSecondOccupant
    ) {
      conflicts.push(
        conflict(
          row,
          input.destination.bedType === "DOUBLE"
            ? "SHARED_DOUBLE_INELIGIBLE"
            : "BED_TAKEN",
          input.destination.bedType === "DOUBLE"
            ? "The destination double bed cannot accept another occupant on this night."
            : "The destination bed is already allocated on this night.",
        ),
      );
    } else {
      const movingMemberId = row.bookingGuest.memberId;
      const primaryMemberId = primary.bookingGuest.memberId;
      const movingMember = movingMemberId
        ? membersById.get(movingMemberId)
        : undefined;
      const primaryMember = primaryMemberId
        ? membersById.get(primaryMemberId)
        : undefined;
      const pair =
        movingMemberId &&
        primaryMemberId &&
        movingMemberId !== primaryMemberId
          ? canonicalPartnerPair(movingMemberId, primaryMemberId)
          : null;
      const linked = pair
        ? partnerStatuses.get(`${pair.memberAId}\u0000${pair.memberBId}`) ===
          PARTNER_LINK_CONFIRMED
        : false;
      const eligible =
        isCapacityHoldingBookingStatus(primary.booking.status) &&
        movingMember?.active === true &&
        movingMember.ageTier === "ADULT" &&
        primaryMember?.active === true &&
        primaryMember.ageTier === "ADULT" &&
        linked;
      if (eligible) {
        targetSecondByAllocationId.set(row.id, true);
      } else {
        conflicts.push(
          conflict(
            row,
            "SHARED_DOUBLE_INELIGIBLE",
            "Only active adult members with a confirmed partner relationship may share this double bed.",
          ),
        );
      }
    }

    if (!row.isSecondOccupant) {
      for (const candidate of input.relatedRows) {
        if (
          candidate.id !== row.id &&
          !selectedIds.has(candidate.id) &&
          candidate.bedId === row.bedId &&
          dateKey(candidate.stayDate) === night &&
          candidate.isSecondOccupant
        ) {
          promotionById.set(candidate.id, candidate);
        }
      }
    }
  }

  const promotionRows = [...promotionById.values()].sort(compareRows);
  const changed = input.changedRows
    .slice()
    .sort((left, right) =>
      dateKey(left.stayDate).localeCompare(dateKey(right.stayDate)) ||
      left.id.localeCompare(right.id),
    )
    .map(rowDetail);
  const unchanged = input.selectedRows
    .filter((row) => row.bedId === input.destination.id)
    .sort((left, right) =>
      dateKey(left.stayDate).localeCompare(dateKey(right.stayDate)) ||
      left.id.localeCompare(right.id),
    )
    .map(rowDetail);
  const sortedConflicts = conflicts.sort(
    (left, right) =>
      (left.stayDate ?? "").localeCompare(right.stayDate ?? "") ||
      left.allocationId.localeCompare(right.allocationId) ||
      left.code.localeCompare(right.code),
  );
  const previewWithoutDigest = {
    digestVersion: BED_ALLOCATION_MOVE_DIGEST_VERSION,
    scope: input.request.scope,
    anchor: {
      allocationId: input.anchor.id,
      guestName: personName(input.anchor.bookingGuest),
      stayDate: dateKey(input.anchor.stayDate),
    },
    destination: {
      bedId: input.destination.id,
      label: destinationLabel(input.destination),
      available: sortedConflicts.length === 0,
    },
    resolvedRowCount: input.selectedRows.length,
    changedRowCount: changed.length,
    unchangedRowCount: unchanged.length,
    approvedToDraftCount: input.changedRows.filter((row) => row.approvedAt)
      .length,
    changed,
    unchanged,
    promotions: promotionRows.map((row) => ({
      stayDate: dateKey(row.stayDate),
      bedName: row.bed.name,
    })),
    conflicts: sortedConflicts,
  } satisfies Omit<BedAllocationMovePreview, "digest">;

  const digest = digestMoveState(input, {
    targetSecondByAllocationId,
    promotionRows,
    conflicts: sortedConflicts,
  });
  return {
    targetSecondByAllocationId,
    promotionRows,
    preview: { ...previewWithoutDigest, digest },
  };
}

function digestMoveState(
  state: Omit<MoveState, "preview" | "targetSecondByAllocationId" | "promotionRows">,
  evaluation: {
    targetSecondByAllocationId: Map<string, boolean>;
    promotionRows: MoveAllocationRow[];
    conflicts: BedAllocationMoveConflict[];
  },
) {
  const canonical = {
    digestVersion: BED_ALLOCATION_MOVE_DIGEST_VERSION,
    identity: {
      scope: state.request.scope,
      anchorAllocationId: state.anchor.id,
      destinationBedId: state.destination.id,
      bookingId: state.anchor.bookingId,
      bookingGuestId: state.anchor.bookingGuestId,
      selectedAllocationIds: state.selectedRows.map((row) => row.id).sort(),
    },
    selectedRows: state.selectedRows.slice().sort(compareRows).map(canonicalAllocation),
    relatedRows: state.relatedRows.slice().sort(compareRows).map(canonicalAllocation),
    destination: {
      id: state.destination.id,
      roomId: state.destination.roomId,
      name: state.destination.name,
      active: state.destination.active,
      bedType: state.destination.bedType,
      updatedAt: timestamp(state.destination.updatedAt),
      room: {
        id: state.destination.room.id,
        name: state.destination.room.name,
        active: state.destination.room.active,
        lodgeId: state.destination.room.lodgeId,
        updatedAt: timestamp(state.destination.room.updatedAt),
      },
    },
    members: state.members.map((member) => ({
      ...member,
      updatedAt: timestamp(member.updatedAt),
    })),
    partnerLinks: state.partnerLinks.map((link) => ({
      ...link,
      updatedAt: timestamp(link.updatedAt),
    })),
    custodianHolds: state.custodianHolds
      .map((hold) => ({
        assignmentId: hold.assignmentId,
        memberId: hold.memberId,
        lodgeId: hold.lodgeId,
        bedId: hold.bedId,
        roomId: hold.roomId,
        startDate: hold.startDate,
        endDate: hold.endDate,
      }))
      .sort((left, right) => left.assignmentId.localeCompare(right.assignmentId)),
    wholeLodgeHolds: state.wholeLodgeHolds.map((hold) => ({
      id: hold.id,
      status: hold.status,
      lodgeId: hold.lodgeId,
      wholeLodgeHold: hold.wholeLodgeHold,
      checkIn: dateKey(hold.checkIn),
      checkOut: dateKey(hold.checkOut),
      adminCapacityHoldAt: timestamp(hold.adminCapacityHoldAt),
      originBookingRequestId: hold.originBookingRequest?.id ?? null,
      updatedAt: timestamp(hold.updatedAt),
    })),
    targetSecond: [...evaluation.targetSecondByAllocationId.entries()].sort(
      ([left], [right]) => left.localeCompare(right),
    ),
    promotions: evaluation.promotionRows.map(canonicalAllocation),
    conflicts: evaluation.conflicts,
  };
  const hash = createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
  return `${BED_ALLOCATION_MOVE_DIGEST_VERSION}:${hash}`;
}

export async function previewBedAllocationMove(
  request: BedAllocationMoveRequest,
  db: MoveDb = prisma,
): Promise<BedAllocationMovePreview> {
  const base = await loadMoveBase(request, db);
  return (await loadMoveState(base, db)).preview;
}

async function unavailablePreview(
  request: BedAllocationMoveRequest,
  db: MoveDb,
): Promise<BedAllocationMovePreview> {
  const [anchor, destination] = await Promise.all([
    db.bedAllocation.findUnique({
      where: { id: request.anchorAllocationId },
      include: moveAllocationInclude,
    }),
    db.lodgeBed.findUnique({
      where: { id: request.destinationBedId },
      include: destinationInclude,
    }),
  ]);
  const anchorUnavailable = anchor === null;
  const canonical = {
    digestVersion: BED_ALLOCATION_MOVE_DIGEST_VERSION,
    request,
    destination: destination
      ? {
          id: destination.id,
          roomId: destination.roomId,
          active: destination.active,
          bedType: destination.bedType,
          updatedAt: timestamp(destination.updatedAt),
          room: {
            id: destination.room.id,
            lodgeId: destination.room.lodgeId,
            active: destination.room.active,
            updatedAt: timestamp(destination.room.updatedAt),
          },
        }
      : null,
    anchorUnavailable,
  };
  const digest = `${BED_ALLOCATION_MOVE_DIGEST_VERSION}:${createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")}`;
  return {
    digestVersion: BED_ALLOCATION_MOVE_DIGEST_VERSION,
    digest,
    scope: request.scope,
    anchor: {
      allocationId: request.anchorAllocationId,
      guestName: null,
      stayDate: null,
    },
    destination: {
      bedId: request.destinationBedId,
      label: destination ? destinationLabel(destination) : "Unavailable bed",
      available: false,
    },
    resolvedRowCount: 0,
    changedRowCount: 0,
    unchangedRowCount: 0,
    approvedToDraftCount: 0,
    changed: [],
    unchanged: [],
    promotions: [],
    conflicts: [
      {
        allocationId: request.anchorAllocationId,
        stayDate: null,
        code: anchorUnavailable
          ? "ALLOCATION_UNAVAILABLE"
          : "DESTINATION_UNAVAILABLE",
        message: anchorUnavailable
          ? "The selected allocation is no longer available."
          : "The destination bed is no longer available.",
      },
    ],
  };
}

const MOVE_ROW_LOCK_CHUNK_SIZE = 10_000;

async function lockMoveRows(
  tx: Prisma.TransactionClient,
  rows: MoveAllocationRow[],
) {
  const ids = [...new Map(rows.sort(compareRows).map((row) => [row.id, row.id])).values()];
  for (let offset = 0; offset < ids.length; offset += MOVE_ROW_LOCK_CHUNK_SIZE) {
    const chunk = ids.slice(offset, offset + MOVE_ROW_LOCK_CHUNK_SIZE);
    await tx.$executeRaw`
      SELECT 1
      FROM "BedAllocation"
      WHERE "id" IN (${Prisma.join(chunk)})
      ORDER BY "bedId", "stayDate", "isSecondOccupant", "id"
      FOR UPDATE
    `;
  }
}

function bounded(values: string[]) {
  const sorted = sortedUnique(values);
  return {
    values: sorted.slice(0, MAX_AUDIT_IDENTITIES),
    omittedCount: Math.max(0, sorted.length - MAX_AUDIT_IDENTITIES),
  };
}

async function updateReviewedMoveRows(
  tx: Prisma.TransactionClient,
  rows: MoveAllocationRow[],
  state: MoveState,
): Promise<number> {
  const reviewedRows = Prisma.join(
    rows.map(
      (row) => Prisma.sql`(
        ${row.id}::text,
        ${row.bookingId}::text,
        ${row.bookingGuestId}::text,
        ${row.roomId}::text,
        ${row.bedId}::text,
        ${row.stayDate}::date,
        ${row.updatedAt}::timestamp(3),
        ${(state.targetSecondByAllocationId.get(row.id) ?? false)}::boolean
      )`,
    ),
  );
  return tx.$executeRaw`
    UPDATE "BedAllocation" AS allocation
    SET
      "roomId" = ${state.destination.roomId},
      "bedId" = ${state.destination.id},
      "source" = 'MANUAL'::"BedAllocationSource",
      "approvedAt" = NULL,
      "approvedByMemberId" = NULL,
      "isSecondOccupant" = reviewed."targetSecond",
      "bedType" = ${state.destination.bedType}::"BedType",
      "updatedAt" = CURRENT_TIMESTAMP
    FROM (VALUES ${reviewedRows}) AS reviewed(
      "id",
      "bookingId",
      "bookingGuestId",
      "roomId",
      "bedId",
      "stayDate",
      "updatedAt",
      "targetSecond"
    )
    WHERE allocation."id" = reviewed."id"
      AND allocation."bookingId" = reviewed."bookingId"
      AND allocation."bookingGuestId" = reviewed."bookingGuestId"
      AND allocation."roomId" = reviewed."roomId"
      AND allocation."bedId" = reviewed."bedId"
      AND allocation."stayDate" = reviewed."stayDate"
      AND allocation."updatedAt" = reviewed."updatedAt"
  `;
}

export async function applyBedAllocationMove(input: {
  request: BedAllocationMoveApplyRequest;
  actorMemberId: string;
}): Promise<BedAllocationMoveApplyResult> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

    let base: MoveBaseState;
    try {
      base = await loadMoveBase(input.request, tx);
    } catch (error) {
      if (
        error instanceof BedAllocationMoveError &&
        error.status === 404
      ) {
        throw new BedAllocationMoveError(
          "The move target is no longer available. Review the refreshed preview.",
          409,
          "STALE_PREVIEW",
          await unavailablePreview(input.request, tx),
        );
      }
      throw error;
    }

    // Global is already held, so this discovery cannot race another compliant
    // allocation writer. Include counterpart occupants and promotion rows,
    // then take the complete lodge family in one sorted pass.
    const discoveryRows = await loadRelatedRows(base, tx);
    const lockedLodgeIds = moveLodgeIds(base, discoveryRows);
    for (const lodgeId of lockedLodgeIds) {
      await acquireLodgeCapacityLock(tx, lodgeId);
    }

    const initial = await loadMoveState(base, tx);
    await acquireMemberLifecycleLocks(tx, initial.memberIds);
    await acquireMemberPartnerLinkLocks(tx, initial.memberIds);
    await lockMoveRows(tx, [...initial.selectedRows, ...initial.relatedRows]);

    let authoritativeBase: MoveBaseState;
    try {
      authoritativeBase = await loadMoveBase(input.request, tx);
    } catch (error) {
      if (error instanceof BedAllocationMoveError && error.status === 404) {
        throw new BedAllocationMoveError(
          "The move target is no longer available. Review the refreshed preview.",
          409,
          "STALE_PREVIEW",
          await unavailablePreview(input.request, tx),
        );
      }
      throw error;
    }
    const authoritative = await loadMoveState(authoritativeBase, tx);
    const unlockedLodges = moveLodgeIds(
      authoritativeBase,
      authoritative.relatedRows,
    ).filter((lodgeId) => !lockedLodgeIds.includes(lodgeId));
    if (unlockedLodges.length > 0) {
      throw new BedAllocationMoveError(
        "Allocation lodge state changed while the move was being reviewed.",
        409,
        "STALE_PREVIEW",
        authoritative.preview,
      );
    }
    if (
      authoritative.memberIds.some(
        (memberId) => !initial.memberIds.includes(memberId),
      )
    ) {
      throw new BedAllocationMoveError(
        "Allocation member state changed while the move was being reviewed.",
        409,
        "STALE_PREVIEW",
        authoritative.preview,
      );
    }
    if (authoritative.preview.digest !== input.request.previewDigest) {
      throw new BedAllocationMoveError(
        "The move preview is stale. Review the refreshed details before confirming again.",
        409,
        "STALE_PREVIEW",
        authoritative.preview,
      );
    }
    if (authoritative.preview.conflicts.length > 0) {
      throw new BedAllocationMoveError(
        "The reviewed move has conflicts. No allocations were moved.",
        409,
        "MOVE_CONFLICT",
        authoritative.preview,
      );
    }

    if (authoritative.changedRows.length === 0) {
      return {
        noop: true,
        movedRowCount: 0,
        promotedRowCount: 0,
        affectedNights: [],
      };
    }

    const orderedChanges = authoritative.changedRows.slice().sort(compareRows);
    const promotionAuditRows = authoritative.promotionRows.map((promoted) => {
      const causalMove = orderedChanges.find(
        (moved) =>
          !moved.isSecondOccupant &&
          moved.bedId === promoted.bedId &&
          dateKey(moved.stayDate) === dateKey(promoted.stayDate),
      );
      if (!causalMove) {
        throw new BedAllocationMoveError(
          "A shared-double promotion no longer has a matching moved primary. Nothing was moved.",
          409,
          "STALE_PREVIEW",
          authoritative.preview,
        );
      }
      return {
        allocationId: promoted.id,
        bookingId: promoted.bookingId,
        bookingGuestId: promoted.bookingGuestId,
        bedId: promoted.bedId,
        stayDate: dateKey(promoted.stayDate),
        causalMovedAllocationId: causalMove.id,
        causalMovedBookingId: causalMove.bookingId,
        causalMovedBookingGuestId: causalMove.bookingGuestId,
      };
    });
    const movedCount = await updateReviewedMoveRows(
      tx,
      orderedChanges,
      authoritative,
    );
    if (movedCount !== orderedChanges.length) {
      throw new BedAllocationMoveError(
        "An allocation changed while the move was applying. Nothing was moved.",
        409,
        "STALE_PREVIEW",
        authoritative.preview,
      );
    }

    if (authoritative.promotionRows.length > 0) {
      const promoted = await tx.bedAllocation.updateMany({
        where: {
          id: { in: authoritative.promotionRows.map((row) => row.id) },
          isSecondOccupant: true,
        },
        data: { isSecondOccupant: false },
      });
      if (promoted.count !== authoritative.promotionRows.length) {
        throw new BedAllocationMoveError(
          "A shared double changed while the move was applying. Nothing was moved.",
          409,
          "STALE_PREVIEW",
          authoritative.preview,
        );
      }
    }

    const allocationIds = bounded(orderedChanges.map((row) => row.id));
    const affectedNights = changedDateKeys(authoritative);
    const boundedNights = bounded(affectedNights);
    await createAuditLog(
      {
        action: "BED_ALLOCATION_MOVE_APPLIED",
        memberId: input.actorMemberId,
        targetId: authoritative.anchor.bookingId,
        entityType: "BedAllocationMove",
        category: "lodge",
        outcome: "success",
        summary: `${orderedChanges.length} allocation night${orderedChanges.length === 1 ? "" : "s"} moved through reviewed preview`,
        metadata: {
          digestVersion: authoritative.preview.digestVersion,
          previewDigest: authoritative.preview.digest,
          scope: input.request.scope,
          anchorAllocationId: authoritative.anchor.id,
          bookingId: authoritative.anchor.bookingId,
          bookingGuestId: authoritative.anchor.bookingGuestId,
          destinationBedId: authoritative.destination.id,
          movedRowCount: orderedChanges.length,
          approvedToDraftCount: authoritative.preview.approvedToDraftCount,
          promotedRowCount: authoritative.promotionRows.length,
          affectedNights: boundedNights.values,
          omittedAffectedNightCount: boundedNights.omittedCount,
          allocationIds: allocationIds.values,
          omittedAllocationIdCount: allocationIds.omittedCount,
          autoAllocationTriggered: false,
        },
      },
      tx,
    );

    if (authoritative.promotionRows.length > 0) {
      const promotedBookingIds = sortedUnique(
        promotionAuditRows.map((promotion) => promotion.bookingId),
      );
      const searchableBookingIds = promotedBookingIds.slice(
        0,
        MAX_SEARCHABLE_PROMOTED_BOOKING_IDS,
      );
      const boundedPromotions = promotionAuditRows.slice(0, MAX_AUDIT_IDENTITIES);
      await createAuditLog(
        {
          action: "BED_ALLOCATION_PARTNERS_PROMOTED",
          memberId: input.actorMemberId,
          targetId: authoritative.anchor.bookingId,
          entityType: "BedAllocation",
          category: "lodge",
          outcome: "success",
          summary: `${authoritative.promotionRows.length} shared-double occupant${authoritative.promotionRows.length === 1 ? "" : "s"} promoted after reviewed allocation move`,
          details: `Promoted partner bookings: ${searchableBookingIds.join(", ")}${promotedBookingIds.length > searchableBookingIds.length ? `. Showing ${searchableBookingIds.length} of ${promotedBookingIds.length} booking IDs; metadata.promotions contains a bounded sample of ${boundedPromotions.length} of ${promotionAuditRows.length} promotion records and omits ${promotionAuditRows.length - boundedPromotions.length}.` : ""}`,
          metadata: {
            movePreviewDigest: authoritative.preview.digest,
            promotedCount: authoritative.promotionRows.length,
            promotions: boundedPromotions,
            omittedPromotionCount:
              promotionAuditRows.length - boundedPromotions.length,
            promotionsTruncated:
              promotionAuditRows.length > MAX_AUDIT_IDENTITIES,
          },
        },
        tx,
      );
    }

    return {
      noop: false,
      movedRowCount: orderedChanges.length,
      promotedRowCount: authoritative.promotionRows.length,
      affectedNights,
    };
  }, { timeout: 30_000, maxWait: 10_000 });
}
