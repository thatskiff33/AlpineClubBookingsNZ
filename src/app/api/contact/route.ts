import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonRequestBody } from "@/lib/api-json";
import { sendEmail } from "@/lib/email";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { escapeHtml } from "@/lib/email-templates/escape";
import { websiteContactTemplate } from "@/lib/email-templates/admin-ops";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { loadEmailMessageSettings } from "@/lib/email-message-settings";
import { renderEmailHtml } from "@/lib/email-theme";

const noEmailHeaderCrlf = (value: string) => !/[\r\n]/.test(value);

const contactSchema = z.object({
  name: z.string().min(1, "Name is required").max(200).refine(
    noEmailHeaderCrlf,
    "Name cannot contain line breaks"
  ),
  email: z.string().email("Invalid email address").max(200),
  message: z.string().min(1, "Message is required").max(5000),
  recipient: z.string().max(50).refine(
    noEmailHeaderCrlf,
    "Recipient cannot contain line breaks"
  ).optional(),
});

async function resolveCommitteeRecipient(recipient: string) {
  return prisma.committeeAssignment.findFirst({
    where: {
      id: recipient,
      isActive: true,
      published: true,
      contactable: true,
      committeeRole: { isActive: true },
      member: { active: true },
    },
    select: {
      contactEmailMode: true,
      contactEmailOverride: true,
      committeeRole: { select: { name: true, contactEmail: true } },
      member: { select: { email: true } },
    },
  });
}

function buildRecipientLabel(roleName: string) {
  const normalized = roleName.replace(/[\r\n]+/g, " ").trim();
  return normalized ? ` (to ${normalized})` : "";
}

export async function POST(request: Request) {
  const rateLimited = await applyRateLimit(rateLimiters.contact, request);
  if (rateLimited) return rateLimited;

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON payload",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  try {
    const result = contactSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        { error: "Invalid input", details: result.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { name, email, message, recipient } = result.data;

    // DB-first default recipient (C6 #1985 / C7 #1986): resolve the club contact
    // address solely from EmailMessageSetting.contactEmail (async route handler —
    // it can await), which itself falls back to the support address per
    // getDefaultEmailMessageSettings precedence. The `CONTACT_EMAIL` env override
    // was removed (#1986) — EmailMessageSetting is the single source for email
    // identity. A named committee recipient below still wins.
    const contactEmail = (await loadEmailMessageSettings()).contactEmail;
    let toEmail = contactEmail;
    let recipientLabel = "";
    let logRecipient = contactEmail;

    if (recipient) {
      const committeeAssignment = await resolveCommitteeRecipient(recipient);

      if (committeeAssignment) {
        recipientLabel = buildRecipientLabel(
          committeeAssignment.committeeRole.name,
        );
        const roleEmail =
          committeeAssignment.committeeRole.contactEmail?.trim() || null;
        const memberEmail = committeeAssignment.member.email?.trim() || null;
        const overrideEmail =
          committeeAssignment.contactEmailOverride?.trim() || null;
        let committeeRecipientEmail: string | null;
        switch (committeeAssignment.contactEmailMode) {
          case "CUSTOM":
            committeeRecipientEmail = overrideEmail;
            break;
          case "MEMBER":
            committeeRecipientEmail = memberEmail;
            break;
          default:
            committeeRecipientEmail = roleEmail; // ROLE
            break;
        }
        if (!committeeRecipientEmail) {
          // Selected mode's address is missing/deactivated — fall back
          // ROLE -> member so public contact mail is never black-holed.
          committeeRecipientEmail = roleEmail || memberEmail;
          logger.warn(
            { assignmentId: recipient, mode: committeeAssignment.contactEmailMode },
            "Committee contact email fell back to role/member address",
          );
        }
        if (committeeRecipientEmail) {
          toEmail = committeeRecipientEmail;
          logRecipient = `committee-contact:${recipient}`;
        }
      }
    }

    await sendEmail({
      to: toEmail,
      subject: `Website Contact${recipientLabel}: ${escapeHtml(name)}`,
      html: await renderEmailHtml(() => websiteContactTemplate({ name, email, message })),
      // Website contact form: no booking involved (#2258).
      bookingContext: "none",
      templateName: "website-contact",
      templateData: {
        recipientLabel,
        name,
        email,
        message,
      },
      logRecipient,
    });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Failed to send message. Please try again later." },
      { status: 500 }
    );
  }
}
