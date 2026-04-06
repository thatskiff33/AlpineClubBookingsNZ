import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendAdminPasswordResetEmail } from "@/lib/email";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";

const sendPasswordResetSchema = z.object({
  memberIds: z.array(z.string()).min(1, "At least one member ID is required").max(100),
});

// Simple in-memory throttle for bulk sends (>1 member): 1 per 10 minutes per admin
const bulkThrottle = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST /api/admin/members/send-password-reset
 * Send password reset emails to one or more members.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = sendPasswordResetSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const { memberIds } = parsed.data;
  const adminId = session.user.id;

  // Throttle bulk sends (>1 member) to 1 per 10 minutes per admin
  if (memberIds.length > 1) {
    const lastBulk = bulkThrottle.get(adminId) ?? 0;
    const elapsed = Date.now() - lastBulk;
    const cooldown = 10 * 60 * 1000; // 10 minutes
    if (elapsed < cooldown) {
      const retryAfter = Math.ceil((cooldown - elapsed) / 1000);
      return NextResponse.json(
        { error: "Bulk password reset rate limited. Try again later." },
        { status: 429, headers: { "Retry-After": String(retryAfter) } }
      );
    }
    bulkThrottle.set(adminId, Date.now());
  }

  try {
    // Fetch only active primary members with an email
    const members = await prisma.member.findMany({
      where: {
        id: { in: memberIds },
        active: true,
        parentMemberId: null,
      },
      select: { id: true, email: true, firstName: true, lastName: true },
    });

    const eligibleIds = new Set(members.map((m) => m.id));
    const skipped = memberIds.filter((id) => !eligibleIds.has(id)).length;

    // Create tokens and send emails in batches of 10
    const BATCH_SIZE = 10;
    let sent = 0;

    for (let i = 0; i < members.length; i += BATCH_SIZE) {
      if (i > 0) await sleep(1000);

      const batch = members.slice(i, i + BATCH_SIZE);

      await Promise.all(
        batch.map(async (member) => {
          try {
            const token = crypto.randomUUID();
            const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

            await prisma.passwordResetToken.create({
              data: {
                token,
                memberId: member.id,
                expiresAt,
              },
            });

            sendAdminPasswordResetEmail(member.email, token).catch((err) => {
              logger.error(
                { err, to: member.email },
                "Failed to send admin password reset email"
              );
            });

            logAudit({
              action: "member.password-reset-sent",
              memberId: adminId,
              targetId: member.id,
              details: `Admin sent password reset to ${member.firstName} ${member.lastName} (${member.email})`,
            });

            sent++;
          } catch (err) {
            logger.error(
              { err, memberId: member.id },
              "Failed to create password reset token"
            );
          }
        })
      );
    }

    return NextResponse.json({ sent, skipped });
  } catch (error) {
    logger.error({ err: error }, "Failed to send password reset emails");
    return NextResponse.json(
      { error: "Failed to send password reset emails" },
      { status: 500 }
    );
  }
}
