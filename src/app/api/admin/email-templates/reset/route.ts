import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import { EMAIL_TEMPLATE_KEY_SET } from "@/lib/email-message-registry";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

const resetSchema = z.object({
  templateName: z.string().trim().min(1),
});

// The save route caps a stored body at 10,000 characters and a subject at 500
// (src/app/api/admin/email-templates/route.ts), so this is the largest wording
// a club can have to lose — and, because the audit row is the only copy left
// after a reset, the length the archive has to keep whole. Audit metadata
// otherwise clips every string at 1000 characters, which turned a measured
// 1748-character body into 1014 characters ending "[TRUNCATED]" (#2269 second
// review). Secret, card-number and sensitive-key redaction all still run; see
// AuditMetadataOptions.
// Fork #38 raised this to the bodyHtml cap (20k): the archive is the ONLY
// surviving copy of a club's wording after a reset, and since #38 that
// wording can be a rich body whose formatting would otherwise be destroyed
// irrecoverably (review finding M6).
const RESET_ARCHIVE_MAX_STRING_LENGTH = 20_000;

export async function POST(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "support", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = resetSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  if (!EMAIL_TEMPLATE_KEY_SET.has(parsed.data.templateName)) {
    return NextResponse.json({ error: "Unknown email template" }, { status: 400 });
  }

  // #2269 review: this is one click, irreversible, and the editor now points at
  // it from three different places. Read the row BEFORE deleting it and record
  // the wording in the audit metadata — the same content #2269's own migration
  // treats as precious enough to store in full when it edits a single line of
  // it. Without this the destroyed subject and body existed nowhere afterwards
  // and a club that reset by mistake had lost years of wording for good.
  //
  // IN FULL, and that word is load-bearing (#2269 second review). The first cut
  // of this went through the ordinary metadata sanitizer, which clips every
  // string at 1000 characters: a real 1748-character body was stored as 1014
  // characters ending "[TRUNCATED]", so the two halves of this change disagreed
  // about the same content — the migration's SQL kept a club's wording verbatim
  // while the reset path silently kept two thirds of it, under a confirmation
  // dialog and a docs page that both promise the audit log is the copy. Archive
  // mode keeps it whole and still redacts secrets, card numbers and sensitive
  // keys.
  //
  // "In full" therefore has ONE honest caveat, and the editor and the guide
  // both state it rather than leaving it as a surprise: the key-value redaction
  // still fires on template text shaped like `password: value`, and it takes
  // the whole LINE, not a fragment. The shipped password-reset body's "Reset
  // Password: {{BASE_URL}}/reset-password?token={{token}}" is archived as
  // "Reset Password=[REDACTED]". That is the redaction earning its keep, not a
  // defect — but a club restoring that message retypes that one line.
  const before = await prisma.emailTemplateOverride.findUnique({
    where: { templateName: parsed.data.templateName },
  });

  const result = await prisma.emailTemplateOverride.deleteMany({
    where: { templateName: parsed.data.templateName },
  });
  await prisma.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: "EMAIL_TEMPLATE_OVERRIDE_RESET",
      actor: { memberId: session.user.id },
      entity: {
        type: "EmailTemplateOverride",
        id: parsed.data.templateName,
      },
      category: "admin",
      severity: "important",
      outcome: "success",
      summary: "Email template override reset",
      metadata: {
        templateName: parsed.data.templateName,
        deletedOverride: before
          ? {
              subject: before.subject,
              bodyText: before.bodyText,
              // Fork #38: the rich body IS the club's wording now — without
              // this the formatting survives nowhere after a reset (M6).
              bodyHtml:
                (before as { bodyHtml?: string | null }).bodyHtml ?? null,
              updatedByMemberId: before.updatedByMemberId,
              updatedAt: before.updatedAt.toISOString(),
            }
          : null,
      },
      request: getAuditRequestContext(request),
    }, {
      archiveText: { maxStringLength: RESET_ARCHIVE_MAX_STRING_LENGTH },
    }),
  );

  return NextResponse.json({ reset: result.count > 0 });
}
