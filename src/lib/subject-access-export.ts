import "server-only";
import { bookingPromoRedemptions } from "@/lib/booking-promo-redemptions";
import { prisma } from "@/lib/prisma";
import { formatDateOnly } from "@/lib/date-only";
import { clubTime } from "@/lib/club-time/server";
import { getClubFormat } from "@/lib/club-format-settings";
import { seasonSelectLabel } from "@/lib/season-label";
import { buildMemberVisibleAuditLogWhere } from "@/lib/audit-query";
import { readDeclaredMemberText } from "@/lib/audit-member-disclosure";
import { readSubjectAccessGuestDietary, readMemberDietaryRequirements, readOwnBookingGuestDietaryForExport, type DietaryAccessGrant } from "@/lib/member-dietary";
import { buildSubjectAccessSections } from "@/lib/subject-access-export-sections";
import { SUBJECT_ACCESS_EXPORT_EXCLUSIONS } from "@/lib/subject-access-export-coverage";

/**
 * Who a subject access export is about (#4915). A member by id; a non-member
 * by the email they gave on a booking request or application; a non-member
 * guest by the exact id of their guest row, which holds no email address.
 */
export type SubjectAccessSubject = { memberId: string } | { email: string } | { guestId: string };

/**
 * THE one builder behind the member's own download and the Full Admin subject
 * access report (`INV-PRIV-023`). Every section reads only the subject's own
 * rows, and `exclusions` names every personal model left out and why, from
 * `SUBJECT_ACCESS_EXPORT_COVERAGE`. `null` when the subject holds no record.
 */
export async function buildSubjectAccessExport(
  subject: SubjectAccessSubject,
  exportGrant: DietaryAccessGrant,
) {
  const format = await getClubFormat();
  const envelope = {
    exportedAt: new Date().toISOString(),
    // Every `*Cents` field in the file is an integer number of cents in this currency.
    currency: format.currencyCode,
    amountUnit: "integer cents",
    exclusions: SUBJECT_ACCESS_EXPORT_EXCLUSIONS,
  };
  if (!("memberId" in subject)) {
    const sections = await buildSubjectAccessSections(subject);
    if (!holdsNonMemberRecords(sections)) return null;
    return {
      ...envelope,
      subjectKind: "non-member" as const,
      ...EMPTY_MEMBER_RECORDS,
      ...sections,
      choreAssignments: "guestId" in subject ? await readGuestChores({ id: subject.guestId, memberId: null }) : [],
      guestDietaryRequirements: await readSubjectAccessGuestDietary(exportGrant),
    };
  }
  const records = await readMemberRecords(subject.memberId, exportGrant);
  if (!records) return null;
  return {
    ...envelope,
    subjectKind: "member" as const,
    ...records,
    ...(await buildSubjectAccessSections({ memberId: subject.memberId, email: records.profile.email })),
  };
}

/** The member-only records a non-member's file carries empty, so it keeps one shape. */
const EMPTY_MEMBER_RECORDS = {
  profile: null,
  bookings: [],
  choreAssignments: [],
  subscriptions: [],
  auditLog: [],
  auditLogTotal: 0,
} as const;

function holdsNonMemberRecords(sections: Awaited<ReturnType<typeof buildSubjectAccessSections>>): boolean {
  return [
    sections.guestAppearances,
    sections.bookingRequests,
    sections.applications,
    sections.emailLog,
    sections.emailSuppressions,
  ].some((rows) => rows.length > 0);
}

/** The original export's reads (profile, own bookings, chores, subscriptions, activity, dietary), unchanged in scope. */
async function readMemberRecords(memberId: string, exportGrant: DietaryAccessGrant) {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: {
      firstName: true,
      lastName: true,
      email: true,
      phoneCountryCode: true,
      phoneAreaCode: true,
      phoneNumber: true,
      dateOfBirth: true,
      streetAddressLine1: true,
      streetAddressLine2: true,
      streetCity: true,
      streetRegion: true,
      streetPostalCode: true,
      streetCountry: true,
      postalAddressLine1: true,
      postalAddressLine2: true,
      postalCity: true,
      postalRegion: true,
      postalPostalCode: true,
      postalCountry: true,
      role: true,
      ageTier: true,
      active: true,
      joinedDate: true,
      createdAt: true,
    },
  });

  if (!member) {
    return null;
  }

  // #2941 (INV-PRIV-022): the member's OWN stored dietary/allergy value, read
  // through the one dietary door and included EVEN WHILE THE CLUB HAS THE
  // FIELD OFF (owner decision, 20 Sep 2026): the export discloses what is held
  // about the subject, and telling them is self disclosure, not egress.

  const dietaryRequirements = await readMemberDietaryRequirements(
    exportGrant,
    memberId,
  );
  // #3029: and the per-stay values held on the subject's OWN guest rows, on
  // the same terms (ON or OFF). A separate key on purpose: the `bookings`
  // list below carries OTHER people's guest rows too, and their values are
  // not the subject's data, so nothing is added to it.
  const ownBookingDietaryRequirements =
    await readOwnBookingGuestDietaryForExport(exportGrant);

  // Bookings with guests, payment, and promo redemption
  const bookings = await prisma.booking.findMany({
    where: { memberId: memberId, deletedAt: null },
    orderBy: { checkIn: "desc" },
    select: {
      checkIn: true,
      checkOut: true,
      status: true,
      totalPriceCents: true,
      discountCents: true,
      finalPriceCents: true,
      hasNonMembers: true,
      nonMemberHoldUntil: true,
      notes: true,
      createdAt: true,
      // DELIBERATELY NOT CONSENT-FILTERED (owner decision D-12, #2307).
      //
      // D-12 keeps an unconsented guest off every OPERATIONAL surface — the
      // kiosk, the roster, bed allocation, the arrival emails, the wall. A
      // data-subject export is not one: it is this member's own record of
      // their own bookings, and a row we are holding about them (including one
      // still awaiting their guest's consent, which is holding a bed under
      // D-4) belongs in it. Hiding it would make the export a summary rather
      // than a disclosure.
      //
      // `consentStatus` is exported for the same reason: the honest answer to
      // "what do you hold about me" includes WHICH state each guest row is in,
      // not just that it exists.
      guests: {
        select: {
          firstName: true,
          lastName: true,
          ageTier: true,
          isMember: true,
          priceCents: true,
          consentStatus: true,
        },
      },
      payment: {
        select: {
          amountCents: true,
          status: true,
          refundedAmountCents: true,
          createdAt: true,
        },
      },
      promoRedemptions: {
        select: {
          id: true,
          applicationOrder: true,
          discountCents: true,
          createdAt: true,
          promoCode: { select: { code: true } },
        },
      },
    },
  });

  // Chore assignments (via bookings)
  const choreAssignments = await prisma.choreAssignment.findMany({
    where: {
      booking: { memberId: memberId, deletedAt: null },
      bookingGuestId: null, // assignments linked to the booking (not a specific guest)
    },
    select: {
      date: true,
      status: true,
      completedAt: true,
      createdAt: true,
      choreTemplate: {
        select: { name: true, description: true },
      },
      bookingGuest: {
        select: { firstName: true, lastName: true },
      },
    },
    orderBy: { date: "desc" },
  });

  // Also get chore assignments linked to this member's guest appearances
  const guestChoreAssignments = await readGuestChores({ memberId });

  // Subscriptions
  const subscriptions = await prisma.memberSubscription.findMany({
    where: { memberId: memberId },
    orderBy: { seasonYear: "desc" },
    select: {
      seasonYear: true,
      status: true,
      paidAt: true,
      createdAt: true,
    },
  });

  // The same subject-scoped, member-visible activity as their own timeline.
  const auditEntries = await prisma.auditLog.findMany({
    where: buildMemberVisibleAuditLogWhere(memberId),
    orderBy: { createdAt: "desc" },
    select: {
      action: true,
      // `metadata`, NOT `details` (#2695, `INV-PRIV-018`). This file is a
      // member-facing channel like the member's own timeline, so it reads the
      // same declaration and nothing else: the sentence the writing site
      // declared for this member, or nothing. `details` is the officers'
      // record — a deletion-decline note typed under "do not notify the
      // member", the credit approval's internal ids — and it used to arrive
      // here verbatim, with no category filter and no audience test.
      metadata: true,
      createdAt: true,
    },
  });

  // The club's own season-label format (#2870, INV-CONFIG-002).
  const club = await clubTime();
  return {
    profile: {
      firstName: member.firstName,
      lastName: member.lastName,
      email: member.email,
      phoneCountryCode: member.phoneCountryCode ?? null,
      phoneAreaCode: member.phoneAreaCode ?? null,
      phoneNumber: member.phoneNumber ?? null,
      dateOfBirth: member.dateOfBirth
        ? formatDateOnly(member.dateOfBirth)
        : null,
      role: member.role,
      ageTier: member.ageTier,
      active: member.active,
      joinedDate: member.joinedDate
        ? formatDateOnly(member.joinedDate)
        : null,
      memberSince: member.createdAt.toISOString(),
      dietaryRequirements,
      bookingDietaryRequirements: ownBookingDietaryRequirements.map((row) => ({
        stayStart: formatDateOnly(row.stayStart),
        stayEnd: formatDateOnly(row.stayEnd),
        dietaryRequirements: row.dietaryRequirements,
      })),
      streetAddress: {
        addressLine1: member.streetAddressLine1 ?? null,
        addressLine2: member.streetAddressLine2 ?? null,
        city: member.streetCity ?? null,
        region: member.streetRegion ?? null,
        postalCode: member.streetPostalCode ?? null,
        country: member.streetCountry ?? null,
      },
      postalAddress: {
        addressLine1: member.postalAddressLine1 ?? null,
        addressLine2: member.postalAddressLine2 ?? null,
        city: member.postalCity ?? null,
        region: member.postalRegion ?? null,
        postalCode: member.postalPostalCode ?? null,
        country: member.postalCountry ?? null,
      },
    },
    bookings: bookings.map((b) => ({
      checkIn: formatDateOnly(b.checkIn),
      checkOut: formatDateOnly(b.checkOut),
      status: b.status,
      totalPriceCents: b.totalPriceCents,
      discountCents: b.discountCents,
      finalPriceCents: b.finalPriceCents,
      hasNonMembers: b.hasNonMembers,
      nonMemberHoldUntil: b.nonMemberHoldUntil
        ? b.nonMemberHoldUntil.toISOString()
        : null,
      notes: b.notes ?? null,
      createdAt: b.createdAt.toISOString(),
      guests: b.guests.map((g) => ({
        firstName: g.firstName,
        lastName: g.lastName,
        ageTier: g.ageTier,
        isMember: g.isMember,
        priceCents: g.priceCents,
        // #2307: null for every ordinary guest — a non-member, a family-scope
        // add, or any row written before member guests existed. A value means
        // the row is a cross-family member guest and names where its consent
        // stands.
        consentStatus: g.consentStatus ?? null,
      })),
      payment: b.payment
        ? {
            amountCents: b.payment.amountCents,
            status: b.payment.status,
            refundedAmountCents: b.payment.refundedAmountCents,
            createdAt: b.payment.createdAt.toISOString(),
          }
        : null,
      promoDiscount: memberExportPromoDiscount(bookingPromoRedemptions(b)),
    })),
    choreAssignments: [
      ...choreAssignments.map((c) => ({
        date: formatDateOnly(c.date),
        choreName: c.choreTemplate.name,
        choreDescription: c.choreTemplate.description ?? null,
        assignedTo: c.bookingGuest
          ? `${c.bookingGuest.firstName} ${c.bookingGuest.lastName}`
          : "You",
        status: c.status,
        completedAt: c.completedAt ? c.completedAt.toISOString() : null,
        createdAt: c.createdAt.toISOString(),
      })),
      ...guestChoreAssignments,
    ],
    subscriptions: subscriptions.map((s) => ({
      seasonYear: s.seasonYear,
      seasonLabel: seasonSelectLabel(s.seasonYear, club.format),
      status: s.status,
      paidAt: s.paidAt ? s.paidAt.toISOString() : null,
      createdAt: s.createdAt.toISOString(),
    })),
    // Every entry, never a silent cap (#4915): the count states it.
    auditLogTotal: auditEntries.length,
    auditLog: auditEntries.map((a) => ({
      action: a.action,
      // The field keeps its name and its place: what changed is that its
      // value is now the DECLARED sentence rather than the stored column
      // (#2695). A row that declares nothing — every row written before this
      // release included — exports `null` here, which is what the member's
      // own timeline shows them for the same row.
      details: readDeclaredMemberText(a.metadata),
      createdAt: a.createdAt.toISOString(),
    })),
  };
}

/**
 * A booking's promo discount in the member's export (#3826). One code reads
 * exactly as it always did; several (one per code) are summed, applied when the
 * first of them was, and (#3828) listed one entry per code, naming it, in the
 * booker's order.
 */
function memberExportPromoDiscount(
  redemptions: ReadonlyArray<{
    discountCents: number;
    createdAt: Date;
    promoCode: { code: string } | null;
  }>,
): {
  discountCents: number;
  appliedAt: string;
  codes?: Array<{ code: string | null; discountCents: number; appliedAt: string }>;
} | null {
  if (redemptions.length === 0) return null;
  const appliedAt = redemptions.reduce(
    (earliest, redemption) =>
      redemption.createdAt < earliest ? redemption.createdAt : earliest,
    redemptions[0]!.createdAt,
  );
  return {
    discountCents: redemptions.reduce((sum, redemption) => sum + redemption.discountCents, 0),
    appliedAt: appliedAt.toISOString(),
    ...(redemptions.length > 1
      ? {
          codes: redemptions.map((redemption) => ({
            code: redemption.promoCode?.code ?? null,
            discountCents: redemption.discountCents,
            appliedAt: redemption.createdAt.toISOString(),
          })),
        }
      : {}),
  };
}

async function readGuestChores(guestWhere: { memberId: string } | { id: string; memberId: null }) {
  const rows = await prisma.choreAssignment.findMany({
    where: {
      bookingGuest: guestWhere,
    },
    select: {
      date: true,
      status: true,
      completedAt: true,
      createdAt: true,
      choreTemplate: {
        select: { name: true, description: true },
      },
      bookingGuest: {
        select: { firstName: true, lastName: true },
      },
    },
    orderBy: { date: "desc" },
  });
  return rows.map((c) => ({
    date: formatDateOnly(c.date),
    choreName: c.choreTemplate.name,
    choreDescription: c.choreTemplate.description ?? null,
    assignedTo: c.bookingGuest ? `${c.bookingGuest.firstName} ${c.bookingGuest.lastName}` : "You",
    status: c.status,
    completedAt: c.completedAt ? c.completedAt.toISOString() : null,
    createdAt: c.createdAt.toISOString(),
  }));
}
