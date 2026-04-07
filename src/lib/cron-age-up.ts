import { randomBytes } from "crypto";
import { prisma } from "./prisma";
import { computeAge, getSeasonStartDate } from "./age-tier";
import { getSeasonYear } from "./utils";
import { sendAgeUpInvitationEmail } from "./email";
import logger from "./logger";

/**
 * Daily cron: detect members who have turned 18 (at the season reference date)
 * and invite them to set up their own login.
 *
 * Criteria:
 *  - active: true
 *  - canLogin: false
 *  - ageTier: not ADULT (CHILD or YOUTH)
 *  - dateOfBirth indicates age >= 18 at season start (April 1)
 *
 * For each qualifying member:
 *  1. Update ageTier → ADULT, canLogin → true
 *  2. Create a password reset token (so they can set a password)
 *  3. Send age-up invitation email
 *
 * Idempotency: members who already have canLogin=true are excluded.
 * EmailLog deduplication: we check for a prior "age-up-invitation" email to
 * the same member to avoid re-sending if the cron runs multiple times.
 */
export async function checkAgeUpMembers(): Promise<{
  processed: number;
  upgraded: number;
  skipped: number;
  failed: number;
}> {
  const seasonYear = getSeasonYear();
  const seasonStart = getSeasonStartDate(seasonYear);

  // Find non-login members whose DOB puts them at 18+ on season start
  // We compute the cutoff DOB: born on or before (seasonStart - 18 years)
  const cutoffDate = new Date(seasonStart);
  cutoffDate.setFullYear(cutoffDate.getFullYear() - 18);

  const candidates = await prisma.member.findMany({
    where: {
      active: true,
      canLogin: false,
      ageTier: { in: ["CHILD", "YOUTH"] },
      dateOfBirth: {
        not: null,
        lte: cutoffDate,
      },
    },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      dateOfBirth: true,
      inheritEmailFromId: true,
      inheritEmailFrom: { select: { email: true } },
    },
  });

  let upgraded = 0;
  let skipped = 0;
  let failed = 0;

  for (const member of candidates) {
    try {
      // Double-check age (belt-and-suspenders with the DB query)
      if (!member.dateOfBirth) {
        skipped++;
        continue;
      }
      const age = computeAge(member.dateOfBirth, seasonStart);
      if (age < 18) {
        skipped++;
        continue;
      }

      // Check if we already sent an age-up email to this member
      const alreadySent = await prisma.emailLog.findFirst({
        where: {
          to: member.email,
          templateName: "age-up-invitation",
          status: { in: ["SENT", "QUEUED"] },
        },
      });
      if (alreadySent) {
        skipped++;
        continue;
      }

      // Update member: set canLogin=true, ageTier=ADULT
      await prisma.member.update({
        where: { id: member.id },
        data: {
          canLogin: true,
          ageTier: "ADULT",
        },
      });

      // Create password reset token (7-day expiry for age-up — generous window)
      const token = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      await prisma.passwordResetToken.create({
        data: {
          token,
          memberId: member.id,
          expiresAt,
        },
      });

      // Resolve effective email (may be inherited from parent)
      let recipientEmail = member.email;
      if (member.inheritEmailFromId) {
        recipientEmail =
          member.inheritEmailFrom?.email ?? member.email;
      }

      // Send invitation email (fire-and-forget style within the loop)
      await sendAgeUpInvitationEmail(
        recipientEmail,
        member.firstName,
        token
      );

      upgraded++;
      logger.info(
        { memberId: member.id, firstName: member.firstName },
        "Age-up: member upgraded to ADULT with login"
      );
    } catch (err) {
      failed++;
      logger.error(
        { err, memberId: member.id },
        "Age-up: failed to process member"
      );
    }
  }

  return {
    processed: candidates.length,
    upgraded,
    skipped,
    failed,
  };
}
