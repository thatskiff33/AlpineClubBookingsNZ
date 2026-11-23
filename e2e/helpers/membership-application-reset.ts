import { expect } from "@playwright/test";
import { DEMO_MEMBER_DEFAULTS } from "../../prisma/demo-member-defaults";
import { MEMBER_ADDRESS_FIELDS, MEMBER_PHONE_FIELDS } from "../../src/lib/member-address";
import {
  MAPPING_APPLICANT,
  MAPPING_APPLICATION_ID,
  MAPPING_TARGET_CAN_LOGIN,
  MAPPING_TARGET_MEMBER_ID,
  MEMBERSHIP_APPLICANT,
  MEMBERSHIP_APPLICATION_ID,
  NOMINATOR_TWO,
} from "./fixtures";
import { e2eDatabaseClient } from "./setup-state";

/*
 * THE SEEDED MEMBERSHIP APPLICATIONS (#5407 item 38), in their own file so only
 * `membership-application.spec.ts` loads it: a mistake here cannot take down
 * an unrelated spec at module load, as importing the seed writers into
 * `reset.ts` once did (they reach `server-only` through the password hasher;
 * `e2e-server-only-reach-census.test.ts` now refuses that for every file
 * Playwright loads).
 *
 * These write the database directly (`E2E_DATABASE_URL`, as `setup-state.ts`
 * does for the pre-setup project), because no admin route can rewind them: an
 * approved application cannot return to pending, a confirmed nomination
 * cannot be un-confirmed, and the approval's member cannot be removed through
 * the product. Each puts back what `prisma/demo-seed.ts` wrote, so a clean
 * first attempt changes nothing that matters, and checks the result.
 */

/**
 * The nominated application (`MEMBERSHIP_APPLICATION_ID`): back to
 * PENDING_NOMINATORS with both nominations unconfirmed, and the member its
 * approval created deleted. The tokens keep their seeded hashes and expiry, so
 * the known raw tokens still open them. Deleting the member cascades what the
 * approval created with it (the set-password token, any induction, access
 * roles, notification preferences); a row that cannot cascade fails the reset
 * loudly rather than leaving a duplicate login behind. Audit and email log
 * rows are history and stay.
 */
export async function resetSeededMembershipApplication(): Promise<void> {
  const prisma = e2eDatabaseClient();
  try {
    await prisma.$transaction(async (tx) => {
      await tx.member.deleteMany({ where: { email: MEMBERSHIP_APPLICANT.email } });
      await tx.nominationToken.updateMany({
        where: { applicationId: MEMBERSHIP_APPLICATION_ID },
        data: { confirmedAt: null },
      });
      await tx.memberApplication.update({
        where: { id: MEMBERSHIP_APPLICATION_ID },
        data: {
          status: "PENDING_NOMINATORS",
          nominator1ConfirmedAt: null,
          nominator2ConfirmedAt: null,
          adminNotes: null,
          reviewedBy: null,
          reviewedAt: null,
        },
      });
    });
    const application = await prisma.memberApplication.findUniqueOrThrow({
      where: { id: MEMBERSHIP_APPLICATION_ID },
      select: { status: true, nominationTokens: { select: { confirmedAt: true } } },
    });
    expect(application.status).toBe("PENDING_NOMINATORS");
    expect(application.nominationTokens.map((token) => token.confirmedAt)).toEqual([null, null]);
    expect(await prisma.member.count({ where: { email: MEMBERSHIP_APPLICANT.email } })).toBe(0);
  } finally {
    await prisma.$disconnect();
  }
}

/** Every column of a list set to null, for the seeded "not given" fields. */
function nulls<const T extends readonly string[]>(fields: T): Record<T[number], null> {
  return Object.fromEntries(fields.map((field) => [field, null])) as Record<T[number], null>;
}

/**
 * The mapping application (`MAPPING_APPLICATION_ID`): back to PENDING_ADMIN
 * (its nominators stay confirmed, as seeded), and the existing member it maps
 * onto restored in place. The approval's mapping update
 * (`approveMemberApplication` in `src/lib/nomination.ts`) can change exactly
 * these columns, and each goes back to what the seed wrote:
 * - name and email: the fixture's `MAPPING_APPLICANT`;
 * - date of birth, phone and address: not given (the seed sets none);
 * - age tier and email verification: `DEMO_MEMBER_DEFAULTS`;
 * - login: `MAPPING_TARGET_CAN_LOGIN`, and the password hash the promotion
 *   replaced with an unusable placeholder. Every seeded member shares one
 *   demo hash, so it is copied from `NOMINATOR_TWO`, whose password no spec
 *   changes, rather than computed: the hasher is `server-only`;
 * - the confirmation stamps and the email-inheritance fields: unset, as seeded.
 * Rows the approval created for the member are deleted: its set-password
 * token and any induction for this application.
 */
export async function resetSeededMappingApplication(): Promise<void> {
  const prisma = e2eDatabaseClient();
  try {
    const { passwordHash } = await prisma.member.findFirstOrThrow({
      where: { email: NOMINATOR_TWO.email },
      select: { passwordHash: true },
    });
    await prisma.$transaction(async (tx) => {
      await tx.passwordResetToken.deleteMany({ where: { memberId: MAPPING_TARGET_MEMBER_ID } });
      await tx.memberInduction.deleteMany({ where: { applicationId: MAPPING_APPLICATION_ID } });
      await tx.member.update({
        where: { id: MAPPING_TARGET_MEMBER_ID },
        data: {
          email: MAPPING_APPLICANT.email,
          firstName: MAPPING_APPLICANT.firstName,
          lastName: MAPPING_APPLICANT.lastName,
          dateOfBirth: null,
          ...nulls(MEMBER_PHONE_FIELDS),
          ...nulls(MEMBER_ADDRESS_FIELDS),
          ageTier: DEMO_MEMBER_DEFAULTS.ageTier,
          emailVerified: DEMO_MEMBER_DEFAULTS.emailVerified,
          canLogin: MAPPING_TARGET_CAN_LOGIN,
          passwordHash,
          profileCompletedAt: null,
          detailsConfirmedAt: null,
          detailsConfirmedByMemberId: null,
          onboardingConfirmedAt: null,
          inheritParentEmail: false,
          inheritEmailFromId: null,
          inheritEmailChoiceId: null,
        },
      });
      await tx.memberApplication.update({
        where: { id: MAPPING_APPLICATION_ID },
        data: { status: "PENDING_ADMIN", adminNotes: null, reviewedBy: null, reviewedAt: null },
      });
    });
    const member = await prisma.member.findUniqueOrThrow({
      where: { id: MAPPING_TARGET_MEMBER_ID },
      select: { email: true, canLogin: true, dateOfBirth: true, phoneNumber: true },
    });
    expect(member).toEqual({
      email: MAPPING_APPLICANT.email,
      canLogin: MAPPING_TARGET_CAN_LOGIN,
      dateOfBirth: null,
      phoneNumber: null,
    });
  } finally {
    await prisma.$disconnect();
  }
}
