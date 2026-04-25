import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { sendMemberSetupInviteEmail } from "@/lib/email";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { getMemberSetupInviteExpiryDate } from "@/lib/member-setup-invite";

const sendSetupInviteSchema = z.object({
  memberIds: z.array(z.string()).min(1, "At least one member ID is required").max(100),
});

// Simple in-memory throttle for bulk sends (>1 member): 1 per 10 minutes per admin
const bulkThrottle = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST /api/admin/members/send-setup-invite
 * Send one or more first-time password setup invites.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = sendSetupInviteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const { memberIds } = parsed.data;
  const adminId = session.user.id;

  if (memberIds.length > 1) {
    const lastBulk = bulkThrottle.get(adminId) ?? 0;
    const elapsed = Date.now() - lastBulk;
    const cooldown = 10 * 60 * 1000;
    if (elapsed < cooldown) {
      const retryAfter = Math.ceil((cooldown - elapsed) / 1000);
      return NextResponse.json(
        { error: "Bulk setup invite rate limited. Try again later." },
        { status: 429, headers: { "Retry-After": String(retryAfter) } }
      );
    }
    bulkThrottle.set(adminId, Date.now());
  }

  try {
    const members = await prisma.member.findMany({
      where: {
        id: { in: memberIds },
        active: true,
        canLogin: true,
      },
      select: { id: true, email: true, firstName: true, lastName: true },
    });

    const eligibleIds = new Set(members.map((member) => member.id));
    const skipped = memberIds.filter((id) => !eligibleIds.has(id)).length;

    const BATCH_SIZE = 10;
    let sent = 0;

    for (let i = 0; i < members.length; i += BATCH_SIZE) {
      if (i > 0) await sleep(1000);

      const batch = members.slice(i, i + BATCH_SIZE);

      await Promise.all(
        batch.map(async (member) => {
          try {
            const token = randomBytes(32).toString("hex");

            await prisma.passwordResetToken.deleteMany({
              where: { memberId: member.id },
            });

            await prisma.passwordResetToken.create({
              data: {
                token,
                memberId: member.id,
                expiresAt: getMemberSetupInviteExpiryDate(),
              },
            });

            sendMemberSetupInviteEmail(
              member.email,
              member.firstName,
              token
            ).catch((err) => {
              logger.error(
                { err, to: member.email },
                "Failed to send member setup invite"
              );
            });

            logAudit({
              action: "member.setup-invite-sent",
              memberId: adminId,
              targetId: member.id,
              details: `Admin sent account setup invite to ${member.firstName} ${member.lastName} (${member.email})`,
            });

            sent++;
          } catch (err) {
            logger.error(
              { err, memberId: member.id },
              "Failed to create member setup invite token"
            );
          }
        })
      );
    }

    return NextResponse.json({ sent, skipped });
  } catch (error) {
    logger.error({ err: error }, "Failed to send member setup invites");
    return NextResponse.json(
      { error: "Failed to send member setup invites" },
      { status: 500 }
    );
  }
}
