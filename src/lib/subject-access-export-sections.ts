import "server-only";

import { getMemberCreditBalance } from "@/lib/member-credit";
import { formatDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";
import { readAdditionalSubjectRecords } from "@/lib/subject-access-export-additional";

/**
 * Who the sections are read for. A member is keyed by id (and their own email,
 * for records filed by address). A non-member is keyed by the email they gave
 * on an application or booking request, or by the exact id of their guest row:
 * a guest row holds no email, so it is never matched from anyone's address.
 */
export type SubjectAccessKey =
  | { readonly memberId: string; readonly email: string | null }
  | { readonly email: string }
  | { readonly guestId: string };

/**
 * The subject-only sections beyond the original export's profile, bookings,
 * chores, subscriptions and activity (#4915). Every read is filtered to the
 * subject and every projection is explicit, so a credential column or another
 * person's fields never leave by default.
 */
export async function buildSubjectAccessSections(key: SubjectAccessKey) {
  const memberId = "memberId" in key ? key.memberId : null;
  const email = "email" in key ? key.email : null;
  const address = email ? { equals: email, mode: "insensitive" as const } : null;

  const [guestAppearances, bookingRequests, applications, emailLog, emailSuppressions] = await Promise.all([
    readGuestAppearances(memberId ? { memberId } : "guestId" in key ? { id: key.guestId, memberId: null } : null),
    // A member's requests are the ones they sent signed in; a non-member's are
    // the ones sent from their address.
    memberId || address
      ? prisma.bookingRequest.findMany({
          where: memberId ? { requestedByMemberId: memberId } : { contactEmail: address! },
          orderBy: { createdAt: "asc" },
          select: {
            type: true, status: true, contactFirstName: true, contactLastName: true, contactEmail: true,
            contactPhone: true, checkIn: true, checkOut: true, message: true, schoolName: true,
            indicativePriceCents: true, priceCents: true, acceptedPriceCents: true,
            declineReason: true, responseMessage: true, createdAt: true,
          },
        })
      : [],
    address
      ? prisma.memberApplication.findMany({
          where: { applicantEmail: address },
          orderBy: { createdAt: "asc" },
          select: {
            applicantFirstName: true, applicantLastName: true, applicantEmail: true,
            applicantDateOfBirth: true, applicantPhone: true, applicantAddress: true,
            status: true, reviewedAt: true, createdAt: true,
          },
        })
      : [],
    address
      ? prisma.emailLog.findMany({
          where: { to: address },
          orderBy: { createdAt: "asc" },
          select: { subject: true, templateName: true, status: true, sentAt: true, createdAt: true },
        })
      : [],
    address
      ? prisma.emailSuppression.findMany({
          where: { email: address },
          select: { reason: true, eventCount: true, suppressedAt: true, lastEventAt: true, clearedAt: true },
        })
      : [],
  ]);

  const shared = {
    guestAppearances,
    bookingRequests: bookingRequests.map((request) => ({
      ...request,
      checkIn: formatDateOnly(request.checkIn),
      checkOut: formatDateOnly(request.checkOut),
    })),
    applications: applications.map((application) => ({
      ...application,
      applicantDateOfBirth: application.applicantDateOfBirth
        ? formatDateOnly(application.applicantDateOfBirth)
        : null,
    })),
    emailLog,
    emailSuppressions,
  };
  if (!memberId) return { ...shared, ...emptyMemberSections() };
  return { ...shared, ...(await readMemberSections(memberId)) };
}

async function readGuestAppearances(where: { memberId: string } | { id: string; memberId: null } | null) {
  if (!where) return [];
  // The subject's OWN guest row on any booking, theirs or someone else's, with
  // that booking's dates and lodge only: never the booker or a co-guest.
  const rows = await prisma.bookingGuest.findMany({
    where,
    orderBy: [{ stayStart: "asc" }, { id: "asc" }],
    select: {
      firstName: true, lastName: true, ageTier: true, isMember: true,
      stayStart: true, stayEnd: true, priceCents: true, consentStatus: true,
      arrivedAt: true, departedAt: true, createdAt: true,
      booking: { select: { checkIn: true, checkOut: true, status: true, lodge: { select: { name: true } } } },
      nights: { orderBy: { stayDate: "asc" }, select: { stayDate: true, priceCents: true } },
    },
  });
  return rows.map(({ booking, nights, ...guest }) => ({
    ...guest,
    stayStart: formatDateOnly(guest.stayStart),
    stayEnd: formatDateOnly(guest.stayEnd),
    booking: {
      checkIn: formatDateOnly(booking.checkIn),
      checkOut: formatDateOnly(booking.checkOut),
      status: booking.status,
      lodge: booking.lodge.name,
    },
    nights: nights.map((night) => ({ stayDate: formatDateOnly(night.stayDate), priceCents: night.priceCents })),
  }));
}

async function readMemberSections(memberId: string) {
  const [
    accessRoles, credits, creditBalanceCents, familyGroups, partnerLinks, refundRequests,
    cancellationRequests, changeRequests, inductions, notificationPreferences, hutLeaderAssignments,
    issueReports, maintenanceReports, posts, photos, moneyLines, additionalRecords,
  ] = await Promise.all([
    prisma.memberAccessRole.findMany({
      where: { memberId },
      select: { role: true, roleDefinition: { select: { name: true } }, createdAt: true },
    }),
    prisma.memberCredit.findMany({
      where: { memberId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        amountCents: true, type: true, description: true, createdAt: true,
        sourceBookingId: true, appliedToBookingId: true,
        noteAllocations: { select: { amountCents: true, appliedToBookingId: true, createdAt: true } },
      },
    }),
    getMemberCreditBalance(memberId),
    // The link itself (the group and the other members' names), never their records.
    prisma.familyGroupMember.findMany({
      where: { memberId },
      select: {
        joinedAt: true,
        familyGroup: {
          select: {
            name: true,
            memberships: { select: { member: { select: { firstName: true, lastName: true } } } },
          },
        },
      },
    }),
    prisma.memberPartnerLink.findMany({
      where: { OR: [{ memberAId: memberId }, { memberBId: memberId }] },
      select: {
        memberAId: true, status: true, confirmedAt: true, createdAt: true,
        memberA: { select: { firstName: true, lastName: true } },
        memberB: { select: { firstName: true, lastName: true } },
      },
    }),
    prisma.refundRequest.findMany({
      where: { memberId },
      select: {
        bookingId: true, reason: true, requestedAmountCents: true, approvedAmountCents: true,
        status: true, reviewedAt: true, createdAt: true,
      },
    }),
    prisma.membershipCancellationRequestParticipant.findMany({
      where: { memberId },
      select: {
        status: true, reason: true, confirmedAt: true, declinedAt: true, cancelledAt: true, createdAt: true,
        request: { select: { status: true, submittedAt: true, completedAt: true } },
      },
    }),
    prisma.bookingChangeRequest.findMany({
      where: { requestedByMemberId: memberId },
      select: {
        bookingId: true, kind: true, status: true, reason: true, memberMessage: true,
        reviewedAt: true, cancelledAt: true, createdAt: true,
      },
    }),
    prisma.memberInduction.findMany({
      where: { memberId },
      select: {
        kind: true, status: true, inductionDate: true, completedAt: true, requiredSignOffs: true, createdAt: true,
        signOffs: { select: { signerName: true, signerRole: true, signedAt: true, declarationAccepted: true } },
      },
    }),
    prisma.notificationPreference.findMany({ where: { memberId }, omit: { id: true, memberId: true } }),
    prisma.hutLeaderAssignment.findMany({
      where: { memberId },
      select: { startDate: true, endDate: true, isCustodian: true, lodge: { select: { name: true } } },
    }),
    prisma.issueReport.findMany({
      where: { memberId },
      select: { pageUrl: true, pageTitle: true, description: true, createdAt: true, resolvedAt: true },
    }),
    prisma.maintenanceReport.findMany({
      where: { memberId },
      select: {
        summary: true, status: true, reporterName: true, reporterContact: true, createdAt: true, resolvedAt: true,
        lodge: { select: { name: true } },
        answers: { select: { questionId: true, answerText: true } },
      },
    }),
    prisma.clubPost.findMany({
      where: { authorMemberId: memberId },
      select: { authorName: true, content: true, postedAt: true, hiddenAt: true, removedAt: true },
    }),
    prisma.mediaImage.findMany({
      where: { photoOfMembers: { some: { id: memberId } } },
      select: { contentType: true, altText: true, data: true, createdAt: true },
    }),
    prisma.memberMoneyLine.findMany({
      where: { memberId },
      select: {
        account: true, side: true, amountCents: true, grossCents: true, netCents: true, taxCents: true, bookingId: true,
        journal: { select: { currency: true, event: { select: { effectiveDate: true, recordedAt: true } } } },
      },
    }),
    readAdditionalSubjectRecords(memberId),
  ]);

  return {
    accessRoles: accessRoles.map((row) => ({
      role: row.role ?? row.roleDefinition?.name ?? null,
      createdAt: row.createdAt,
    })),
    credits,
    creditBalanceCents,
    familyGroups: familyGroups.map((row) => ({
      name: row.familyGroup.name,
      joinedAt: row.joinedAt,
      members: row.familyGroup.memberships.map(({ member }) => `${member.firstName} ${member.lastName}`),
    })),
    partnerLinks: partnerLinks.map((link) => {
      const partner = link.memberAId === memberId ? link.memberB : link.memberA;
      return {
        partner: `${partner.firstName} ${partner.lastName}`,
        status: link.status,
        confirmedAt: link.confirmedAt,
        createdAt: link.createdAt,
      };
    }),
    refundRequests,
    cancellationRequests,
    changeRequests,
    inductions,
    notificationPreferences,
    hutLeaderAssignments: hutLeaderAssignments.map((row) => ({
      startDate: formatDateOnly(row.startDate),
      endDate: formatDateOnly(row.endDate),
      isCustodian: row.isCustodian,
      lodge: row.lodge.name,
    })),
    issueReports,
    maintenanceReports: maintenanceReports.map(({ lodge, ...report }) => ({ ...report, lodge: lodge.name })),
    posts,
    photos: photos.map(({ data, ...photo }) => ({ ...photo, base64: Buffer.from(data).toString("base64") })),
    moneyLines,
    additionalRecords,
  };
}

/** A non-member has no member-keyed records: the same keys, empty, so the file keeps one shape. */
function emptyMemberSections() {
  return {
    accessRoles: [], credits: [], creditBalanceCents: null, familyGroups: [], partnerLinks: [],
    refundRequests: [], cancellationRequests: [], changeRequests: [], inductions: [],
    notificationPreferences: [], hutLeaderAssignments: [], issueReports: [], maintenanceReports: [],
    posts: [], photos: [], moneyLines: [], additionalRecords: null,
  };
}
