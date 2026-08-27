import "server-only";

import { randomBytes } from "crypto";
import { hash } from "bcryptjs";
import {
  ApplicationStatus,
  AgeTier,
  Prisma,
  type MemberApplication,
} from "@prisma/client";
import { z } from "zod";
import { computeAgeTier, getSeasonStartDate } from "@/lib/age-tier";
import { logAudit } from "@/lib/audit";
import { hashActionToken, issueActionToken } from "@/lib/action-tokens";
import {
  sendAdminMembershipApplicationPendingEmail,
  sendInductionSignOffRequestEmail,
  sendMembershipApplicationApprovedEmail,
  sendMembershipApplicationRejectedEmail,
  sendNominationRequestEmail,
} from "@/lib/email";
import { createMemberInduction } from "@/lib/induction";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { resolveMembershipTypePolicyForMember } from "@/lib/membership-type-policy";
import logger from "@/lib/logger";
import { copyStreetAddressToPostal } from "@/lib/member-address";
import {
  checkParentLinkDepthAndCycle,
  describeParentSideDepth,
  exceedsFamilyLinkGenerationLimit,
  FAMILY_LINK_GENERATION_LIMIT_ERROR,
} from "@/lib/member-family-link-depth";
import {
  reconcileEmailInheritanceForMemberChange,
  validateInheritEmailSource,
} from "@/lib/member-email-inheritance";
import {
  NO_INHERITABLE_EMAIL_SOURCE_MESSAGE,
  resolveInheritedEmailSourceId,
} from "@/lib/member-parent-links";
import { checkNominatorEligibility } from "@/lib/nominator-eligibility";
import { prisma } from "@/lib/prisma";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { clubSeasonYear } from "@/lib/financial-year";
import { queueApprovedMembershipSubscriptionCharges } from "@/lib/membership-subscription-billing";
import { MEMBER_LEVEL_ROLE_VALUES } from "@/lib/member-roles";
import {
  findOrCreateXeroContact,
  isXeroConnected,
} from "@/lib/xero";
import {
  enqueueXeroEntranceFeeInvoiceOperation,
  processQueuedXeroOutboxOperations,
} from "@/lib/xero-operation-outbox";
import { nameField } from "@/lib/zod-helpers";
import { CLUB_NAME } from "@/config/club-identity";
import {
  refKey,
  resolvePersonDecisions,
  type PersonDecisions,
} from "@/lib/member-application-decisions";
import {
  computeApprovalMappingOutcomes,
  getLoginHolderIdForEmail,
  loadApprovalMappingTargets,
  loadMappingAgeTierSettings,
  verifyApprovalMappingPreviewToken,
  type MappingApplicationInput,
  type MappingTargetRecord,
  type PersonOutcome,
} from "@/lib/member-application-mapping";
// Pure age-tier math for the mapping path: the approval transaction reads
// AgeTierSetting through `tx` (loadMappingAgeTierSettings) and computes tiers
// with the settings variant, bypassing the 5-minute cache in @/lib/age-tier so
// the written tier always equals the tokenized preview outcome (#1936).
import { computeAgeTierWithSettings } from "@/lib/policies/age-tier";
import { isFullAdmin } from "@/lib/access-roles";
import {
  NOMINATION_AUTOMATIC_REMINDER_LIMIT,
  getNominationTokenExpiryDate,
} from "@/lib/nomination-token-policy";
import { formatDateOnly } from "@/lib/date-only";
import { clubToday, dateOnlyInstantOf, type CalendarDate } from "@/lib/club-time";
import {
  applicationDateOfBirthDay,
  dependentSubject,
  unreadableDateOfBirthRefusal,
} from "@/lib/member-application-date-of-birth";

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
  firstName: nameField(),
  lastName: nameField(),
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

export type EntranceFeeInvoiceApprovalDecision =
  | {
      action: "CREATE";
      amountCents?: number | null;
      narration?: string | null;
    }
  | {
      action: "SKIP";
      reason: string;
    };

export type NominatorSlot = "nominator1" | "nominator2";

function cleanString(value?: string | null) {
  return value?.replace(/[\r\n]/g, " ").trim() || "";
}

function cleanNullableString(value?: string | null) {
  const trimmed = cleanString(value);
  return trimmed || null;
}

function appendPostApprovalWarnings(
  adminNotes: string | null | undefined,
  warnings: string[]
) {
  if (warnings.length === 0) {
    return cleanNullableString(adminNotes);
  }

  const warningBlock = [
    "Post-approval follow-up warnings:",
    ...warnings.map((warning) => `- ${warning}`),
  ].join("\n");
  const existingNotes = cleanNullableString(adminNotes);

  return existingNotes
    ? `${existingNotes}\n\n${warningBlock}`
    : warningBlock;
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

export function parseApplicantPhone(phone: string | null) {
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

/**
 * `seasonStart` is passed in, and that is a CONCURRENCY requirement rather than a
 * style (#2870, correctness review).
 *
 * Both callers are inside `approveMemberApplication`'s transaction, which holds
 * `pg_advisory_xact_lock('member-application:<id>')` plus one
 * `member-lifecycle:<memberId>` lock per MAP target — and the second caller is
 * inside a `for` loop over the family members. Resolving the club's zone here
 * would put an UNCACHED `ClubTimeSettings` read, on the global client and so a
 * second pool connection, under those locks once per person. `booking-request.ts`
 * records the judgement in its own words: a settings query under them buys
 * nothing.
 *
 * It also removes a straddle. `approveMemberApplication` ALREADY resolves the
 * club's season before opening the transaction and derives `mappingSeasonStart`
 * from it, so a self-resolving `computeTier` meant the MAP path and the all-CREATE
 * path could answer from two different seasons in one approval — the shape this
 * lane closed on the admin member page and the bulk role change.
 */
async function computeTier(
  dateOfBirth: CalendarDate | null,
  seasonStart: Date,
) {
  if (!dateOfBirth) {
    return AgeTier.ADULT;
  }

  // `dateOnlyInstantOf`, not `new Date(dateOfBirth)`: the argument is a validated
  // calendar day, and the encoder is the one spelling `computeAge`'s
  // stored-calendar-day precondition accepts on every host (#3082).
  return computeAgeTier(dateOnlyInstantOf(dateOfBirth), seasonStart);
}

async function verifyNominator(email: string): Promise<VerifiedNominator> {
  const seasonYear = clubSeasonYear(await readClubTimeZoneOutsideRequest());
  const normalizedEmail = cleanString(email).toLowerCase();

  const nominator = await prisma.member.findFirst({
    where: {
      email: normalizedEmail,
      active: true,
      canLogin: true,
      role: { in: [...MEMBER_LEVEL_ROLE_VALUES, "ADMIN"] },
    },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      joinedDate: true,
      createdAt: true,
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

  // The identity gates (active / canLogin / member-level role) are enforced by
  // the query above, so a missing candidate is always a genuinely ineligible
  // email — reject it before any paid-up reasoning.
  if (!nominator) {
    throw new MembershipApplicationError(
      `${normalizedEmail} is not an active, paid-up ${CLUB_NAME} member`,
      422
    );
  }

  // Paid-up determination aligns the nominator check with the booking side
  // (E14 #1944): a membership type whose subscriptionBehavior is NOT_REQUIRED
  // (Life, honorary) is paid-up-equivalent with no PAID subscription row, the
  // same precedent booking-member-guest-subscriptions.ts already honours via
  // resolveMembershipTypePoliciesForMembers. Every other type still requires a
  // current-season PAID subscription exactly as before.
  //
  // DELIBERATELY NARROW: the booking side ALSO exempts un-subscribed junior age
  // tiers (requiresPaidSubscriptionForAgeTier). That exemption is NOT applied to
  // nominators — nominating is an adult-member act, and widening nomination
  // eligibility to un-subscribed junior tiers is an owner policy decision that
  // is out of scope for #1944. Only the membership-type NOT_REQUIRED rule is
  // extended here.
  const membershipTypePolicy = await resolveMembershipTypePolicyForMember(prisma, {
    memberId: nominator.id,
    seasonYear,
  });
  const paidUp =
    membershipTypePolicy?.subscriptionBehavior === "NOT_REQUIRED" ||
    nominator.subscriptions.length > 0;

  if (!paidUp) {
    throw new MembershipApplicationError(
      `${normalizedEmail} is not an active, paid-up ${CLUB_NAME} member`,
      422
    );
  }

  // Nomination eligibility gate: a member can only nominate once their own
  // induction is signed off and they meet the minimum tenure / nights stayed
  // (admin-configurable). Existing members who predate the gate are grandfathered.
  const eligibility = await checkNominatorEligibility({
    id: nominator.id,
    joinedDate: nominator.joinedDate,
    createdAt: nominator.createdAt,
  });

  if (!eligibility.eligible) {
    const reasonText = eligibility.reasons.join("; and ");
    throw new MembershipApplicationError(
      `${nominator.firstName} ${nominator.lastName} is not yet eligible to nominate a new member because ${reasonText}.`,
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
      `An active ${CLUB_NAME} account already exists for this email address`,
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

function getNominatorSlot(
  application: Pick<MemberApplication, "nominator1Id" | "nominator2Id">,
  nominatorMemberId: string
): NominatorSlot | null {
  if (application.nominator1Id === nominatorMemberId) {
    return "nominator1";
  }

  if (application.nominator2Id === nominatorMemberId) {
    return "nominator2";
  }

  return null;
}

function isSlotConfirmed(
  application: Pick<MemberApplication, "nominator1ConfirmedAt" | "nominator2ConfirmedAt">,
  slot: NominatorSlot
) {
  return slot === "nominator1"
    ? Boolean(application.nominator1ConfirmedAt)
    : Boolean(application.nominator2ConfirmedAt);
}

function getSlotMemberId(
  application: Pick<MemberApplication, "nominator1Id" | "nominator2Id">,
  slot: NominatorSlot
) {
  return slot === "nominator1"
    ? application.nominator1Id
    : application.nominator2Id;
}

function getOtherSlotMemberId(
  application: Pick<MemberApplication, "nominator1Id" | "nominator2Id">,
  slot: NominatorSlot
) {
  return slot === "nominator1"
    ? application.nominator2Id
    : application.nominator1Id;
}

function getSlotEmailField(slot: NominatorSlot) {
  return slot === "nominator1" ? "nominator1Email" : "nominator2Email";
}

function getSlotIdField(slot: NominatorSlot) {
  return slot === "nominator1" ? "nominator1Id" : "nominator2Id";
}

function getSlotConfirmedAtField(slot: NominatorSlot) {
  return slot === "nominator1"
    ? "nominator1ConfirmedAt"
    : "nominator2ConfirmedAt";
}

async function sendNominationRequestForApplication({
  application,
  nominator,
  token,
  expiresAt,
}: {
  application: Pick<
    MemberApplication,
    "applicantFirstName" | "applicantLastName" | "familyMembers"
  >;
  nominator: Pick<VerifiedNominator, "email" | "firstName">;
  token: string;
  expiresAt: Date;
}) {
  await sendNominationRequestEmail({
    email: nominator.email,
    nominatorName: nominator.firstName,
    applicantName: getApplicationDisplayName(application),
    token,
    familyMemberCount: parseApplicationFamilyMembers(application.familyMembers).length,
    expiresAt,
  });
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

  // A REAL DAY, not merely a date-shaped string (#3082 fix round). The route's
  // own schema refuses this first; the check is repeated here because this is the
  // library boundary and a caller that skips the route must not be able to store
  // a value that later wedges its own approval. See
  // {@link applicationDateOfBirthDay} for the whole reasoning, including why the
  // READ schema stays loose.
  const applicantDayOfBirth = applicationDateOfBirthDay(applicantDateOfBirth);
  if (!applicantDayOfBirth) {
    throw new MembershipApplicationError("Date of birth must be a real date", 422, {
      applicantDateOfBirth: ["Date of birth must be a real date"],
    });
  }

  const dependentDayErrors = familyMembers.flatMap((familyMember, index) =>
    applicationDateOfBirthDay(familyMember.dateOfBirth)
      ? []
      : [`Dependent ${index + 1} date of birth must be a real date`],
  );
  if (dependentDayErrors.length > 0) {
    throw new MembershipApplicationError(dependentDayErrors[0], 422, {
      familyMembers: dependentDayErrors,
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

  const issuedAt = new Date();
  const token1 = issueActionToken();
  const token2 = issueActionToken();
  const expiresAt = getNominationTokenExpiryDate(issuedAt);

  const application = await prisma.$transaction(async (tx) => {
    await lockMembershipApplicationApplicant(tx, applicantEmail);
    await ensureApplicationCanBeCreated(applicantEmail, tx);

    const created = await tx.memberApplication.create({
      data: {
        applicantFirstName,
        applicantLastName,
        applicantEmail,
        // `dateOnlyInstantOf` of the VALIDATED day, not `new Date(rawString)`:
        // the raw form rolled `1990-02-31` to 3 March and made `0000-05-05` a
        // year-0 value that no `CalendarDate` reader can decode (#3082).
        applicantDateOfBirth: dateOnlyInstantOf(applicantDayOfBirth),
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
          reminderCount: 0,
          lastSentAt: issuedAt,
        },
        {
          tokenHash: token2.tokenHash,
          applicationId: created.id,
          nominatorMemberId: nominator2.id,
          expiresAt,
          reminderCount: 0,
          lastSentAt: issuedAt,
        },
      ],
    });

    return created;
  });

  const emailWarnings: string[] = [];

  await Promise.all([
    sendNominationRequestForApplication({
      application,
      nominator: nominator1,
      token: token1.token,
      expiresAt,
    }).catch((err) => {
      logger.error({ err, applicationId: application.id, nominatorId: nominator1.id }, "Failed to send nomination email");
      emailWarnings.push(`Could not email ${nominator1.email}`);
    }),
    sendNominationRequestForApplication({
      application,
      nominator: nominator2,
      token: token2.token,
      expiresAt,
    }).catch((err) => {
      logger.error({ err, applicationId: application.id, nominatorId: nominator2.id }, "Failed to send nomination email");
      emailWarnings.push(`Could not email ${nominator2.email}`);
    }),
  ]);

  logAudit({
    action: "MEMBERSHIP_APPLICATION_CREATED",
    category: "account",
    targetId: application.id,
    entityType: "MemberApplication",
    entityId: application.id,
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

  const currentSlot = getNominatorSlot(current.application, current.nominatorMemberId);
  if (!currentSlot) {
    throw new MembershipApplicationError("This nomination link has been replaced", 409);
  }

  if (isSlotConfirmed(current.application, currentSlot)) {
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

    const latestSlot = getNominatorSlot(
      latestToken.application,
      latestToken.nominatorMemberId
    );
    if (!latestSlot) {
      throw new MembershipApplicationError(
        "This nomination link has been replaced",
        409
      );
    }

    if (isSlotConfirmed(latestToken.application, latestSlot)) {
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

    const isFirstNominator = latestSlot === "nominator1";
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
    category: "account",
    memberId: nominatorMemberId,
    targetId: result.application.id,
    entityType: "MemberApplication",
    entityId: result.application.id,
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

export interface NominationReminderRunResult {
  scanned: number;
  sent: number;
  skipped: number;
  failed: number;
}

export async function sendDueNominationReminders({
  now = new Date(),
  limit = 100,
}: {
  now?: Date;
  limit?: number;
} = {}): Promise<NominationReminderRunResult> {
  const take = Math.min(Math.max(limit, 1), 200);
  const candidates = await prisma.nominationToken.findMany({
    where: {
      confirmedAt: null,
      expiresAt: { lte: now },
      reminderCount: { lt: NOMINATION_AUTOMATIC_REMINDER_LIMIT },
      application: { status: ApplicationStatus.PENDING_NOMINATORS },
    },
    orderBy: [{ expiresAt: "asc" }, { createdAt: "asc" }],
    take,
    include: { application: true },
  });

  const nominatorIds = Array.from(
    new Set(candidates.map((candidate) => candidate.nominatorMemberId))
  );
  const nominators = nominatorIds.length
    ? await prisma.member.findMany({
        where: {
          id: { in: nominatorIds },
          active: true,
        },
        select: { id: true, email: true, firstName: true, lastName: true },
      })
    : [];
  const nominatorById = new Map(nominators.map((nominator) => [nominator.id, nominator]));

  const result: NominationReminderRunResult = {
    scanned: candidates.length,
    sent: 0,
    skipped: 0,
    failed: 0,
  };

  for (const candidate of candidates) {
    const slot = getNominatorSlot(candidate.application, candidate.nominatorMemberId);
    const nominator = nominatorById.get(candidate.nominatorMemberId);

    if (!slot || isSlotConfirmed(candidate.application, slot) || !nominator) {
      result.skipped += 1;
      continue;
    }

    const issued = issueActionToken();
    const expiresAt = getNominationTokenExpiryDate(now);
    const update = await prisma.nominationToken.updateMany({
      where: {
        id: candidate.id,
        confirmedAt: null,
        expiresAt: candidate.expiresAt,
        reminderCount: candidate.reminderCount,
        application: { status: ApplicationStatus.PENDING_NOMINATORS },
      },
      data: {
        tokenHash: issued.tokenHash,
        expiresAt,
        reminderCount: { increment: 1 },
        lastSentAt: now,
      },
    });

    if (update.count !== 1) {
      result.skipped += 1;
      continue;
    }

    try {
      await sendNominationRequestForApplication({
        application: candidate.application,
        nominator,
        token: issued.token,
        expiresAt,
      });
      result.sent += 1;
      await logAudit({
        action: "membership_application.nomination_reminder_sent",
        memberId: candidate.nominatorMemberId,
        subjectMemberId: candidate.nominatorMemberId,
        targetId: candidate.applicationId,
        entityType: "NominationToken",
        entityId: candidate.id,
        category: "communication",
        severity: "info",
        outcome: "success",
        summary: "Membership nomination reminder sent",
        metadata: {
          applicationId: candidate.applicationId,
          nominatorMemberId: candidate.nominatorMemberId,
          reminderCount: candidate.reminderCount + 1,
          reminderLimit: NOMINATION_AUTOMATIC_REMINDER_LIMIT,
        },
      });
    } catch (err) {
      result.failed += 1;
      logger.error(
        {
          err,
          applicationId: candidate.applicationId,
          nominatorId: candidate.nominatorMemberId,
        },
        "Failed to send membership nomination reminder"
      );
    }
  }

  return result;
}

function getPendingNominatorSlots(application: MemberApplication): NominatorSlot[] {
  return (["nominator1", "nominator2"] as const).filter(
    (slot) => !isSlotConfirmed(application, slot)
  );
}

export async function refreshMemberApplicationNominations(
  applicationId: string,
  adminMemberId: string
) {
  const issuedAt = new Date();
  const prepared = await prisma.$transaction(async (tx) => {
    await lockMembershipApplication(tx, applicationId);

    const application = await tx.memberApplication.findUnique({
      where: { id: applicationId },
    });

    if (!application) {
      throw new MembershipApplicationError("Application not found", 404);
    }

    if (application.status !== ApplicationStatus.PENDING_NOMINATORS) {
      throw new MembershipApplicationError(
        "Only applications waiting on nominators can be refreshed",
        409
      );
    }

    const pendingSlots = getPendingNominatorSlots(application);
    if (pendingSlots.length === 0) {
      throw new MembershipApplicationError(
        "This application has no pending nominators to refresh",
        409
      );
    }

    const nominatorIds = pendingSlots
      .map((slot) => getSlotMemberId(application, slot))
      .filter((value): value is string => Boolean(value));
    const nominators = await tx.member.findMany({
      where: { id: { in: nominatorIds }, active: true },
      select: { id: true, email: true, firstName: true, lastName: true },
    });
    const nominatorById = new Map(nominators.map((nominator) => [nominator.id, nominator]));
    const emails: Array<{
      slot: NominatorSlot;
      nominator: VerifiedNominator;
      token: string;
      expiresAt: Date;
      tokenId: string;
    }> = [];

    for (const slot of pendingSlots) {
      const nominatorMemberId = getSlotMemberId(application, slot);
      if (!nominatorMemberId) {
        throw new MembershipApplicationError(
          "This application is missing a pending nominator member",
          409
        );
      }

      const nominator = nominatorById.get(nominatorMemberId);
      if (!nominator) {
        throw new MembershipApplicationError(
          "A pending nominator is no longer active",
          409
        );
      }

      const issued = issueActionToken();
      const expiresAt = getNominationTokenExpiryDate(issuedAt);

      await tx.nominationToken.deleteMany({
        where: {
          applicationId,
          nominatorMemberId,
          confirmedAt: null,
        },
      });
      const createdToken = await tx.nominationToken.create({
        data: {
          tokenHash: issued.tokenHash,
          applicationId,
          nominatorMemberId,
          expiresAt,
          reminderCount: 0,
          lastSentAt: issuedAt,
        },
        select: { id: true },
      });

      emails.push({
        slot,
        nominator,
        token: issued.token,
        expiresAt,
        tokenId: createdToken.id,
      });
    }

    return { application, emails };
  });

  const emailWarnings: string[] = [];
  await Promise.all(
    prepared.emails.map((email) =>
      sendNominationRequestForApplication({
        application: prepared.application,
        nominator: email.nominator,
        token: email.token,
        expiresAt: email.expiresAt,
      }).catch((err) => {
        logger.error(
          {
            err,
            applicationId,
            nominatorId: email.nominator.id,
          },
          "Failed to send refreshed nomination request"
        );
        emailWarnings.push(`Could not email ${email.nominator.email}`);
      })
    )
  );

  await logAudit({
    action: "membership_application.nomination_workflow_refreshed",
    memberId: adminMemberId,
    actorMemberId: adminMemberId,
    targetId: applicationId,
    entityType: "MemberApplication",
    entityId: applicationId,
    // `account`, not the invented `membership` these three membership-application
    // writers used to pass (#2581). `membership` was never a taxonomy value, so
    // the rows were selectable by no Admin category filter and by no Diagnostics
    // correlation tool. A membership application is account-domain work, and
    // `account` is read with `support:view` plus `membership:view` — so these
    // rows go from readable by nobody to readable by a Membership Officer.
    //
    // One member-facing consequence to state, since `account` is in
    // MEMBER_VISIBLE_AUDIT_CATEGORIES and `membership` was in nothing: the member
    // each row is about now sees it in their own profile timeline — the acting
    // administrator here, the replacement nominator on the writer below, and the
    // mapped member on `MEMBER_APPLICATION_MAPPED_TO_EXISTING`. The member
    // projection returns the summary but NO metadata, so the applicant email in
    // that last writer's metadata stays administrator-only.
    category: "account",
    severity: "important",
    outcome: "success",
    summary: "Membership nomination workflow refreshed",
    metadata: {
      applicationId,
      refreshedSlots: prepared.emails.map((email) => email.slot),
      tokenIds: prepared.emails.map((email) => email.tokenId),
      emailWarnings,
    },
  });

  return {
    application: prepared.application,
    refreshedCount: prepared.emails.length,
    emailWarnings,
  };
}

export async function replaceMemberApplicationNominator({
  applicationId,
  slot,
  replacementMemberId,
  adminMemberId,
}: {
  applicationId: string;
  slot: NominatorSlot;
  replacementMemberId: string;
  adminMemberId: string;
}) {
  const replacement = await prisma.member.findFirst({
    where: { id: replacementMemberId },
    select: { id: true, email: true },
  });

  if (!replacement) {
    throw new MembershipApplicationError("Replacement nominator not found", 404);
  }

  const verifiedReplacement = await verifyNominator(replacement.email);
  if (verifiedReplacement.id !== replacementMemberId) {
    throw new MembershipApplicationError(
      "Replacement nominator must be the selected active member",
      409
    );
  }

  const issuedAt = new Date();
  const issued = issueActionToken();
  const expiresAt = getNominationTokenExpiryDate(issuedAt);

  const updated = await prisma.$transaction(async (tx) => {
    await lockMembershipApplication(tx, applicationId);

    const application = await tx.memberApplication.findUnique({
      where: { id: applicationId },
    });

    if (!application) {
      throw new MembershipApplicationError("Application not found", 404);
    }

    if (application.status !== ApplicationStatus.PENDING_NOMINATORS) {
      throw new MembershipApplicationError(
        "Only applications waiting on nominators can have nominators replaced",
        409
      );
    }

    if (isSlotConfirmed(application, slot)) {
      throw new MembershipApplicationError(
        "Confirmed nominators cannot be replaced",
        409
      );
    }

    if (getOtherSlotMemberId(application, slot) === verifiedReplacement.id) {
      throw new MembershipApplicationError(
        "Please choose a different member from the other nominator",
        422
      );
    }

    if (
      cleanString(application.applicantEmail).toLowerCase() ===
      cleanString(verifiedReplacement.email).toLowerCase()
    ) {
      throw new MembershipApplicationError("Applicants cannot nominate themselves", 422);
    }

    const previousNominatorId = getSlotMemberId(application, slot);
    if (previousNominatorId) {
      await tx.nominationToken.deleteMany({
        where: {
          applicationId,
          nominatorMemberId: previousNominatorId,
          confirmedAt: null,
        },
      });
    }

    const createdToken = await tx.nominationToken.create({
      data: {
        tokenHash: issued.tokenHash,
        applicationId,
        nominatorMemberId: verifiedReplacement.id,
        expiresAt,
        reminderCount: 0,
        lastSentAt: issuedAt,
      },
      select: { id: true },
    });

    const updatedApplication = await tx.memberApplication.update({
      where: { id: applicationId },
      data: {
        [getSlotIdField(slot)]: verifiedReplacement.id,
        [getSlotEmailField(slot)]: verifiedReplacement.email,
        [getSlotConfirmedAtField(slot)]: null,
      },
    });

    return {
      application: updatedApplication,
      previousNominatorId,
      tokenId: createdToken.id,
    };
  });

  const emailWarnings: string[] = [];
  try {
    await sendNominationRequestForApplication({
      application: updated.application,
      nominator: verifiedReplacement,
      token: issued.token,
      expiresAt,
    });
  } catch (err) {
    logger.error(
      { err, applicationId, nominatorId: verifiedReplacement.id },
      "Failed to send replacement nomination request"
    );
    emailWarnings.push(`Could not email ${verifiedReplacement.email}`);
  }

  await logAudit({
    action: "membership_application.nominator_replaced",
    memberId: adminMemberId,
    actorMemberId: adminMemberId,
    subjectMemberId: verifiedReplacement.id,
    targetId: applicationId,
    entityType: "MemberApplication",
    entityId: applicationId,
    // `account` (#2581) — was the invented `membership`; see the note on the
    // nomination-workflow-refreshed writer above.
    category: "account",
    severity: "important",
    outcome: "success",
    summary: "Membership application nominator replaced",
    metadata: {
      applicationId,
      slot,
      previousNominatorId: updated.previousNominatorId,
      replacementNominatorId: verifiedReplacement.id,
      tokenId: updated.tokenId,
      emailWarnings,
    },
  });

  return {
    application: updated.application,
    replacementNominatorId: verifiedReplacement.id,
    emailWarnings,
  };
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
  adminNotes?: string | null,
  entranceFeeInvoiceDecision?: EntranceFeeInvoiceApprovalDecision | null,
  // #1786: admin per-action email choice. Absent/undefined = notify (default);
  // false = suppress the applicant-facing approval notice. Gates only that
  // applicant email — the induction sign-off requests below are token-bearing
  // requests to the assigned signers and always send.
  notifyMember?: boolean,
  // E10 (#1936): per-person map-to-existing decisions. Absent = all-CREATE =
  // byte-identical current behavior. `mappingPreviewToken` is required whenever
  // any person is MAP and binds this approval to the exact previewed outcome.
  personDecisions?: PersonDecisions | null,
  mappingPreviewToken?: string | null
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

  // ONE read of the club's persisted zone for this whole approval, taken BEFORE
  // the transaction opens. The season year and, since #3123, the joining fee's
  // schedule day both come from it — two answers from one read, and necessarily
  // the same day, rather than two independent reads that an approval straddling
  // club midnight could answer differently.
  const clubZone = await readClubTimeZoneOutsideRequest();
  const seasonYear = clubSeasonYear(clubZone);
  const joiningFeeAsOf = dateOnlyInstantOf(clubToday(clubZone));
  const preFamilyMembers = parseApplicationFamilyMembers(application.familyMembers);
  const resolution = resolvePersonDecisions(preFamilyMembers.length, personDecisions);
  if (!resolution.ok) {
    throw new MembershipApplicationError(resolution.error, resolution.status);
  }
  const { decisions, mapTargetIds } = resolution;
  const hasMappings = mapTargetIds.length > 0;
  if (hasMappings && !mappingPreviewToken) {
    throw new MembershipApplicationError(
      "A mapping preview token is required when mapping to existing members. Preview the mapping again before approving.",
      400
    );
  }
  const applicantDecision = decisions[0].decision;
  const applicantMapped = applicantDecision.mode === "MAP";
  const applicantMapTargetId = applicantMapped ? applicantDecision.memberId : null;

  const applicantPasswordHash = await hash(randomBytes(32).toString("hex"), 13);
  const passwordSetupToken = buildResetToken();
  const passwordSetupExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  // Resolved before the transaction so the entrance-fee outbox enqueue can run
  // inside it (#1886, F22). A mapped applicant defaults to SKIP (never
  // double-charged) unless the admin explicitly supplied a decision; the SKIP is
  // resolved here so the in-tx enqueue is simply never made.
  const entranceFeeDecision: EntranceFeeInvoiceApprovalDecision =
    entranceFeeInvoiceDecision ??
    (applicantMapped
      ? { action: "SKIP", reason: "Mapped to existing member" }
      : { action: "CREATE" });

  const approved = await prisma.$transaction(async (tx) => {
    await lockMembershipApplication(tx, applicationId);
    // Advisory-lock every MAP target in a stable sorted order (member-lifecycle
    // convention, member-lifecycle-actions.ts) so concurrent approvals mapping
    // the same member serialize; the second approval then sees the first's
    // committed row and 409s on token drift.
    for (const targetId of mapTargetIds) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`member-lifecycle:${targetId}`}))`;
    }

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

    // The applicant's own stored day, decoded once and refused if it names none.
    // `applicantDateOfBirth` IS a `@db.Date` column, so this is not the
    // `familyMembers` JSON hole — what it catches is a year outside the
    // `CalendarDate` range, which `createMemberApplication` could once write from
    // `new Date("0000-05-05")`. Left unguarded that value throws a `RangeError`
    // out of `computeAge` inside this transaction and the route answers a bare
    // 500 (#3082 fix round).
    const applicantDayOfBirth = applicationDateOfBirthDay(
      formatDateOnly(lockedApplication.applicantDateOfBirth),
    );
    if (!applicantDayOfBirth) {
      throw new MembershipApplicationError(
        unreadableDateOfBirthRefusal("The applicant"),
        422
      );
    }

    const address = parseApplicationAddress(lockedApplication.applicantAddress);
    const familyMembers = parseApplicationFamilyMembers(lockedApplication.familyMembers);
    // EVERY dependent's day, decoded in ONE pass before anything is written, and
    // refused by name if any of them names no real day (#3082 fix round). Doing
    // it here rather than inside the write loop below means the refusal is the
    // same 422 with the same message on the mapping path and the all-CREATE path
    // — the mapping recompute reports the same condition as a blocking 409, and
    // two statuses for one cause is how an admin ends up chasing the wrong thing.
    const dependentDaysOfBirth = familyMembers.map((familyMember, index) => {
      const day = applicationDateOfBirthDay(familyMember.dateOfBirth);
      if (!day) {
        throw new MembershipApplicationError(
          unreadableDateOfBirthRefusal(dependentSubject(familyMember, index)),
          422
        );
      }
      return { day, instant: dateOnlyInstantOf(day) };
    });
    const applicantPhone = parseApplicantPhone(lockedApplication.applicantPhone);
    // E10 (#1936): when any person is mapped, age tiers are computed from
    // AgeTierSetting rows read via `tx` (bypassing the 5-minute process cache)
    // so the WRITTEN tier always equals the recomputed, tokenized preview
    // outcome. The all-CREATE path keeps the existing cached computeTier
    // behavior, byte-identical to today.
    const mappingAgeTierSettings = hasMappings
      ? await loadMappingAgeTierSettings(tx)
      : null;
    const mappingSeasonStart = getSeasonStartDate(seasonYear);
    const applicantAgeTier = mappingAgeTierSettings
      ? computeAgeTierWithSettings(
          lockedApplication.applicantDateOfBirth,
          mappingSeasonStart,
          mappingAgeTierSettings
        )
      : await computeTier(applicantDayOfBirth, mappingSeasonStart);
    // The application form captures the booking-gate profile details, so
    // approval counts as initial confirmation for the applicant and dependents.
    const profileConfirmedAt = new Date();

    // E10: recompute the mapping outcome from the locked, reloaded rows and
    // verify the preview token (timing-safe). ANY outcome drift — a row edit OR
    // a computed-result change (e.g. an age-tier boundary edit) — 409s here.
    const createdMemberIds: string[] = [];
    const mappedMemberIds: string[] = [];
    const skipBillingIds = new Set<string>();
    const mappedAudits: Array<{
      ref: string;
      personLabel: string;
      targetMemberId: string;
      overwrittenFields: Array<{ field: string; before: string | null; after: string | null }>;
      loginPromoted: boolean;
      skippedSeasonalAssignment: boolean;
    }> = [];
    const outcomeByRef = new Map<string, PersonOutcome>();
    let mappingTargetsById = new Map<string, MappingTargetRecord>();

    if (hasMappings) {
      const applicationInput: MappingApplicationInput = {
        id: lockedApplication.id,
        updatedAt: lockedApplication.updatedAt,
        applicantEmail: lockedApplication.applicantEmail,
        applicantFirstName: lockedApplication.applicantFirstName,
        applicantLastName: lockedApplication.applicantLastName,
        applicantDateOfBirth: lockedApplication.applicantDateOfBirth,
        applicantPhone: lockedApplication.applicantPhone,
        applicantAddress: lockedApplication.applicantAddress,
        familyMembers,
        nominator1Id: lockedApplication.nominator1Id,
        nominator2Id: lockedApplication.nominator2Id,
      };
      const [targetsById, loginHolderId] = await Promise.all([
        loadApprovalMappingTargets(tx, mapTargetIds, seasonYear),
        getLoginHolderIdForEmail(tx, lockedApplication.applicantEmail),
      ]);
      mappingTargetsById = targetsById;
      // #1026 gate: the PUT actor's access roles are re-read INSIDE the
      // transaction (never trusted from the preview or the JWT). A preview
      // minted by a Full Admin and approved by a scoped admin recomputes with
      // the scoped actor, so the outcome payload diverges and the token check
      // below 409s — fail closed. A missing/role-less actor counts as not
      // Full Admin.
      const actingAdmin = await tx.member.findUnique({
        where: { id: adminMemberId },
        select: {
          id: true,
          canLogin: true,
          accessRoles: { select: { role: true, roleDefinitionId: true } },
        },
      });
      const actorIsFullAdmin = actingAdmin ? isFullAdmin(actingAdmin) : false;
      const { persons, blockingErrors } = await computeApprovalMappingOutcomes({
        application: applicationInput,
        decisions,
        targetsById,
        loginHolderId,
        seasonYear,
        actor: { id: adminMemberId, isFullAdmin: actorIsFullAdmin },
        ageTierSettings: mappingAgeTierSettings ?? [],
      });
      if (
        !verifyApprovalMappingPreviewToken(
          { application: applicationInput, persons, blockingErrors },
          mappingPreviewToken as string
        )
      ) {
        throw new MembershipApplicationError(
          "The mapping has changed since it was previewed. Preview the mapping again before approving.",
          409
        );
      }
      const firstError =
        blockingErrors[0] ?? persons.flatMap((person) => person.errors)[0];
      if (firstError) {
        throw new MembershipApplicationError(firstError, 409);
      }
      for (const person of persons) {
        outcomeByRef.set(refKey(person.ref), person);
      }
    }

    const overwrittenFieldsFor = (outcome: PersonOutcome) =>
      outcome.fieldDiffs
        .filter((diff) => diff.willChange)
        .map((diff) => ({
          field: diff.field,
          before: diff.current,
          after: diff.incoming,
        }));

    let applicantMember: {
      id: string;
      email: string;
      firstName: string;
      lastName: string;
    };
    // Whether the applicant should receive an account-setup token + email. True
    // for a created applicant and a non-login target promoted to login; false
    // for a keep-auth mapped applicant (they already have a password).
    let issueApplicantSetupToken = true;
    let applicantKeptAuth = false;

    if (applicantMapped) {
      const outcome = outcomeByRef.get("applicant");
      const target = mappingTargetsById.get(applicantMapTargetId as string);
      if (!outcome || !target) {
        throw new MembershipApplicationError(
          "The mapping target for the applicant is no longer available. Preview the mapping again.",
          409
        );
      }
      // Defense in depth: relax the canLogin-email guard ONLY when the login
      // holder IS this target; a different login holder still blocks.
      const loginHolder = await tx.member.findFirst({
        where: { email: lockedApplication.applicantEmail, canLogin: true },
        select: { id: true },
      });
      if (loginHolder && loginHolder.id !== target.id) {
        throw new MembershipApplicationError(
          `A ${CLUB_NAME} login already exists for this applicant email address`,
          409
        );
      }

      const applicantUpdate: Prisma.MemberUncheckedUpdateInput = {
        email: lockedApplication.applicantEmail,
        firstName: lockedApplication.applicantFirstName,
        lastName: lockedApplication.applicantLastName,
        dateOfBirth: lockedApplication.applicantDateOfBirth,
        ageTier: applicantAgeTier,
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
        // Confirmation timestamps: set-if-null, never regressed.
        ...(target.profileCompletedAt ? {} : { profileCompletedAt: profileConfirmedAt }),
        ...(target.detailsConfirmedAt ? {} : { detailsConfirmedAt: profileConfirmedAt }),
        ...(target.detailsConfirmedByMemberId
          ? {}
          : { detailsConfirmedByMemberId: target.id }),
        ...(target.onboardingConfirmedAt ? {} : { onboardingConfirmedAt: profileConfirmedAt }),
      };
      if (outcome.loginPromoted) {
        // Promotion path (canLogin:false -> true): fresh random hash, verified
        // email, cleared email inheritance; a set-password token is issued
        // below. Mirrors the create path's auth bootstrap.
        applicantUpdate.canLogin = true;
        applicantUpdate.passwordHash = applicantPasswordHash;
        applicantUpdate.emailVerified = true;
        applicantUpdate.inheritParentEmail = false;
        applicantUpdate.inheritEmailFromId = null;
        // #2716: the CHOICE clears with the pointer. A promoted applicant now
        // has a login and an address of their own, so the decision that routed
        // their mail elsewhere is spent — leaving it would have their pointer
        // restored by the next reconciliation.
        applicantUpdate.inheritEmailChoiceId = null;
      } else {
        // Keep-auth path: never touch passwordHash/canLogin/2FA/emailVerified.
        applicantKeptAuth = true;
        issueApplicantSetupToken = false;
      }

      const updated = await tx.member.update({
        where: { id: target.id },
        data: applicantUpdate,
        select: { id: true, email: true, firstName: true, lastName: true },
      });
      applicantMember = updated;
      // #2821: promotion turns the applicant INTO a usable email source — they
      // gain a login and their own verified address, and their own inheritance
      // is cleared just above. Anyone who already holds a choice naming them was
      // resolving to nobody while they were inheriting, and should now resolve
      // to them. Nothing re-pointed those dependants until the daily sweep.
      await reconcileEmailInheritanceForMemberChange(tx, [target.id], {
        trigger: "nomination-promotion",
        actorMemberId: adminMemberId,
      });
      mappedMemberIds.push(target.id);
      if (outcome.skipSeasonalAssignment) {
        skipBillingIds.add(target.id);
      }
      mappedAudits.push({
        ref: "applicant",
        personLabel: outcome.personLabel,
        targetMemberId: target.id,
        overwrittenFields: overwrittenFieldsFor(outcome),
        loginPromoted: outcome.loginPromoted,
        skippedSeasonalAssignment: outcome.skipSeasonalAssignment,
      });
    } else {
      const existing = await tx.member.findFirst({
        where: {
          email: lockedApplication.applicantEmail,
          canLogin: true,
        },
        select: { id: true },
      });

      if (existing) {
        throw new MembershipApplicationError(
          `A ${CLUB_NAME} login already exists for this applicant email address`,
          409
        );
      }

      applicantMember = await tx.member.create({
        data: {
          email: lockedApplication.applicantEmail,
          passwordHash: applicantPasswordHash,
          emailVerified: true,
          firstName: lockedApplication.applicantFirstName,
          lastName: lockedApplication.applicantLastName,
          dateOfBirth: lockedApplication.applicantDateOfBirth,
          role: "USER",
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
      createdMemberIds.push(applicantMember.id);
    }

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
        },
        // Result discarded — narrow the implicit RETURNING (#2130 house rule).
        // This one is inside approveMemberApplication's transaction, so an
        // unnarrowed write naming a dropped column would abort the whole
        // approval rather than degrade one field.
        select: { id: true },
      });
    }

    for (let index = 0; index < familyMembers.length; index += 1) {
      const familyMember = familyMembers[index];
      const familyDecision = decisions[index + 1].decision;
      // The day decoded once above, so the tier and the stored date can never
      // come from two readings of one string.
      const { day: dependentDayOfBirth, instant: dependentDateOfBirth } =
        dependentDaysOfBirth[index];
      const dependentAgeTier = mappingAgeTierSettings
        ? computeAgeTierWithSettings(
            dependentDateOfBirth,
            mappingSeasonStart,
            mappingAgeTierSettings
          )
        : await computeTier(dependentDayOfBirth, mappingSeasonStart);

      if (familyDecision.mode === "MAP") {
        const outcome = outcomeByRef.get(`family:${index}`);
        const target = mappingTargetsById.get(familyDecision.memberId);
        if (!outcome || !target) {
          throw new MembershipApplicationError(
            "A mapping target for a family member is no longer available. Preview the mapping again.",
            409
          );
        }
        const dependentUpdate: Prisma.MemberUncheckedUpdateInput = {
          firstName: familyMember.firstName,
          lastName: familyMember.lastName,
          dateOfBirth: dependentDateOfBirth,
          ageTier: dependentAgeTier,
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
          // Confirmation timestamps: set-if-null, never regressed.
          ...(target.profileCompletedAt ? {} : { profileCompletedAt: profileConfirmedAt }),
          ...(target.detailsConfirmedAt ? {} : { detailsConfirmedAt: profileConfirmedAt }),
          ...(target.detailsConfirmedByMemberId
            ? {}
            : { detailsConfirmedByMemberId: applicantMember.id }),
          ...(target.onboardingConfirmedAt
            ? {}
            : { onboardingConfirmedAt: profileConfirmedAt }),
        };
        // Parent link + email inheritance ONLY when the target is a non-login
        // member with no existing parent; never touch auth/email on a
        // login-capable target (hard invariant). The preview noted the skip.
        if (outcome.setParentLink) {
          // #2255: the identity guards every other writer has, which this one
          // lacked. The mapping predicate only checks that `parentMemberId` is
          // null, so a target whose SECONDARY parent is already the applicant
          // would be written into the primary slot as well — the same person in
          // both parent columns, which reads as "two parents" everywhere else in
          // the system and is unreachable from any other route. A target that
          // IS the applicant is the degenerate case of the same gap.
          if (target.id === applicantMember.id) {
            throw new MembershipApplicationError(
              "A member cannot be their own parent",
              422
            );
          }
          if (target.secondaryParentId === applicantMember.id) {
            throw new MembershipApplicationError(
              "This member is already linked to that parent",
              422
            );
          }

          // #2255 (D9): mapping onto an EXISTING member is a parent-link write,
          // and this path never saw the old two-generation guard — the mapping
          // predicate only checks that the target has no parent, not that it has
          // no dependants. Under a four-generation cap both halves matter: the
          // applicant may be someone's child, and the target may already have
          // children of their own.
          const linkVerdict = await checkParentLinkDepthAndCycle(tx, {
            parentId: applicantMember.id,
            childId: target.id,
          });
          if (linkVerdict) {
            throw new MembershipApplicationError(linkVerdict.error, 422);
          }

          // #2255: `applicantMember.id` is a pointer at the DIRECT PARENT,
          // which the flat-terminal rule forbids. On the keep-auth branch the
          // applicant is an existing member who may themselves inherit, so the
          // stored pointer could chain — and on the placeholder-address case it
          // would name a mailbox that silently discards mail. Resolve it the way
          // every other writer does, and validate the result.
          const resolvedSourceId = (
            await resolveInheritedEmailSourceId(tx, applicantMember.id)
          ).sourceId;
          if (!resolvedSourceId) {
            throw new MembershipApplicationError(
              NO_INHERITABLE_EMAIL_SOURCE_MESSAGE,
              422
            );
          }
          const sourceValidation = await validateInheritEmailSource(
            { memberId: target.id, inheritEmailFromId: resolvedSourceId },
            tx
          );
          if (!sourceValidation.ok) {
            throw new MembershipApplicationError(
              sourceValidation.error,
              sourceValidation.status
            );
          }

          dependentUpdate.parentMemberId = applicantMember.id;
          dependentUpdate.inheritParentEmail = true;
          dependentUpdate.inheritEmailFromId = resolvedSourceId;
          // #2716: pointer and CHOICE written together. Under one hop the
          // resolved mailbox IS the applicant, who is this dependant's parent.
          dependentUpdate.inheritEmailChoiceId = resolvedSourceId;
        }
        await tx.member.update({
          where: { id: target.id },
          data: dependentUpdate,
        });
        mappedMemberIds.push(target.id);
        if (outcome.skipSeasonalAssignment) {
          skipBillingIds.add(target.id);
        }
        mappedAudits.push({
          ref: `family[${index}]`,
          personLabel: outcome.personLabel,
          targetMemberId: target.id,
          overwrittenFields: overwrittenFieldsFor(outcome),
          loginPromoted: false,
          skippedSeasonalAssignment: outcome.skipSeasonalAssignment,
        });

        if (familyGroupId) {
          await tx.familyGroupMember.upsert({
            where: {
              familyGroupId_memberId: {
                familyGroupId,
                memberId: target.id,
              },
            },
            create: {
              familyGroupId,
              memberId: target.id,
            },
            update: {},
            // Result discarded — narrow the implicit RETURNING (#2130 house rule).
            select: { id: true },
          });
        }
        continue;
      }

      // #2255 (D9): a brand-new dependant has no chain of its own, so only the
      // applicant's ancestors can breach the cap — which they can, now that an
      // applicant may themselves be recorded as someone's child.
      const applicantSide = await describeParentSideDepth(tx, applicantMember.id);
      if (
        exceedsFamilyLinkGenerationLimit({
          parentAncestorGenerations: applicantSide.ancestorGenerations,
          childDescendantGenerations: 0,
        })
      ) {
        throw new MembershipApplicationError(
          FAMILY_LINK_GENERATION_LIMIT_ERROR,
          422
        );
      }

      // #2255: same flat-terminal rule as the map branch above — never store a
      // pointer at the direct parent.
      const createdDependentSourceId = (
        await resolveInheritedEmailSourceId(tx, applicantMember.id)
      ).sourceId;
      if (!createdDependentSourceId) {
        throw new MembershipApplicationError(
          NO_INHERITABLE_EMAIL_SOURCE_MESSAGE,
          422
        );
      }
      const createdDependentSourceValidation = await validateInheritEmailSource(
        { inheritEmailFromId: createdDependentSourceId },
        tx
      );
      if (!createdDependentSourceValidation.ok) {
        throw new MembershipApplicationError(
          createdDependentSourceValidation.error,
          createdDependentSourceValidation.status
        );
      }

      const dependent = await tx.member.create({
        data: {
          email: lockedApplication.applicantEmail,
          passwordHash: applicantPasswordHash,
          emailVerified: true,
          firstName: familyMember.firstName,
          lastName: familyMember.lastName,
          dateOfBirth: dependentDateOfBirth,
          role: "USER",
          ageTier: dependentAgeTier,
          active: true,
          canLogin: false,
          parentMemberId: applicantMember.id,
          inheritParentEmail: true,
          inheritEmailFromId: createdDependentSourceId,
          inheritEmailChoiceId: createdDependentSourceId,
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
      createdMemberIds.push(dependent.id);

      if (familyGroupId) {
        await tx.familyGroupMember.create({
          data: {
            familyGroupId,
            memberId: dependent.id,
          },
          // Result discarded — narrow the implicit RETURNING (#2130 house rule).
          select: { id: true },
        });
      }
    }

    // Issue a set-password token for a created or newly-promoted applicant. A
    // keep-auth mapped applicant already has a password, so no token is minted
    // and no set-password email is sent below.
    if (issueApplicantSetupToken) {
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
    }

    const updatedApplication = await tx.memberApplication.update({
      where: { id: lockedApplication.id },
      data: {
        status: ApplicationStatus.APPROVED,
        adminNotes: cleanNullableString(adminNotes),
        reviewedBy: adminMemberId,
        reviewedAt: new Date(),
      },
    });

    // F22 (#1886): the entrance-fee invoice outbox ROW is written inside this
    // transaction (store: tx) so it commits atomically with the member
    // creation and application approval. It used to be enqueued post-commit,
    // where a process death between the approval commit and the enqueue
    // silently lost the fee — no outbox row, no exception, no admin warning.
    // Only the durable row moves in here; the worker kick that performs the
    // live Xero call stays post-commit below (provider calls never run inside
    // a database transaction).
    let entranceFeeQueue: {
      queueOperationId: string | null;
      message: string;
    } | null = null;
    let entranceFeeQueueFailed = false;
    if (entranceFeeDecision.action === "CREATE") {
      try {
        const entranceFeeInvoiceOptions: {
          createdByMemberId: string;
          amountCents?: number;
          description?: string;
          seasonYear: number;
          asOf: Date;
        } = {
          createdByMemberId: adminMemberId,
          // The season resolved BEFORE this transaction opened. Required by the
          // enqueue whenever a transaction client is supplied, because the
          // joining-fee chain below it (`getEntranceFeeContext` ->
          // `resolveMemberJoiningFeeClassification`) would otherwise read the
          // club's zone from the database while this transaction holds the
          // application and member-lifecycle locks — and that season selects the
          // `JoiningFee` schedule row whose `amountCents` lands on an IMMUTABLE
          // entrance-fee invoice (#2870, correctness review).
          seasonYear,
          // #3123 — and the joining fee's schedule day, from the SAME
          // pre-transaction read for the same reason: `getEffectiveJoiningFee`
          // used to default it from the environment's zone, which picks the
          // wrong schedule row for a club behind its container.
          asOf: joiningFeeAsOf,
        };
        if (entranceFeeDecision.amountCents) {
          entranceFeeInvoiceOptions.amountCents = entranceFeeDecision.amountCents;
        }
        const narration = entranceFeeDecision.narration?.trim();
        if (narration) {
          entranceFeeInvoiceOptions.description = narration;
        }

        entranceFeeQueue = await enqueueXeroEntranceFeeInvoiceOperation(
          applicantMember.id,
          { ...entranceFeeInvoiceOptions, store: tx }
        );
      } catch (err) {
        // Non-database failures stay non-fatal, matching the pre-#1886
        // behavior: the approval commits and the admin sees a warning. A
        // database-level failure aborts the transaction at commit regardless,
        // rolling back the whole approval — either way there is never a
        // committed approval with a silently missing entrance fee.
        logger.error(
          { err, memberId: applicantMember.id },
          "Failed to queue entrance fee invoice for approved application"
        );
        entranceFeeQueueFailed = true;
      }
    }

    return {
      application: updatedApplication,
      applicantMember,
      createdMemberIds,
      mappedMemberIds,
      skipBillingIds: [...skipBillingIds],
      mappedAudits,
      issueApplicantSetupToken,
      applicantKeptAuth,
      entranceFeeQueue,
      entranceFeeQueueFailed,
    };
  });

  // E10: Xero contact sync + subscription billing run over the union of created
  // AND mapped members. Members that already hold season coverage are excluded
  // from billing (skip-with-note) so nobody is double-charged.
  const affectedMemberIds = [
    ...approved.createdMemberIds,
    ...approved.mappedMemberIds,
  ];
  const billingMemberIds = affectedMemberIds.filter(
    (memberId) => !approved.skipBillingIds.includes(memberId)
  );
  const warnings = await syncApprovedMembersToXero(affectedMemberIds);

  // E10 (#1936): the seasonal-coverage skip is decided silently inside the
  // transaction, so surface it per target in the post-approval warnings (the
  // spec's "notes + post-approval warnings") — the admin sees exactly who kept
  // existing coverage and was excluded from billing.
  for (const mapped of approved.mappedAudits) {
    if (mapped.skippedSeasonalAssignment) {
      warnings.push(
        `${mapped.personLabel} was mapped to an existing member who already has this season's membership coverage; the existing coverage was kept and no new subscription charge was raised.`
      );
    }
  }

  // Subscription billing is deliberately post-approval and non-blocking.
  // Complete configuration creates immutable charges and durable Xero work;
  // incomplete configuration creates visible billing exceptions instead of
  // rolling back membership approval.
  try {
    const subscriptionBilling = await queueApprovedMembershipSubscriptionCharges({
      memberIds: billingMemberIds,
      approvedByMemberId: adminMemberId,
    });
    if (subscriptionBilling.exceptionCount > 0) {
      warnings.push(
        `${subscriptionBilling.exceptionCount} membership subscription billing exception${subscriptionBilling.exceptionCount === 1 ? " requires" : "s require"} Finance review`,
      );
    }
  } catch (err) {
    logger.error(
      { err, applicationId, memberIds: billingMemberIds },
      "Failed to queue membership subscription billing after approval",
    );
    warnings.push("Membership subscription billing could not be queued automatically");
  }

  // The entrance-fee outbox row is enqueued INSIDE the approval transaction
  // above (#1886, F22). Post-commit, this block only surfaces the enqueue
  // warning and kicks the outbox worker — the live Xero call — which must
  // stay outside the transaction.
  if (entranceFeeDecision.action === "CREATE") {
    if (approved.entranceFeeQueueFailed) {
      warnings.push("Joining fee invoice could not be queued automatically");
    } else if (
      approved.entranceFeeQueue?.queueOperationId &&
      (await isXeroConnected())
    ) {
      void processQueuedXeroOutboxOperations({ limit: 1 }).catch((err) => {
        logger.error(
          { err, memberId: approved.applicantMember.id },
          "Failed to kick Xero entrance fee outbox worker for approved application"
        );
      });
    }
  } else {
    await logAudit({
      action: "XERO_ENTRANCE_FEE_INVOICE_SKIPPED",
      memberId: adminMemberId,
      targetId: approved.applicantMember.id,
      subjectMemberId: approved.applicantMember.id,
      entityType: "Member",
      entityId: approved.applicantMember.id,
      category: "xero",
      outcome: "success",
      summary: "Joining fee invoice skipped for approved application",
      details: entranceFeeDecision.reason,
      metadata: {
        applicationId,
        reason: entranceFeeDecision.reason,
        source: "member-application-approval",
      },
    });
  }

  // #1786: the applicant approval notice carries the password-setup link and is
  // gated by the admin's per-action notify choice (default is notify). The
  // induction sign-off requests below are token-bearing requests to the assigned
  // signers and stay always-send, regardless of this choice.
  //
  // E10: a keep-auth mapped applicant already has a login and no set-password
  // token was issued, so the set-password email is not sent; the mapping is
  // surfaced instead so the admin knows the applicant was not emailed a link.
  if (approved.applicantKeptAuth) {
    warnings.push(
      "Applicant mapped to an existing login member; no account-setup email was sent."
    );
  } else if (notifyMember !== false) {
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
  }

  // Create the new member's lodge induction record and ask their nominators to
  // sign it off, when the Lodge induction module is enabled. Non-fatal:
  // failures become warnings, like the Xero sync above.
  const inductionModules = await loadEffectiveModuleFlags();
  if (inductionModules.induction) {
    try {
      const nominatorIds = Array.from(new Set([
        approved.application.nominator1Id,
        approved.application.nominator2Id,
      ].filter((value): value is string => Boolean(value))));

      const induction = await createMemberInduction({
        memberId: approved.applicantMember.id,
        kind: "NEW_MEMBER",
        applicationId,
        createdByMemberId: adminMemberId,
        signerMemberIds: nominatorIds,
      });

      if (nominatorIds.length > 0) {
        const nominators = await prisma.member.findMany({
          where: { id: { in: nominatorIds } },
          select: { id: true, email: true, firstName: true },
        });
        const inducteeName =
          `${approved.applicantMember.firstName} ${approved.applicantMember.lastName}`.trim();

        await Promise.all(
          nominators.map(async (nominator) => {
            try {
              await sendInductionSignOffRequestEmail({
                email: nominator.email,
                signerName: nominator.firstName,
                inducteeName,
                signerRoleLabel: "Nominator",
              });
              await prisma.memberInductionAssignedSigner.updateMany({
                where: { inductionId: induction.id, memberId: nominator.id },
                data: { emailSentAt: new Date() },
              });
            } catch (err) {
              logger.error(
                { err, applicationId, nominatorId: nominator.id },
                "Failed to send induction sign-off request email"
              );
              warnings.push(
                `Could not email induction sign-off request to ${nominator.email}`
              );
            }
          })
        );
      }
    } catch (err) {
      logger.error(
        { err, applicationId },
        "Failed to create induction for approved application"
      );
      warnings.push("The induction record could not be created automatically");
    }
  }

  if (warnings.length > 0) {
    await prisma.memberApplication
      .update({
        where: { id: applicationId },
        data: {
          adminNotes: appendPostApprovalWarnings(
            approved.application.adminNotes ?? adminNotes,
            warnings
          ),
        },
      })
      .catch((err) => {
        logger.error(
          { err, applicationId, warnings },
          "Failed to persist membership approval follow-up warnings"
        );
      });
  }

  // #1786: honesty rule — only record the notify choice when the applicant
  // approval email was actually suppressed. The send is otherwise unconditional
  // (the applicant email is a required application field), so no would-have-sent
  // guard is needed. A notify/default choice records no notifyMember field.
  const notifyAuditFields = notifyMember === false ? { notifyMember: false } : {};

  // E10: per mapped person, a critical audit capturing the overwrite. Emitted
  // post-commit alongside the approval audit (matching the create path's
  // post-commit audit style).
  for (const mapped of approved.mappedAudits) {
    await logAudit({
      action: "MEMBER_APPLICATION_MAPPED_TO_EXISTING",
      memberId: adminMemberId,
      actorMemberId: adminMemberId,
      subjectMemberId: mapped.targetMemberId,
      targetId: mapped.targetMemberId,
      entityType: "Member",
      entityId: mapped.targetMemberId,
      // `account` (#2581) — was the invented `membership`; see the note on the
      // nomination-workflow-refreshed writer above.
      category: "account",
      severity: "critical",
      outcome: "success",
      summary: "Membership applicant mapped to an existing member",
      metadata: {
        applicationId,
        ref: mapped.ref,
        applicantRef: approved.application.applicantEmail,
        targetMemberId: mapped.targetMemberId,
        overwrittenFields: mapped.overwrittenFields,
        loginPromoted: mapped.loginPromoted,
        skippedSeasonalAssignment: mapped.skippedSeasonalAssignment,
      },
    });
  }

  // E10: the approval audit gains created/mapped id lists ONLY when the approval
  // actually mapped someone — the all-CREATE `details` stays byte-identical.
  const mappingAuditFields =
    approved.mappedMemberIds.length > 0
      ? {
          createdMemberIds: approved.createdMemberIds,
          mappedMemberIds: approved.mappedMemberIds,
        }
      : {};

  logAudit({
    action: "MEMBERSHIP_APPLICATION_APPROVED",
    category: "account",
    memberId: adminMemberId,
    targetId: applicationId,
    entityType: "MemberApplication",
    entityId: applicationId,
    details: JSON.stringify({
      applicantMemberId: approved.applicantMember.id,
      createdMemberCount: approved.createdMemberIds.length,
      postApprovalWarnings: warnings,
      ...mappingAuditFields,
      ...notifyAuditFields,
    }),
  });

  return {
    ...approved,
    warnings,
  };
}

// Applications an admin may reject: those still gathering nominations and those
// pending admin review. APPROVED/REJECTED are terminal and cannot be rejected.
const REJECTABLE_APPLICATION_STATUSES: readonly ApplicationStatus[] = [
  ApplicationStatus.PENDING_NOMINATORS,
  ApplicationStatus.PENDING_ADMIN,
];

function isRejectableApplicationStatus(status: ApplicationStatus): boolean {
  return REJECTABLE_APPLICATION_STATUSES.includes(status);
}

export async function rejectMemberApplication(
  applicationId: string,
  adminMemberId: string,
  adminNotes?: string | null,
  // #1786: admin per-action email choice. Absent/undefined = notify (default);
  // false = suppress the applicant-facing rejection notice.
  notifyMember?: boolean
) {
  const application = await prisma.memberApplication.findUnique({
    where: { id: applicationId },
  });

  if (!application) {
    throw new MembershipApplicationError("Application not found", 404);
  }

  // Admins can reject an application that is still gathering nominations as well
  // as one pending admin review. A PENDING_NOMINATORS application whose
  // nomination tokens have expired would otherwise be stuck forever, and it
  // keeps blocking a fresh application for the same email (the duplicate-
  // application check blocks on PENDING_NOMINATORS/PENDING_ADMIN). Rejecting it
  // sets REJECTED, which is excluded from that block, so a new application can
  // be submitted. confirmNomination already returns a clean 409 if a nominator
  // opens a token after the application was rejected (issue #817).
  if (!isRejectableApplicationStatus(application.status)) {
    throw new MembershipApplicationError(
      "Only pending applications can be rejected",
      409
    );
  }

  const rejected = await prisma.$transaction(async (tx) => {
    await lockMembershipApplication(tx, applicationId);

    const lockedApplication = await tx.memberApplication.findUnique({
      where: { id: applicationId },
    });

    if (!lockedApplication) {
      throw new MembershipApplicationError("Application not found", 404);
    }

    if (!isRejectableApplicationStatus(lockedApplication.status)) {
      throw new MembershipApplicationError(
        "Only pending applications can be rejected",
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

  // #1786: applicant rejection notice — gated by the admin's per-action notify
  // choice (default is notify).
  if (notifyMember !== false) {
    try {
      await sendMembershipApplicationRejectedEmail({
        email: rejected.applicantEmail,
        firstName: rejected.applicantFirstName,
        adminNotes: cleanNullableString(adminNotes),
      });
    } catch (err) {
      logger.error({ err, applicationId }, "Failed to send rejected membership email");
    }
  }

  // #1786: honesty rule — record the notify choice only when the applicant
  // rejection email was actually suppressed (the send is otherwise
  // unconditional). A notify/default choice records no notifyMember field.
  const notifyAuditFields = notifyMember === false ? { notifyMember: false } : {};

  logAudit({
    action: "MEMBERSHIP_APPLICATION_REJECTED",
    category: "account",
    memberId: adminMemberId,
    targetId: applicationId,
    entityType: "MemberApplication",
    entityId: applicationId,
    details: JSON.stringify({
      applicantEmail: rejected.applicantEmail,
      ...notifyAuditFields,
    }),
  });

  return rejected;
}
