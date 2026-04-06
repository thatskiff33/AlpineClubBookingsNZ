/**
 * N-09: Bulk Member Communication
 * POST /api/admin/communications/send
 * Admin-only. Rate limited to 1 bulk send per hour.
 * Respects marketingEmails notification preference.
 * Sanitises input to prevent HTML/header injection.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { checkRateLimit, type RateLimitConfig } from "@/lib/rate-limit";
import { bulkCommunicationTemplate } from "@/lib/email-templates";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";

const bulkSendRateLimit: RateLimitConfig = {
  id: "bulk-communication",
  limit: 1,
  windowSeconds: 60 * 60, // 1 hour
};

const sendSchema = z.object({
  subject: z
    .string()
    .min(1, "Subject is required")
    .max(200, "Subject must be under 200 characters")
    .transform((s) => s.replace(/[\r\n]/g, " ")), // Strip newlines to prevent header injection
  body: z
    .string()
    .min(1, "Body is required")
    .max(10000, "Body must be under 10,000 characters"),
  recipientFilter: z.enum(["all", "members-only", "admins-only", "custom"]),
  memberIds: z.array(z.string()).optional(),
});

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Rate limit: 1 bulk send per hour (keyed by "admin" since it's a global limit)
  const rlResult = checkRateLimit(bulkSendRateLimit, "admin-global");
  if (!rlResult.success) {
    const retryAfter = Math.ceil((rlResult.resetAt - Date.now()) / 1000);
    return NextResponse.json(
      { error: "Rate limit exceeded. Maximum 1 bulk send per hour." },
      {
        status: 429,
        headers: { "Retry-After": String(retryAfter) },
      }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = sendSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { subject, body: messageBody, recipientFilter, memberIds } = parsed.data;

  // Build recipient query
  let whereClause: Record<string, unknown> = { active: true };
  if (recipientFilter === "members-only") {
    whereClause.role = "MEMBER";
  } else if (recipientFilter === "admins-only") {
    whereClause.role = "ADMIN";
  } else if (recipientFilter === "custom") {
    if (!memberIds || memberIds.length === 0) {
      return NextResponse.json(
        { error: "memberIds required for custom filter" },
        { status: 400 }
      );
    }
    whereClause.id = { in: memberIds };
  }
  // "all" uses just { active: true }

  const recipients = await prisma.member.findMany({
    where: whereClause,
    select: {
      id: true,
      email: true,
      notificationPreference: {
        select: { marketingEmails: true },
      },
    },
  });

  // Filter out members who have marketingEmails: false
  // Default (no preference record) is marketingEmails: false, so exclude those too
  const eligibleRecipients = recipients.filter(
    (r) => r.notificationPreference?.marketingEmails === true
  );

  // Generate the email HTML (using escapeHtml inside the template)
  const html = bulkCommunicationTemplate(subject, messageBody);

  // Queue emails via EmailLog (let retry cron handle actual delivery if needed)
  let queued = 0;
  for (const recipient of eligibleRecipients) {
    try {
      await prisma.emailLog.create({
        data: {
          to: recipient.email,
          subject,
          templateName: "bulk-communication",
          htmlBody: html,
          status: "QUEUED",
          lastAttemptAt: new Date(),
        },
      });
      queued++;
    } catch (err) {
      logger.error(
        { err, email: recipient.email },
        "Failed to queue bulk communication email"
      );
    }
  }

  // Send emails in background (fire-and-forget)
  (async () => {
    const { sendEmail } = await import("@/lib/email");
    for (const recipient of eligibleRecipients) {
      try {
        await sendEmail({
          to: recipient.email,
          subject,
          html,
          templateName: "bulk-communication",
        });
      } catch (err) {
        logger.error(
          { err, email: recipient.email },
          "Failed to send bulk communication email"
        );
      }
    }
  })();

  logAudit({
    action: "BULK_COMMUNICATION_SENT",
    memberId: session.user.id,
    details: JSON.stringify({
      subject,
      recipientFilter,
      totalRecipients: recipients.length,
      eligibleRecipients: eligibleRecipients.length,
      queued,
    }),
  });

  return NextResponse.json({
    success: true,
    totalRecipients: recipients.length,
    eligibleRecipients: eligibleRecipients.length,
    queued,
    filteredByPreference: recipients.length - eligibleRecipients.length,
  });
}
