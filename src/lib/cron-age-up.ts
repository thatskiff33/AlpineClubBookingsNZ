import type { AgeTier } from "@prisma/client";
import { prisma } from "./prisma";
import { computeAge, getSeasonStartDate } from "./age-tier";
import { getSeasonYear } from "./utils";
import { sendAgeUpInvitationEmail } from "./email";
import logger from "./logger";
import { issueActionToken } from "./action-tokens";

type AgeUpUpgradeResult = {
  token: string;
  tokenHash: string;
  previousAgeTier: AgeTier;
};

async function rollbackAgeUpUpgrade(
  memberId: string,
  upgrade: Pick<AgeUpUpgradeResult, "tokenHash" | "previousAgeTier">
) {
  await prisma.$transaction(async (tx) => {
    await tx.passwordResetToken.deleteMany({
      where: {
        memberId,
        tokenHash: upgrade.tokenHash,
        used: false,
      },
    });

    await tx.member.updateMany({
      where: {
        id: memberId,
        canLogin: true,
        ageTier: "ADULT",
      },
      data: {
        canLogin: false,
        ageTier: upgrade.previousAgeTier,
      },
    });
  });
}

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
 *  4. Roll back the upgrade/token if email delivery fails so the next run can retry
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
    let upgradeResult: AgeUpUpgradeResult | null = null;

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

      upgradeResult = await prisma.$transaction(async (tx) => {
        const currentMember = await tx.member.findUnique({
          where: { id: member.id },
          select: { canLogin: true, ageTier: true },
        });
        if (!currentMember || currentMember.canLogin) {
          return null;
        }

        await tx.member.update({
          where: { id: member.id },
          data: {
            canLogin: true,
            ageTier: "ADULT",
          },
        });

        const { token, tokenHash } = issueActionToken();
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

        await tx.passwordResetToken.create({
          data: {
            tokenHash,
            memberId: member.id,
            expiresAt,
          },
        });

        return {
          token,
          tokenHash,
          previousAgeTier: currentMember.ageTier,
        };
      });
      if (!upgradeResult) {
        skipped++;
        continue;
      }

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
        upgradeResult.token
      );
      upgradeResult = null;

      upgraded++;
      logger.info(
        { memberId: member.id, firstName: member.firstName },
        "Age-up: member upgraded to ADULT with login"
      );
    } catch (err) {
      if (upgradeResult) {
        try {
          await rollbackAgeUpUpgrade(member.id, upgradeResult);
        } catch (rollbackErr) {
          logger.error(
            { err: rollbackErr, memberId: member.id },
            "Age-up: failed to roll back member upgrade after email failure"
          );
        }
      }

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
