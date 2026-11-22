import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonRequestBody } from "@/lib/api-json";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { sendMemberSetupInviteEmail } from "@/lib/email";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { issueActionToken } from "@/lib/action-tokens";
import {
  MEMBER_SETUP_INVITE_TTL_DAYS,
  getMemberSetupInviteExpiryDate,
} from "@/lib/member-setup-invite";

const sendSetupInviteSchema = z.object({
  memberIds: z.array(z.string()).min(1, "At least one member ID is required").max(100),
});

// Per-member outcome of the setup-invite send. A token is created for every
// eligible member (so the invite exists / can be resent); `failed` means the
// email delivery rejected even though the token was minted, so the admin can
// retry that member specifically.
type SetupInviteResult = {
  memberId: string;
  email: string;
  name: string;
  status: "sent" | "failed";
  error?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST /api/admin/members/send-setup-invite
 * Send one or more first-time password setup invites.
 *
 * There is no bulk cooldown: the 100/request zod cap plus SES batch pacing
 * (batches of 10, 1s apart) are the sole provider protections. The response is
 * honest — `sent` counts emails that actually delivered, `failed` counts tokens
 * that were minted but whose email rejected, and `results` carries the
 * per-member outcome so the admin UI can surface failures and offer a retry.
 */
export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const jsonBody = await parseJsonRequestBody(req, { error: "Invalid JSON" });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = sendSetupInviteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const { memberIds } = parsed.data;
  const adminId = session.user.id;

  try {
    // canLogin is the source of truth; legacy parent links may remain on adult login records.
    const members = await prisma.member.findMany({
      where: {
        id: { in: memberIds },
        active: true,
        canLogin: true,
      },
      select: { id: true, email: true, firstName: true, lastName: true },
    });

    const eligibleIds = new Set(members.map((member) => member.id));
    const skippedIds = memberIds.filter((id) => !eligibleIds.has(id));
    const skipped = skippedIds.length;

    const BATCH_SIZE = 10;
    const results: SetupInviteResult[] = [];

    for (let i = 0; i < members.length; i += BATCH_SIZE) {
      if (i > 0) await sleep(1000);

      const batch = members.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.all(
        batch.map(async (member): Promise<SetupInviteResult> => {
          const name = `${member.firstName} ${member.lastName}`;
          try {
            const { token, tokenHash } = issueActionToken();

            await prisma.passwordResetToken.deleteMany({
              where: { memberId: member.id },
            });

            await prisma.passwordResetToken.create({
              data: {
                tokenHash,
                memberId: member.id,
                expiresAt: getMemberSetupInviteExpiryDate(),
              },
            });

            // Token creation = the invite exists. Record the audit regardless of
            // whether the email itself delivers so a failed-email retry stays
            // traceable.
            logAudit({
              action: "member.setup-invite-sent",
              // `security` for the same reason as `member.password-reset-sent`
              // (#2581 decision 3): a setup invite IS a credential-issuing
              // event, whatever channel carries it.
              category: "security",
              memberId: adminId,
              targetId: member.id,
              entityType: "Member",
              entityId: member.id,
              details: JSON.stringify({
                recipientEmail: member.email,
                recipientName: name,
                kind: "invite",
                expiryLabel: `${MEMBER_SETUP_INVITE_TTL_DAYS} days`,
              }),
            });

            try {
              await sendMemberSetupInviteEmail(member.email, member.firstName, token);
              return { memberId: member.id, email: member.email, name, status: "sent" };
            } catch (err) {
              logger.error(
                { err, to: member.email },
                "Failed to send member setup invite"
              );
              return {
                memberId: member.id,
                email: member.email,
                name,
                status: "failed",
                error: "Email delivery failed",
              };
            }
          } catch (err) {
            logger.error(
              { err, memberId: member.id },
              "Failed to create member setup invite token"
            );
            return {
              memberId: member.id,
              email: member.email,
              name,
              status: "failed",
              error: "Could not create invite",
            };
          }
        })
      );

      results.push(...batchResults);
    }

    const sent = results.filter((result) => result.status === "sent").length;
    const failed = results.filter((result) => result.status === "failed").length;

    return NextResponse.json({ sent, skipped, failed, skippedIds, results });
  } catch (error) {
    logger.error({ err: error }, "Failed to send member setup invites");
    return NextResponse.json(
      { error: "Failed to send member setup invites" },
      { status: 500 }
    );
  }
}
