import "server-only";

import { readAdditionalSubjectRecords } from "@/lib/subject-access-export-additional";
import { prisma } from "@/lib/prisma";

/** Explicit projections prevent credential columns and other participants' snapshots escaping. */
export async function buildSubjectAccessSections(subject: { memberId?: string; email?: string; guestId?: string }) {
  const { memberId, email, guestId } = subject;
  // Never use an undefined filter: it means every row to Prisma.
  const own = memberId ?? "";
  const address = email ? { equals: email, mode: "insensitive" as const } : { equals: "" };
  const guestWhere = memberId ? { memberId } : guestId ? { id: guestId, memberId: null } : { id: "" };
  const guestAppearances = await prisma.bookingGuest.findMany({
    where: guestWhere,
    select: { id: true, firstName: true, lastName: true, ageTier: true, isMember: true,
      stayStart: true, stayEnd: true, priceCents: true, consentStatus: true,
      booking: { select: { checkIn: true, checkOut: true, lodge: { select: { name: true } } } },
      nights: { select: { stayDate: true, priceCents: true } },
    },
  });
  const bookingRequests = await prisma.bookingRequest.findMany({
    where: memberId ? { requestedByMemberId: own } : email ? { contactEmail: address } : { id: "" },
    select: { id: true, contactFirstName: true, contactLastName: true, contactEmail: true,
      contactPhone: true, checkIn: true, checkOut: true, message: true, status: true,
      responseMessage: true, createdAt: true },
  });
  if (!memberId) return { guestAppearances, bookingRequests, additionalRecords: {}, credits: [], creditBalanceCents: 0,
    familyGroups: [], partnerLinks: [], applications: [], refundRequests: [], cancellationRequests: [],
    changeRequests: [], inductions: [], notificationPreferences: [], emailLog: [], emailSuppressions: [],
    hutLeaderAssignments: [], issueReports: [], maintenanceReports: [], posts: [], photos: [], moneyLines: [], accessRoles: [] };
  const credits = await prisma.memberCredit.findMany({ where: { memberId: own },
    select: { id: true, amountCents: true, type: true, createdAt: true,
      sourceBookingId: true, appliedToBookingId: true,
      noteAllocations: { select: { amountCents: true, appliedToBookingId: true, createdAt: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const familyGroups = await prisma.familyGroupMember.findMany({ where: { memberId: own },
    select: { joinedAt: true, familyGroup: { select: { id: true, name: true,
      memberships: { select: { member: { select: { id: true, firstName: true, lastName: true } } } } } } },
  });
  const partnerLinks = await prisma.memberPartnerLink.findMany({ where: { OR: [{ memberAId: own }, { memberBId: own }] },
    select: { memberAId: true, memberBId: true, status: true, createdAt: true } });
  const applications = await prisma.memberApplication.findMany({ where: { applicantEmail: address },
    select: { id: true, applicantFirstName: true, applicantLastName: true, applicantEmail: true,
      applicantDateOfBirth: true, applicantPhone: true, applicantAddress: true, status: true, createdAt: true } });
  const refundRequests = await prisma.refundRequest.findMany({ where: { memberId: own },
    select: { id: true, bookingId: true, reason: true, requestedAmountCents: true, approvedAmountCents: true, status: true, createdAt: true } });
  const cancellationRequests = await prisma.membershipCancellationRequestParticipant.findMany({ where: { memberId: own },
    select: { status: true, reason: true, confirmedAt: true, cancelledAt: true,
      request: { select: { id: true, status: true, submittedAt: true, completedAt: true } } } });
  const changeRequests = await prisma.bookingChangeRequest.findMany({ where: { requestedByMemberId: own },
    select: { id: true, bookingId: true, kind: true, status: true, reason: true, memberMessage: true, createdAt: true } });
  const inductions = await prisma.memberInduction.findMany({ where: { memberId: own },
    select: { id: true, kind: true, status: true, inductionDate: true, completedAt: true, requiredSignOffs: true,
      signOffs: { select: { signerName: true, signerRole: true, signedAt: true, declarationAccepted: true } },
      assignedSigners: { select: { memberId: true } } } });
  const notificationPreferences = await prisma.notificationPreference.findMany({ where: { memberId: own } });
  const emailLog = await prisma.emailLog.findMany({ where: { to: address },
    select: { subject: true, templateName: true, status: true, sentAt: true, createdAt: true, attempts: true } });
  const emailSuppressions = await prisma.emailSuppression.findMany({ where: { email: address },
    select: { reason: true, eventCount: true, suppressedAt: true, clearedAt: true } });
  const hutLeaderAssignments = await prisma.hutLeaderAssignment.findMany({ where: { memberId: own },
    select: { startDate: true, endDate: true, lodgeId: true, isCustodian: true } });
  const issueReports = await prisma.issueReport.findMany({ where: { memberId: own },
    select: { id: true, description: true, createdAt: true, resolvedAt: true } });
  const maintenanceReports = await prisma.maintenanceReport.findMany({ where: { memberId: own },
    select: { id: true, summary: true, status: true, createdAt: true,
      answers: { select: { questionId: true, answerText: true } } } });
  const posts = await prisma.clubPost.findMany({ where: { authorMemberId: own },
    select: { id: true, content: true, postedAt: true } });
  const photos = await prisma.mediaImage.findMany({ where: { photoOfMembers: { some: { id: own } } },
    select: { contentType: true, data: true, altText: true } });
  const moneyLines = await prisma.memberMoneyLine.findMany({ where: { memberId: own },
    select: { account: true, side: true, amountCents: true, grossCents: true, netCents: true, taxCents: true,
      journal: { select: { currency: true, event: { select: { effectiveDate: true, recordedAt: true } } } } } });
  const accessRoles = await prisma.memberAccessRole.findMany({ where: { memberId: own }, select: { role: true, createdAt: true } });
  return { additionalRecords: await readAdditionalSubjectRecords(own), guestAppearances, bookingRequests, credits, creditBalanceCents: credits.reduce((sum, row) => sum + row.amountCents, 0),
    familyGroups, partnerLinks, applications, refundRequests, cancellationRequests, changeRequests, inductions,
    notificationPreferences, emailLog, emailSuppressions, hutLeaderAssignments, issueReports, maintenanceReports,
    posts, photos: photos.map(({ data, ...photo }) => ({ ...photo, base64: Buffer.from(data).toString("base64") })), moneyLines, accessRoles };
}
