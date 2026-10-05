import "server-only";
import type { Prisma } from "@prisma/client";
import { formatCommitteeMemberPhone } from "@/lib/committee";
import { ownsOtherLodge } from "@/lib/other-lodges";
import { loadOwnedOtherLodgeNames } from "@/lib/servernz-settings";

/**
 * Keep the "Other Clubs" registry's booking-officer contact in step with whoever
 * currently holds the Booking Officer committee role.
 *
 * When a member is assigned (or removed from) the Booking Officer committee role,
 * the OtherLodge rows the central server says this club OWNS (#52) — or, until
 * it has said, whose `name` matches one of the club's own lodges — have their
 * bookingOfficerName / bookingOfficerEmail / bookingOfficerPhone (and, via Prisma's
 * `@updatedAt`, `updatedAt`) refreshed. Name and phone come from the assigned
 * member; the email is the ROLE's shared contact address (e.g. bookings@club), not
 * the member's personal email. This is what feeds the central-server distribution,
 * so partner clubs always see the current officer.
 *
 * CONSENT: only a holder the club has already published is used, and their phone
 * only when `showPhone` is set — the same gates the club's own public committee
 * page applies. See the note above the holder query for why, and for why
 * `contactable` is not among them.
 *
 * Role identity: the seeded Booking Officer role carries the stable key "bookings"
 * (a role's key never changes when its display name is edited). A club may rename
 * the role, so a role literally named "Booking Officer" is also honoured as a
 * fallback.
 */

const BOOKING_OFFICER_ROLE_KEY = "bookings";
const BOOKING_OFFICER_ROLE_NAME = "Booking Officer";

// The subset of the Prisma client this module touches. Accepting the narrow shape
// lets callers pass either `prisma` or an interactive-transaction client (`tx`).
type CommitteeSyncClient = Pick<
  Prisma.TransactionClient,
  "committeeRole" | "committeeAssignment" | "lodge" | "otherLodge" | "serverNzSettings"
>;

interface BookingOfficerContact {
  bookingOfficerName: string | null;
  bookingOfficerEmail: string | null;
  bookingOfficerPhone: string | null;
}

const EMPTY_CONTACT: BookingOfficerContact = {
  bookingOfficerName: null,
  bookingOfficerEmail: null,
  bookingOfficerPhone: null,
};

/** CommitteeRole ids that represent the Booking Officer (stable key or name). */
async function bookingOfficerRoleIds(
  db: CommitteeSyncClient,
): Promise<string[]> {
  const roles = await db.committeeRole.findMany({
    where: {
      OR: [
        { key: BOOKING_OFFICER_ROLE_KEY },
        { name: { equals: BOOKING_OFFICER_ROLE_NAME, mode: "insensitive" } },
      ],
    },
    select: { id: true },
  });
  return roles.map((role) => role.id);
}

/**
 * Recompute the current Booking Officer contact and write it into every OtherLodge
 * row that is the club's own.
 *
 * - The "current" holder is the active assignment ordered first (sortOrder asc,
 *   then earliest createdAt) — deterministic when more than one member holds it.
 * - With no active holder, the contact fields are cleared to null.
 * - Only rows whose stored contact actually differs are written, so `updatedAt` is
 *   bumped (and the row re-distributed) only on a genuine change.
 */
async function applyBookingOfficerContact(
  db: CommitteeSyncClient,
  roleIds: string[],
): Promise<{ updated: number; holderMemberId: string | null }> {
  // The SAME gates the club's own public committee page applies, and for the same
  // reason: this registry is redistributed to every connected club, so it must
  // never be broader than the page the member could already see themselves on.
  // `src/app/api/committee/route.ts` filters `isActive && published &&
  // committeeRole.isActive`, and `serializePublicCommitteeAssignment` emits the
  // phone only when `showPhone`.
  //
  // All three of `published`, `showPhone` and `contactable` are `@default(false)`
  // in the schema, so a newly created Booking Officer assignment starts NOT
  // published with the phone withheld. Selecting on `isActive` alone therefore
  // published a member's personal mobile nationally by default — the opposite of
  // what the club had chosen. `member.active` is here for the same class of
  // reason: a deactivated member must stop being published, not keep being sent.
  //
  // `contactable` is deliberately NOT a gate. It produces a `contactKey` for the
  // club's own contact form and gates neither the name nor the phone on the
  // public page, and the registry publishes no contact-form route — so honouring
  // it would make the national surface NARROWER than the local one rather than
  // equal to it, on a flag that is about a different mechanism.
  const holder = await db.committeeAssignment.findFirst({
    where: {
      committeeRoleId: { in: roleIds },
      isActive: true,
      published: true,
      committeeRole: { isActive: true },
      member: { active: true },
    },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: {
      memberId: true,
      // Whether the member consented to their phone being shown publicly.
      showPhone: true,
      // Email comes from the ROLE's shared contact address (e.g. bookings@club),
      // not the member's personal email; name and phone come from the member.
      committeeRole: { select: { contactEmail: true } },
      member: {
        select: {
          firstName: true,
          lastName: true,
          phoneCountryCode: true,
          phoneAreaCode: true,
          phoneNumber: true,
        },
      },
    },
  });

  const contact: BookingOfficerContact = holder
    ? {
        bookingOfficerName:
          `${holder.member.firstName} ${holder.member.lastName}`.trim() || null,
        bookingOfficerEmail: holder.committeeRole.contactEmail?.trim() || null,
        bookingOfficerPhone: holder.showPhone
          ? formatCommitteeMemberPhone(holder.member)
          : null,
      }
    : EMPTY_CONTACT;

  // WHICH ROWS ARE OURS. The central server's answer, when it has given one
  // (#52): the owned list on `ServerNzSettings`, read through the same rule the
  // admin edit route, the upload and the panel apply (`ownsOtherLodge`). That
  // closes the collision this block used to carry as a known limitation: a
  // `Lodge` is a BUILDING while an `OtherLodge` is a CLUB, so a club that named
  // one of its buildings exactly as another club's registry row had its booking
  // officer written into that club's row, and then uploaded. With the owned
  // list known, only rows the server names for this site are written, whatever
  // the buildings are called.
  //
  // UNTIL the server has said (not connected, never downloaded, or an older
  // server that does not send the list) the pre-#52 name rule stands: rows whose
  // name exactly matches one of the club's lodges — no normalisation, no case
  // folding — so the exposure above is bounded to a deliberate collision. A
  // stored list that is present but UNREADABLE writes nothing (fail closed, the
  // same answer the upload gives): the column is wrong, not the install new.
  const owned = await loadOwnedOtherLodgeNames(db);
  if (owned.unreadable) {
    return { updated: 0, holderMemberId: holder?.memberId ?? null };
  }
  let candidateNames: string[];
  if (owned.names !== null) {
    candidateNames = owned.names;
  } else {
    const lodges = await db.lodge.findMany({ select: { name: true } });
    candidateNames = [...new Set(lodges.map((lodge) => lodge.name))];
  }
  if (candidateNames.length === 0) {
    return { updated: 0, holderMemberId: holder?.memberId ?? null };
  }

  const rows = await db.otherLodge.findMany({
    where: { name: { in: candidateNames } },
    select: {
      id: true,
      name: true,
      bookingOfficerName: true,
      bookingOfficerEmail: true,
      bookingOfficerPhone: true,
    },
  });

  let updated = 0;
  for (const row of rows) {
    // The query above already selects by name; this is the ONE rule applied at
    // the write, so the decision is `ownsOtherLodge`'s and not the query's.
    if (owned.names !== null && !ownsOtherLodge(owned.names, row.name)) continue;
    if (
      row.bookingOfficerName === contact.bookingOfficerName &&
      row.bookingOfficerEmail === contact.bookingOfficerEmail &&
      row.bookingOfficerPhone === contact.bookingOfficerPhone
    ) {
      continue; // Unchanged — leave updatedAt (and distribution) untouched.
    }
    await db.otherLodge.update({
      where: { id: row.id },
      // Prisma's `@updatedAt` stamps `updatedAt` on this write.
      data: contact,
    });
    updated++;
  }

  return { updated, holderMemberId: holder?.memberId ?? null };
}

/**
 * Sync the OtherLodge booking-officer contact after a committee assignment change,
 * but ONLY when the mutated assignment belongs to the Booking Officer role — so
 * unrelated committee edits stay cheap. Pass the affected assignment's
 * `committeeRoleId`. Safe to run inside the caller's transaction.
 */
export async function syncBookingOfficerForRole(
  db: CommitteeSyncClient,
  committeeRoleId: string,
): Promise<{ updated: number; holderMemberId: string | null } | null> {
  const roleIds = await bookingOfficerRoleIds(db);
  if (!roleIds.includes(committeeRoleId)) return null;
  return applyBookingOfficerContact(db, roleIds);
}
