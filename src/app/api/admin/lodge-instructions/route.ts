import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import { sanitizePageContentHtml } from "@/lib/page-content-html";
import {
  LODGE_INSTRUCTION_KEYS,
  getSanitizedLodgeInstructions,
} from "@/lib/lodge-instructions";

const updateSchema = z
  .object({
    key: z.enum(LODGE_INSTRUCTION_KEYS),
    contentHtml: z.string().max(200000),
  })
  .strict();

/**
 * GET /api/admin/lodge-instructions
 * Lists the three lodge instruction documents for the admin editor.
 */
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) {
    return guard.response;
  }

  const documents = await getSanitizedLodgeInstructions();
  return NextResponse.json({ documents });
}

/**
 * PUT /api/admin/lodge-instructions
 * Saves one keyed document. Content is sanitised on write; render paths
 * sanitise again on read.
 */
export async function PUT(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) {
    return guard.response;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const safeContentHtml = sanitizePageContentHtml(parsed.data.contentHtml);

  const existing = await prisma.lodgeInstruction.findUnique({
    where: { key: parsed.data.key },
    select: { contentHtml: true },
  });

  // Upsert by key: the migration backfills all three rows, but tolerate
  // environments where a row is missing rather than failing the save.
  const updated = await prisma.lodgeInstruction.upsert({
    where: { key: parsed.data.key },
    create: {
      key: parsed.data.key,
      contentHtml: safeContentHtml,
      updatedByMemberId: guard.session.user.id,
    },
    update: {
      contentHtml: safeContentHtml,
      updatedByMemberId: guard.session.user.id,
    },
  });

  await prisma.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: "LODGE_INSTRUCTION_UPDATED",
      actor: { memberId: guard.session.user.id },
      entity: {
        type: "LodgeInstruction",
        id: updated.id,
      },
      category: "admin",
      severity: "important",
      outcome: "success",
      summary: `Lodge instructions updated for ${parsed.data.key}`,
      metadata: {
        key: parsed.data.key,
        previousLength: existing?.contentHtml.length ?? 0,
        nextLength: safeContentHtml.length,
      },
      request: getAuditRequestContext(request),
    }),
  );

  return NextResponse.json({
    document: {
      key: updated.key,
      contentHtml: updated.contentHtml,
      updatedAt: updated.updatedAt.toISOString(),
    },
  });
}
