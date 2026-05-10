import "server-only";

import { randomBytes } from "crypto";
import { hash } from "bcryptjs";
import { ApplicationStatus, AgeTier, type MemberApplication } from "@prisma/client";
import { z } from "zod";
import { computeAgeTier, getSeasonStartDate } from "@/lib/age-tier";
import { logAudit } from "@/lib/audit";
import { hashActionToken, issueActionToken } from "@/lib/action-tokens";
import {
  sendAdminMembershipApplicationPendingEmail,
  sendMembershipApplicationApprovedEmail,
  sendMembershipApplicationRejectedEmail,
  sendNominationRequestEmail,
} from "@/lib/email";
import logger from "@/lib/logger";
import { copyStreetAddressToPostal } from "@/lib/member-address";
import { prisma } from "@/lib/prisma";
import { getSeasonYear } from "@/lib/utils";
import {
  findOrCreateXeroContact,
  isXeroConnected,
} from "@/lib/xero";
import {
  enqueueXeroEntranceFeeInvoiceOperation,
  processQueuedXeroOutboxOperations,
} from "@/lib/xero-operation-outbox";

const maxStr = (len: number) => z.string().max(len).optional().nullable();
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD format");

const applicationAddressSchema = z.object({
  streetAddressLine1: maxStr(200),
  streetAddressLine2: maxStr(200),
  streetCity: maxStr(200),
  streetRegion: maxStr(200),
  streetPostalCode: maxStr(20),
  streetCountry: maxStr(100),
  postalAddressLine1: maxStr(200),
  postalAddressLine2: maxStr(200),
  postalCity: maxStr(200),
  postalRegion: maxStr(200),
  postalPostalCode: maxStr(20),
  postalCountry: maxStr(100),
  postalSameAsPhysical: z.boolean().optional(),
});

const familyMemberSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  dateOfBirth: isoDateSchema,
});

export type ApplicationAddress = z.infer<typeof applicationAddressSchema>;
export type ApplicationFamilyMember = z.infer<typeof familyMemberSchema>;

export interface CreateMemberApplicationInput {
  applicantFirstName: string;
  applicantLastName: string;
  applicantEmail: string;
  applicantDateOfBirth?: string | null;
  phoneCountryCode?: string | null;
  phoneAreaCode?: string | null;
  phoneNumber?: string | null;
  address: ApplicationAddress;
  familyMembers: ApplicationFamilyMember[];
  nominator1Email: string;
  nominator2Email: string;
}

export class MembershipApplicationError extends Error {
  status: number;
  details?: Record<string, string[]>;

  constructor(message: string, status = 400, details?: Record<string, string[]>) {
    super(message);
    this.name = "MembershipApplicationError";
    this.status = status;
    this.details = details;
  }
}

interface VerifiedNominator {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}

type MembershipApplicationLookupClient = Pick<
  typeof prisma,
  "member" | "memberApplication"
>;

type MembershipApplicationLockClient = Pick<typeof prisma, "$executeRaw">;

function cleanString(value?: string | null) {
  return value?.replace(/[\r\n]/g, " ").trim() || "";
}

function cleanNullableString(value?: string | null) {
  const trimmed = cleanString(value);
  return trimmed || null;
}

function serializeApplicantPhone(parts: {
  phoneCountryCode?: string | null;
  phoneAreaCode?: string | null;
  phoneNumber?: string | null;
}) {
  return [parts.phoneCountryCode, parts.phoneAreaCode, parts.phoneNumber]
    .map((part) => cleanString(part))
    .filter(Boolean)
    .join(" ") || null;
}

function parseApplicantPhone(phone: string | null) {
  const trimmed = cleanNullableString(phone);
  if (!trimmed) {
    return {
      phoneCountryCode: null,
      phoneAreaCode: null,
      phoneNumber: null,
    };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length >= 3) {
    return {
      phoneCountryCode: parts[0] || null,
      phoneAreaCode: parts[1] || null,
      phoneNumber: parts.slice(2).join(" ") || null,
    };
  }

  return {
    phoneCountryCode: null,
    phoneAreaCode: null,
    phoneNumber: trimmed,
  };
}

export function parseApplicationAddress(raw: unknown): ApplicationAddress {
  if (raw == null) {
    return {
      streetAddressLine1: null,
      streetAddressLine2: null,
      streetCity: null,
      streetRegion: null,
      streetPostalCode: null,
      streetCountry: null,
      postalAddressLine1: null,
      postalAddressLine2: null,
      postalCity: null,
      postalRegion: null,
      postalPostalCode: null,
      postalCountry: null,
      postalSameAsPhysical: false,
    };
  }

  const parsed = applicationAddressSchema.safeParse(raw);
  if (!parsed.success) {
    throw new MembershipApplicationError("Stored application address is invalid", 500);
  }

  const {
    streetAddressLine1,
    streetAddressLine2,
    streetCity,
    streetRegion,
    streetPostalCode,
    streetCountry,
    postalAddressLine1,
    postalAddressLine2,
    postalCity,
    postalRegion,
    postalPostalCode,
    postalCountry,
    postalSameAsPhysical,
  } = parsed.data;

  const normalized = {
    streetAddressLine1: cleanNullableString(streetAddressLine1),
    streetAddressLine2: cleanNullableString(streetAddressLine2),
    streetCity: cleanNullableString(streetCity),
    streetRegion: cleanNullableString(streetRegion),
    streetPostalCode: cleanNullableString(streetPostalCode),
    streetCountry: cleanNullableString(streetCountry),
    postalAddressLine1: cleanNullableString(postalAddressLine1),
    postalAddressLine2: cleanNullableString(postalAddressLine2),
    postalCity: cleanNullableString(postalCity),
    postalRegion: cleanNullableString(postalRegion),
    postalPostalCode: cleanNullableString(postalPostalCode),
    postalCountry: cleanNullableString(postalCountry),
    postalSameAsPhysical: Boolean(postalSameAsPhysical),
  };

  if (normalized.postalSameAsPhysical) {
    return {
      ...normalized,
      ...copyStreetAddressToPostal({
        streetAddressLine1: normalized.streetAddressLine1,
        streetAddressLine2: normalized.streetAddressLine2,
        streetCity: normalized.streetCity,
        streetRegion: normalized.streetRegion,
        streetPostalCode: normalized.streetPostalCode,
        streetCountry: normalized.streetCountry,
      }),
    };
  }

  return normalized;
}

export function parseApplicationFamilyMembers(raw: unknown): ApplicationFamilyMember[] {
  if (raw == null) {
    return [];
  }

  const parsed = z.array(familyMemberSchema).safeParse(raw);
  if (!parsed.success) {
    throw new MembershipApplicationError("Stored family member details are invalid", 500);
  }

  return parsed.data.map((member) => ({
    firstName: cleanString(member.firstName),
    lastName: cleanString(member.lastName),
    dateOfBirth: member.dateOfBirth,
  }));
}

async function computeTier(dateOfBirth?: string | null) {
  if (!dateOfBirth) {
    return AgeTier.ADULT;
  }

  return computeAgeTier(new Date(dateOfBirth), getSeasonStartDate(getSeasonYear()));
}

async function verifyNominator(email: string): Promise<VerifiedNominator> {
  const seasonYear = getSeasonYear();
  const normalizedEmail = cleanString(email).toLowerCase();

  const nominator = await prisma.member.findFirst({
    where: {
      email: normalizedEmail,
      active: true,
      canLogin: true,
      role: { in: ["MEMBER", "ADMIN"] },
    },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      subscriptions: {
        where: {
          seasonYear,
          status: "PAID",
        },
        select: { id: true },
        take: 1,
      },
    },
  });

  if (!nominator || nominator.subscriptions.length === 0) {
    throw new MembershipApplicationError(
      `${normalizedEmail} is not an active, paid-up Tokoroa Alpine Club member`,
      422
    );
  }

  return {
    id: nominator.id,
    email: nominator.email,
    firstName: nominator.firstName,
    lastName: nominator.lastName,
  };
}

async function ensureApplicationCanBeCreated(
  applicantEmail: string,
  client: MembershipApplicationLookupClient = prisma
) {
  const normalizedEmail = cleanString(applicantEmail).toLowerCase();

  const [existingMember, existingApplication] = await Promise.all([
    client.member.findFirst({
      where: {
        email: normalizedEmail,
        canLogin: true,
      },
      select: { id: true },
    }),
    client.memberApplication.findFirst({
      where: {
        applicantEmail: normalizedEmail,
        status: {
          in: ["PENDING_NOMINATORS", "PENDING_ADMIN"],
        },
      },
      select: { id: true },
    }),
  ]);

  if (existingMember) {
    throw new MembershipApplicationError(
      "An active Tokoroa Alpine Club account already exists for this email address",
      409
    );
  }

  if (existingApplication) {
    throw new MembershipApplicationError(
      "There is already a membership application pending for this email address",
      409
    );
  }
}

function buildApplicationAddress(address: ApplicationAddress) {
  return parseApplicationAddress(address);
}

function buildResetToken() {
  return randomBytes(32).toString("hex");
}

function getApplicationDisplayName(
  application: Pick<MemberApplication, "applicantFirstName" | "applicantLastName">
) {
  return `${application.applicantFirstName} ${application.applicantLastName}`.trim();
}

function membershipApplicationLockKey(applicationId: string) {
  return `member-application:${applicationId}`;
}

function membershipApplicationApplicantLockKey(applicantEmail: string) {
  return `member-application-applicant:${applicantEmail}`;
}

async function lockMembershipApplication(
  tx: MembershipApplicationLockClient,
  applicationId: string
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${membershipApplicationLockKey(applicationId)}))`;
}

async function lockMembershipApplicationApplicant(
  tx: MembershipApplicationLockClient,
  applicantEmail: string
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${membershipApplicationApplicantLockKey(applicantEmail)}))`;
}

export async function createMemberApplication(input: CreateMemberApplicationInput) {
  const applicantFirstName = cleanString(input.applicantFirstName);
  const applicantLastName = cleanString(input.applicantLastName);
  const applicantEmail = cleanString(input.applicantEmail).toLowerCase();
  const nominator1Email = cleanString(input.nominator1Email).toLowerCase();
  const nominator2Email = cleanString(input.nominator2Email).toLowerCase();
  const applicantDateOfBirth = cleanNullableString(input.applicantDateOfBirth);
  const applicantPhone = serializeApplicantPhone(input);
  const applicantAddress = buildApplicationAddress(input.address);
  const familyMembers = parseApplicationFamilyMembers(input.familyMembers);

  if (!applicantFirstName || !applicantLastName) {
    throw new MembershipApplicationError("Applicant name is required", 422);
  }

  if (!applicantDateOfBirth) {
    throw new MembershipApplicationError("Applicant date of birth is required", 422, {
      applicantDateOfBirth: ["Applicant date of birth is required"],
    });
  }

  if (nominator1Email === nominator2Email) {
    throw new MembershipApplicationError("Please provide two different nominators", 422, {
      nominator2Email: ["Please provide two different nominators"],
    });
  }

  if (applicantEmail === nominator1Email || applicantEmail === nominator2Email) {
    throw new MembershipApplicationError("Applicants cannot nominate themselves", 422);
  }

  await ensureApplicationCanBeCreated(applicantEmail);

  const [nominator1, nominator2] = await Promise.all([
    verifyNominator(nominator1Email),
    verifyNominator(nominator2Email),
  ]);

  const token1 = issueActionToken();
  const token2 = issueActionToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const application = await prisma.$transaction(async (tx) => {
    await lockMembershipApplicationApplicant(tx, applicantEmail);
    await ensureApplicationCanBeCreated(applicantEmail, tx);

    const created = await tx.memberApplication.create({
      data: {
        applicantFirstName,
        applicantLastName,
        applicantEmail,
        applicantDateOfBirth: applicantDateOfBirth ? new Date(applicantDateOfBirth) : null,
        applicantPhone,
        applicantAddress,
        familyMembers,
        nominator1Email: nominator1.email,
        nominator2Email: nominator2.email,
        nominator1Id: nominator1.id,
        nominator2Id: nominator2.id,
      },
    });

    await tx.nominationToken.createMany({
      data: [
        {
          tokenHash: token1.tokenHash,
          applicationId: created.id,
          nominatorMemberId: nominator1.id,
          expiresAt,
        },
        {
          tokenHash: token2.tokenHash,
          applicationId: created.id,
          nominatorMemberId: nominator2.id,
          expiresAt,
        },
      ],
    });

    return created;
  });

  const applicantName = getApplicationDisplayName(application);
  const emailWarnings: string[] = [];

  await Promise.all([
    sendNominationRequestEmail({
      email: nominator1.email,
      nominatorName: nominator1.firstName,
      applicantName,
      token: token1.token,
      familyMemberCount: familyMembers.length,
      expiresAt,
    }).catch((err) => {
      logger.error({ err, applicationId: application.id, nominatorId: nominator1.id }, "Failed to send nomination email");
      emailWarnings.push(`Could not email ${nominator1.email}`);
    }),
    sendNominationRequestEmail({
      email: nominator2.email,
      nominatorName: nominator2.firstName,
      applicantName,
      token: token2.token,
      familyMemberCount: familyMembers.length,
      expiresAt,
    }).catch((err) => {
      logger.error({ err, applicationId: application.id, nominatorId: nominator2.id }, "Failed to send nomination email");
      emailWarnings.push(`Could not email ${nominator2.email}`);
    }),
  ]);

  logAudit({
    action: "MEMBERSHIP_APPLICATION_CREATED",
    targetId: application.id,
    details: JSON.stringify({
      applicantEmail,
      nominator1Id: nominator1.id,
      nominator2Id: nominator2.id,
      familyMemberCount: familyMembers.length,
    }),
  });

  return {
    application,
    emailWarnings,
  };
}

export async function confirmNomination(token: string, nominatorMemberId: string) {
  const normalizedToken = cleanString(token);
  if (!normalizedToken) {
    throw new MembershipApplicationError("Nomination token is required", 422);
  }
  const tokenHash = hashActionToken(normalizedToken);

  const current = await prisma.nominationToken.findUnique({
    where: { tokenHash },
    include: { application: true },
  });

  if (!current) {
    throw new MembershipApplicationError("This nomination link is invalid", 404);
  }

  if (current.nominatorMemberId !== nominatorMemberId) {
    throw new MembershipApplicationError("This nomination link is for a different member", 403);
  }

  if (current.expiresAt < new Date()) {
    throw new MembershipApplicationError("This nomination link has expired", 410);
  }

  if (current.application.status === ApplicationStatus.REJECTED) {
    throw new MembershipApplicationError("This application has already been rejected", 409);
  }

  if (current.application.status === ApplicationStatus.APPROVED) {
    return { application: current.application, movedToAdmin: false, alreadyConfirmed: true };
  }

  if (current.confirmedAt) {
    return { application: current.application, movedToAdmin: false, alreadyConfirmed: true };
  }

  const confirmedAt = new Date();

  const result = await prisma.$transaction(async (tx) => {
    await lockMembershipApplication(tx, current.applicationId);

    const latestToken = await tx.nominationToken.findUnique({
      where: { tokenHash },
      include: { application: true },
    });

    if (!latestToken) {
      throw new MembershipApplicationError("This nomination link is invalid", 404);
    }

    if (latestToken.nominatorMemberId !== nominatorMemberId) {
      throw new MembershipApplicationError("This nomination link is for a different member", 403);
    }

    if (latestToken.expiresAt < new Date()) {
      throw new MembershipApplicationError("This nomination link has expired", 410);
    }

    if (latestToken.application.status === ApplicationStatus.REJECTED) {
      throw new MembershipApplicationError("This application has already been rejected", 409);
    }

    if (latestToken.application.status === ApplicationStatus.APPROVED) {
      return {
        application: latestToken.application,
        movedToAdmin: false,
        alreadyConfirmed: true,
      };
    }

    if (latestToken.confirmedAt) {
      return {
        application: latestToken.application,
        movedToAdmin: false,
        alreadyConfirmed: true,
      };
    }

    await tx.nominationToken.update({
      where: { id: latestToken.id },
      data: { confirmedAt },
    });

    const isFirstNominator = latestToken.application.nominator1Id === latestToken.nominatorMemberId;
    const nextNominator1ConfirmedAt = isFirstNominator
      ? confirmedAt
      : latestToken.application.nominator1ConfirmedAt;
    const nextNominator2ConfirmedAt = isFirstNominator
      ? latestToken.application.nominator2ConfirmedAt
      : confirmedAt;
    const movedToAdmin =
      latestToken.application.status === ApplicationStatus.PENDING_NOMINATORS &&
      Boolean(nextNominator1ConfirmedAt && nextNominator2ConfirmedAt);

    const application = await tx.memberApplication.update({
      where: { id: latestToken.applicationId },
      data: {
        nominator1ConfirmedAt: nextNominator1ConfirmedAt,
        nominator2ConfirmedAt: nextNominator2ConfirmedAt,
        ...(movedToAdmin ? { status: ApplicationStatus.PENDING_ADMIN } : {}),
      },
    });

    return {
      application,
      movedToAdmin,
      alreadyConfirmed: false,
    };
  });

  logAudit({
    action: "MEMBERSHIP_APPLICATION_NOMINATION_CONFIRMED",
    memberId: nominatorMemberId,
    targetId: result.application.id,
    details: JSON.stringify({ movedToAdmin: result.movedToAdmin }),
  });

  if (result.movedToAdmin) {
    sendAdminMembershipApplicationPendingEmail({
      applicationId: result.application.id,
      applicantName: getApplicationDisplayName(result.application),
      applicantEmail: result.application.applicantEmail,
      familyMemberCount: parseApplicationFamilyMembers(result.application.familyMembers).length,
    }).catch((err) => {
      logger.error({ err, applicationId: result.application.id }, "Failed to send admin membership application alert");
    });
  }

  return result;
}

async function syncApprovedMembersToXero(memberIds: string[]) {
  const warnings: string[] = [];

  let connected = false;
  try {
    connected = await isXeroConnected();
  } catch {
    connected = false;
  }

  if (!connected) {
    return warnings;
  }

  for (const memberId of memberIds) {
    try {
      await findOrCreateXeroContact(memberId);
    } catch (err) {
      logger.error({ err, memberId }, "Failed to sync approved member to Xero");
      warnings.push(`Xero contact sync failed for member ${memberId.slice(0, 8)}`);
    }
  }

  return warnings;
}

export async function approveMemberApplication(
  applicationId: string,
  adminMemberId: string,
  adminNotes?: string | null
) {
  const application = await prisma.memberApplication.findUnique({
    where: { id: applicationId },
  });

  if (!application) {
    throw new MembershipApplicationError("Application not found", 404);
  }

  if (application.status !== ApplicationStatus.PENDING_ADMIN) {
    throw new MembershipApplicationError("Only applications pending admin review can be approved", 409);
  }

  if (!application.applicantDateOfBirth) {
    throw new MembershipApplicationError(
      "Applicant date of birth is required before approval",
      409
    );
  }

  const applicantPasswordHash = await hash(randomBytes(32).toString("hex"), 13);
  const passwordSetupToken = buildResetToken();
  const passwordSetupExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const approved = await prisma.$transaction(async (tx) => {
    await lockMembershipApplication(tx, applicationId);

    const lockedApplication = await tx.memberApplication.findUnique({
      where: { id: applicationId },
    });

    if (!lockedApplication) {
      throw new MembershipApplicationError("Application not found", 404);
    }

    if (lockedApplication.status !== ApplicationStatus.PENDING_ADMIN) {
      throw new MembershipApplicationError(
        "Only applications pending admin review can be approved",
        409
      );
    }

    if (!lockedApplication.applicantDateOfBirth) {
      throw new MembershipApplicationError(
        "Applicant date of birth is required before approval",
        409
      );
    }

    const address = parseApplicationAddress(lockedApplication.applicantAddress);
    const familyMembers = parseApplicationFamilyMembers(lockedApplication.familyMembers);
    const applicantPhone = parseApplicantPhone(lockedApplication.applicantPhone);
    const applicantAgeTier = await computeTier(
      lockedApplication.applicantDateOfBirth.toISOString().slice(0, 10)
    );
    // The application form captures the booking-gate profile details, so
    // approval counts as initial confirmation for the applicant and dependents.
    const profileConfirmedAt = new Date();

    const existing = await tx.member.findFirst({
      where: {
        email: lockedApplication.applicantEmail,
        canLogin: true,
      },
      select: { id: true },
    });

    if (existing) {
      throw new MembershipApplicationError(
        "A Tokoroa Alpine Club login already exists for this applicant email address",
        409
      );
    }

    const applicantMember = await tx.member.create({
      data: {
        email: lockedApplication.applicantEmail,
        passwordHash: applicantPasswordHash,
        emailVerified: true,
        firstName: lockedApplication.applicantFirstName,
        lastName: lockedApplication.applicantLastName,
        dateOfBirth: lockedApplication.applicantDateOfBirth,
        role: "MEMBER",
        ageTier: applicantAgeTier,
        active: true,
        canLogin: true,
        phoneCountryCode: applicantPhone.phoneCountryCode,
        phoneAreaCode: applicantPhone.phoneAreaCode,
        phoneNumber: applicantPhone.phoneNumber,
        streetAddressLine1: address.streetAddressLine1,
        streetAddressLine2: address.streetAddressLine2,
        streetCity: address.streetCity,
        streetRegion: address.streetRegion,
        streetPostalCode: address.streetPostalCode,
        streetCountry: address.streetCountry,
        postalAddressLine1: address.postalAddressLine1,
        postalAddressLine2: address.postalAddressLine2,
        postalCity: address.postalCity,
        postalRegion: address.postalRegion,
        postalPostalCode: address.postalPostalCode,
        postalCountry: address.postalCountry,
        profileCompletedAt: profileConfirmedAt,
        detailsConfirmedAt: profileConfirmedAt,
        onboardingConfirmedAt: profileConfirmedAt,
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
      },
    });

    await tx.member.update({
      where: { id: applicantMember.id },
      data: {
        detailsConfirmedByMemberId: applicantMember.id,
      },
    });

    let familyGroupId: string | null = null;
    if (familyMembers.length > 0) {
      const familyGroup = await tx.familyGroup.create({
        data: {
          name: `${lockedApplication.applicantLastName} Family`,
        },
        select: { id: true },
      });
      familyGroupId = familyGroup.id;

      await tx.familyGroupMember.create({
        data: {
          familyGroupId,
          memberId: applicantMember.id,
          role: "ADMIN",
        },
      });
    }

    const dependentMemberIds: string[] = [];
    for (const familyMember of familyMembers) {
      const dependentAgeTier = await computeTier(familyMember.dateOfBirth);
      const dependent = await tx.member.create({
        data: {
          email: lockedApplication.applicantEmail,
          passwordHash: applicantPasswordHash,
          emailVerified: true,
          firstName: familyMember.firstName,
          lastName: familyMember.lastName,
          dateOfBirth: new Date(familyMember.dateOfBirth),
          role: "MEMBER",
          ageTier: dependentAgeTier,
          active: true,
          canLogin: false,
          parentMemberId: applicantMember.id,
          inheritParentEmail: true,
          inheritEmailFromId: applicantMember.id,
          phoneCountryCode: applicantPhone.phoneCountryCode,
          phoneAreaCode: applicantPhone.phoneAreaCode,
          phoneNumber: applicantPhone.phoneNumber,
          streetAddressLine1: address.streetAddressLine1,
          streetAddressLine2: address.streetAddressLine2,
          streetCity: address.streetCity,
          streetRegion: address.streetRegion,
          streetPostalCode: address.streetPostalCode,
          streetCountry: address.streetCountry,
          postalAddressLine1: address.postalAddressLine1,
          postalAddressLine2: address.postalAddressLine2,
          postalCity: address.postalCity,
          postalRegion: address.postalRegion,
          postalPostalCode: address.postalPostalCode,
          postalCountry: address.postalCountry,
          profileCompletedAt: profileConfirmedAt,
          detailsConfirmedAt: profileConfirmedAt,
          detailsConfirmedByMemberId: applicantMember.id,
          onboardingConfirmedAt: profileConfirmedAt,
        },
        select: { id: true },
      });
      dependentMemberIds.push(dependent.id);

      if (familyGroupId) {
        await tx.familyGroupMember.create({
          data: {
            familyGroupId,
            memberId: dependent.id,
            role: "MEMBER",
          },
        });
      }
    }

    await tx.passwordResetToken.deleteMany({
      where: { memberId: applicantMember.id },
    });

    await tx.passwordResetToken.create({
      data: {
        tokenHash: hashActionToken(passwordSetupToken),
        memberId: applicantMember.id,
        expiresAt: passwordSetupExpiresAt,
      },
    });

    const updatedApplication = await tx.memberApplication.update({
      where: { id: lockedApplication.id },
      data: {
        status: ApplicationStatus.APPROVED,
        adminNotes: cleanNullableString(adminNotes),
        reviewedBy: adminMemberId,
        reviewedAt: new Date(),
      },
    });

    return {
      application: updatedApplication,
      applicantMember,
      createdMemberIds: [applicantMember.id, ...dependentMemberIds],
    };
  });

  const warnings = await syncApprovedMembersToXero(approved.createdMemberIds);

  try {
    const queuedEntranceFeeInvoice = await enqueueXeroEntranceFeeInvoiceOperation(
      approved.applicantMember.id,
      {
        createdByMemberId: adminMemberId,
      }
    );

    if (queuedEntranceFeeInvoice.queueOperationId && (await isXeroConnected())) {
      void processQueuedXeroOutboxOperations({ limit: 1 }).catch((err) => {
        logger.error(
          { err, memberId: approved.applicantMember.id },
          "Failed to kick Xero entrance fee outbox worker for approved application"
        );
      });
    }
  } catch (err) {
    logger.error(
      { err, memberId: approved.applicantMember.id },
      "Failed to queue entrance fee invoice for approved application"
    );
    warnings.push("Entrance fee invoice could not be queued automatically");
  }

  try {
    await sendMembershipApplicationApprovedEmail({
      email: approved.applicantMember.email,
      firstName: approved.applicantMember.firstName,
      token: passwordSetupToken,
      adminNotes: cleanNullableString(adminNotes),
    });
  } catch (err) {
    logger.error({ err, applicationId }, "Failed to send approved membership email");
    warnings.push("The approval email could not be sent automatically");
  }

  logAudit({
    action: "MEMBERSHIP_APPLICATION_APPROVED",
    memberId: adminMemberId,
    targetId: applicationId,
    details: JSON.stringify({
      applicantMemberId: approved.applicantMember.id,
      createdMemberCount: approved.createdMemberIds.length,
    }),
  });

  return {
    ...approved,
    warnings,
  };
}

export async function rejectMemberApplication(
  applicationId: string,
  adminMemberId: string,
  adminNotes?: string | null
) {
  const application = await prisma.memberApplication.findUnique({
    where: { id: applicationId },
  });

  if (!application) {
    throw new MembershipApplicationError("Application not found", 404);
  }

  if (application.status !== ApplicationStatus.PENDING_ADMIN) {
    throw new MembershipApplicationError("Only applications pending admin review can be rejected", 409);
  }

  const rejected = await prisma.$transaction(async (tx) => {
    await lockMembershipApplication(tx, applicationId);

    const lockedApplication = await tx.memberApplication.findUnique({
      where: { id: applicationId },
    });

    if (!lockedApplication) {
      throw new MembershipApplicationError("Application not found", 404);
    }

    if (lockedApplication.status !== ApplicationStatus.PENDING_ADMIN) {
      throw new MembershipApplicationError(
        "Only applications pending admin review can be rejected",
        409
      );
    }

    return tx.memberApplication.update({
      where: { id: applicationId },
      data: {
        status: ApplicationStatus.REJECTED,
        adminNotes: cleanNullableString(adminNotes),
        reviewedBy: adminMemberId,
        reviewedAt: new Date(),
      },
    });
  });

  try {
    await sendMembershipApplicationRejectedEmail({
      email: rejected.applicantEmail,
      firstName: rejected.applicantFirstName,
      adminNotes: cleanNullableString(adminNotes),
    });
  } catch (err) {
    logger.error({ err, applicationId }, "Failed to send rejected membership email");
  }

  logAudit({
    action: "MEMBERSHIP_APPLICATION_REJECTED",
    memberId: adminMemberId,
    targetId: applicationId,
    details: JSON.stringify({
      applicantEmail: rejected.applicantEmail,
    }),
  });

  return rejected;
}
