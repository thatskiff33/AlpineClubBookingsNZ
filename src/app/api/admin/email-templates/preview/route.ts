import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  EMAIL_TEMPLATE_KEY_SET,
  getEmailTemplateDefinition,
} from "@/lib/email-message-registry";
import {
  renderEmailTemplatePreview,
  validateEmailTemplateContent,
} from "@/lib/email-message-renderer";
import { requireAdmin } from "@/lib/session-guards";

const previewSchema = z
  .object({
    templateName: z.string().trim().min(1),
    subject: z.string().trim().min(1).max(500),
    bodyText: z.string().trim().min(1).max(10000),
  })
  .strict();

export async function POST(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = previewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  if (!EMAIL_TEMPLATE_KEY_SET.has(parsed.data.templateName)) {
    return NextResponse.json({ error: "Unknown email template" }, { status: 400 });
  }

  const validation = validateEmailTemplateContent({
    templateName: parsed.data.templateName,
    subject: parsed.data.subject,
    bodyText: parsed.data.bodyText,
  });
  if (!validation.valid) {
    return NextResponse.json(
      {
        error: "Invalid email template",
        issues: validation.issues,
        unknownTokens: validation.unknownTokens,
        disallowedTokens: validation.disallowedTokens,
        missingRequiredTokens: validation.missingRequiredTokens,
        sensitiveSubjectTokens: validation.sensitiveSubjectTokens,
        unsafeLinks: validation.unsafeLinks,
      },
      { status: 400 },
    );
  }

  const definition = getEmailTemplateDefinition(parsed.data.templateName);

  const preview = await renderEmailTemplatePreview({
    subject: parsed.data.subject,
    bodyText: parsed.data.bodyText,
    templateData: definition?.sampleData,
  });

  return NextResponse.json(preview);
}
