import type { OtherLodge, Prisma } from "@prisma/client";

// Helpers for the external / partner lodge registry (Admin -> Lodges). These
// rows are NOT the club's own lodges (see @/lib/lodges) — they carry no slug,
// booking capacity, scoping, or relations. `bedCapacity` is informational only.
// The registry will feed a non-member "which lodge are you a member of"
// drop-down (follow-up), which is why the name column is unique.

export const otherLodgeSelect = {
  id: true,
  name: true,
  location: true,
  bookingOfficerName: true,
  bookingOfficerEmail: true,
  bookingOfficerPhone: true,
  bedCapacity: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.OtherLodgeSelect;

export type OtherLodgeRecord = Pick<OtherLodge, keyof typeof otherLodgeSelect>;

export interface SerializedOtherLodge {
  id: string;
  name: string;
  location: string | null;
  bookingOfficerName: string | null;
  bookingOfficerEmail: string | null;
  bookingOfficerPhone: string | null;
  bedCapacity: number | null;
  createdAt: string;
  updatedAt: string;
}

export function serializeOtherLodge(
  lodge: OtherLodgeRecord,
): SerializedOtherLodge {
  return {
    id: lodge.id,
    name: lodge.name,
    location: lodge.location,
    bookingOfficerName: lodge.bookingOfficerName,
    bookingOfficerEmail: lodge.bookingOfficerEmail,
    bookingOfficerPhone: lodge.bookingOfficerPhone,
    bedCapacity: lodge.bedCapacity,
    createdAt: lodge.createdAt.toISOString(),
    updatedAt: lodge.updatedAt.toISOString(),
  };
}

// Alphabetical: the registry is presented as a name-first list and will back a
// name-ordered drop-down. Tie-break on id so paging/order is deterministic.
export function otherLodgeOrderBy() {
  return [{ name: "asc" }, { id: "asc" }] satisfies Prisma.OtherLodgeOrderByWithRelationInput[];
}

// Trim to a stored value, folding blank/whitespace-only input to null so an
// "empty" optional field never persists as "".
export function normalizeOtherLodgeText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
