import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  EMAIL_TEMPLATE_DEFINITIONS,
  EMAIL_TEMPLATE_KEY_SET,
} from "@/lib/email-message-registry";
import { validateEmailTemplateContent } from "@/lib/email-message-renderer";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

interface EmailTemplateOverrideRecord {
  templateName: string;
  subject: string | null;
  bodyText: string | null;
  updatedAt: Date;
  updatedByMemberId: string | null;
}

const templateUpdateSchema = z
  .object({
    templateName: z.string().trim().min(1),
    subject: z.string().trim().max(500).nullable().optional(),
    bodyText: z.string().trim().max(10000).nullable().optional(),
  })
  .strict()
  .refine(
    (value) => value.subject !== undefined || value.bodyText !== undefined,
    "A subject or bodyText update is required",
  );

async function loadOverrides() {
  const delegate = (prisma as unknown as {
    emailTemplateOverride?: {
      findMany: () => Promise<EmailTemplateOverrideRecord[]>;
    };
  }).emailTemplateOverride;

  if (!delegate) return [];
  return delegate.findMany();
}

function serializeOverride(override: EmailTemplateOverrideRecord) {
  return {
    subject: override.subject,
    bodyText: override.bodyText,
    updatedAt: override.updatedAt.toISOString(),
    updatedByMemberId: override.updatedByMemberId,
  };
}

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const overrides = await loadOverrides();
  const staleOverrides = overrides
    .filter((override) => !EMAIL_TEMPLATE_KEY_SET.has(override.templateName))
    .map((override) => ({
      templateName: override.templateName,
      ...serializeOverride(override),
    }));
  const overrideByTemplate = new Map(
    overrides
      .filter((override) => EMAIL_TEMPLATE_KEY_SET.has(override.templateName))
      .map((override) => [override.templateName, override]),
  );

  return NextResponse.json({
    templates: EMAIL_TEMPLATE_DEFINITIONS.map((definition) => {
      const override = overrideByTemplate.get(definition.key);
      return {
        ...definition,
        override: override ? serializeOverride(override) : null,
      };
    }),
    staleOverrideCount: staleOverrides.length,
    staleOverrides,
  });
}

export async function PUT(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = templateUpdateSchema.safeParse(body);
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
    subject: parsed.data.subject ?? "",
    bodyText: parsed.data.bodyText ?? "",
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

  const update = {
    subject: parsed.data.subject || null,
    bodyText: parsed.data.bodyText || null,
    updatedByMemberId: session.user.id,
  };
  const before = await prisma.emailTemplateOverride.findUnique({
    where: { templateName: parsed.data.templateName },
  });

  const record = await prisma.emailTemplateOverride.upsert({
    where: { templateName: parsed.data.templateName },
    create: {
      templateName: parsed.data.templateName,
      ...update,
    },
    update,
  });

  await prisma.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: "EMAIL_TEMPLATE_OVERRIDE_UPDATED",
      actor: { memberId: session.user.id },
      entity: {
        type: "EmailTemplateOverride",
        id: parsed.data.templateName,
      },
      category: "admin",
      severity: "important",
      outcome: "success",
      summary: "Email template override updated",
      metadata: {
        templateName: parsed.data.templateName,
        previousOverride: before,
        newOverride: update,
      },
      request: getAuditRequestContext(request),
    }),
  );

  return NextResponse.json({ override: record });
}
