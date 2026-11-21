/** Member identity and lodge checks shared by the preview and locked writer. */
import { AgeTier } from "@prisma/client";

import {
  BOOKING_IMPORT_PART_PAID_REFUSAL,
  type BookingImportPersonName,
  type ParsedImportBooking,
} from "@/lib/booking-import/parse";
import type {
  BookingImportContext,
  BookingImportDb,
  BookingImportLodge,
  BookingImportRefusal,
  ResolvedImportBooking,
  ResolvedImportGuest,
} from "@/lib/booking-import/plan";
import { parseDateOnly } from "@/lib/date-only";
import { memberImportIdentityKey } from "@/lib/member-import-identity";

type ImportMember = {
  id: string;
  ageTier: AgeTier;
  active: boolean;
  cancelledAt: Date | null;
  archivedAt: Date | null;
};

/**
 * Members by the member import's identity key (`INV-SSOT`). Deleted members are
 * never matched; a cancelled, archived or inactive one is matched and refused.
 */
export async function loadBookingImportMembers(
  db: BookingImportDb,
  bookings: readonly ParsedImportBooking[],
): Promise<Map<string, ImportMember[]>> {
  const emails = new Set<string>();
  for (const booking of bookings) {
    if (booking.owner.email) emails.add(booking.owner.email.toLowerCase());
    for (const guest of booking.guests) {
      if (guest.isMember && guest.identity.email) emails.add(guest.identity.email.toLowerCase());
    }
  }
  const byKey = new Map<string, ImportMember[]>();
  if (emails.size === 0) return byKey;
  const members = await db.member.findMany({
    where: { email: { in: [...emails], mode: "insensitive" }, deletedAt: null },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      ageTier: true,
      active: true,
      cancelledAt: true,
      archivedAt: true,
    },
    orderBy: { id: "asc" },
  });
  for (const member of members) {
    const key = memberImportIdentityKey(member);
    const list = byKey.get(key) ?? [];
    list.push(member);
    byKey.set(key, list);
  }
  return byKey;
}

export async function loadBookingImportLodge(
  db: BookingImportDb,
  lodgeId: string,
): Promise<{ lodge: BookingImportLodge | null; activeLodgeCount: number }> {
  const [lodge, activeLodgeCount] = await Promise.all([
    db.lodge.findUnique({
      where: { id: lodgeId },
      select: { id: true, name: true, slug: true, active: true },
    }),
    db.lodge.count({ where: { active: true } }),
  ]);
  return { lodge, activeLodgeCount };
}

function refusalOf(parserReason: string): BookingImportRefusal {
  return {
    code: parserReason === BOOKING_IMPORT_PART_PAID_REFUSAL ? "PART_PAID" : "UNREADABLE",
    message: parserReason,
  };
}

function lodgeRefusals(
  booking: ParsedImportBooking,
  context: Pick<BookingImportContext, "lodge" | "activeLodgeCount">,
): BookingImportRefusal[] {
  if (!context.lodge.active) {
    return [{ code: "LODGE", message: "The lodge is not open for bookings" }];
  }
  const cell = booking.lodge.toLowerCase();
  if (!cell) {
    return context.activeLodgeCount > 1
      ? [{ code: "LODGE", message: "Lodge is needed when the club has more than one lodge" }]
      : [];
  }
  return cell === context.lodge.name.toLowerCase() || cell === context.lodge.slug.toLowerCase()
    ? []
    : [{ code: "LODGE", message: "Lodge names a different lodge from the one being imported into" }];
}

function matchMember(
  members: Map<string, ImportMember[]>,
  person: BookingImportPersonName,
  who: string,
): { member: ImportMember } | { refusal: BookingImportRefusal } {
  const matches = members.get(memberImportIdentityKey(person)) ?? [];
  if (matches.length === 0) {
    return { refusal: { code: "MEMBER", message: `${who} matches no member` } };
  }
  if (matches.length > 1) {
    return { refusal: { code: "MEMBER", message: `${who} matches more than one member` } };
  }
  const member = matches[0]!;
  if (!member.active || member.cancelledAt || member.archivedAt) {
    return { refusal: { code: "MEMBER", message: `${who} is not a current member` } };
  }
  return { member };
}

/**
 * The file's own facts about one booking: whether it can be read, the lodge it
 * names, and who its people are. No booking, capacity or rule read.
 */
export function resolveImportBooking(
  booking: ParsedImportBooking,
  context: Pick<BookingImportContext, "lodge" | "activeLodgeCount">,
  members: Map<string, ImportMember[]>,
): { resolved: ResolvedImportBooking | null; refusals: BookingImportRefusal[] } {
  if (booking.refusals.length > 0) {
    return { resolved: null, refusals: booking.refusals.map(refusalOf) };
  }
  const refusals = lodgeRefusals(booking, context);
  const owner = matchMember(members, booking.owner, `The owner on line ${booking.firstLineNumber}`);
  if ("refusal" in owner) refusals.push(owner.refusal);

  const guests: ResolvedImportGuest[] = [];
  const lineByMemberId = new Map<string, number>();
  for (const guest of booking.guests) {
    let memberId: string | null = null;
    let ageTier = guest.ageTier;
    if (guest.isMember) {
      const match = matchMember(members, guest.identity, `The guest on line ${guest.lineNumber}`);
      if ("refusal" in match) {
        refusals.push(match.refusal);
        continue;
      }
      memberId = match.member.id;
      ageTier = match.member.ageTier;
      const earlier = lineByMemberId.get(memberId);
      if (earlier !== undefined) {
        refusals.push({
          code: "MEMBER",
          message: `Lines ${earlier} and ${guest.lineNumber} are the same member`,
        });
        continue;
      }
      lineByMemberId.set(memberId, guest.lineNumber);
    }
    guests.push({
      lineNumber: guest.lineNumber,
      firstName: guest.identity.firstName,
      lastName: guest.identity.lastName,
      // The parser leaves a non-member's tier null only when it refused the row.
      ageTier: ageTier ?? AgeTier.ADULT,
      isMember: guest.isMember,
      memberId,
      stayStart: parseDateOnly(guest.checkIn),
      stayEnd: parseDateOnly(guest.checkOut),
      priceCents: guest.amountCents,
    });
  }
  if (refusals.length > 0 || "refusal" in owner) return { resolved: null, refusals };
  return {
    resolved: {
      bookingRef: booking.bookingRef,
      ownerMemberId: owner.member.id,
      checkIn: parseDateOnly(booking.checkIn),
      checkOut: parseDateOnly(booking.checkOut),
      totalCents: booking.totalCents,
      notes: booking.notes,
      guests,
    },
    refusals: [],
  };
}
