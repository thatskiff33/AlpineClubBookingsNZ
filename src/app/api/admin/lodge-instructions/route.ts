import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonRequestBody } from "@/lib/api-json";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { isPrismaUniqueConstraintError } from "@/lib/prisma-errors";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import { sanitizePageContentHtml } from "@/lib/page-content-html";
import {
  LODGE_INSTRUCTION_KEYS,
  LODGE_INSTRUCTION_LABELS,
} from "@/lib/lodge-instructions";

// Per-lodge override partition (lodge-scoping contract): an omitted lodgeId
// means the CLUB-WIDE (null lodgeId) partition — deliberately NOT the
// default lodge, so single-lodge clubs keep editing the club-wide documents.
// A lodge's row REPLACES the club-wide document of that key for that lodge.
// Override removal uses an explicit `remove: true` flag (rather than the
// cancellation route's empty-payload convention) because an empty
// contentHtml is a legitimate club-wide save and sanitisation can strip a
// non-empty submission down to "", which must not silently delete a row.
const updateSchema = z
  .object({
    key: z.enum(LODGE_INSTRUCTION_KEYS),
    contentHtml: z.string().max(200000).optional(),
    lodgeId: z.string().min(1).optional(),
    remove: z.boolean().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.remove) {
      if (!data.lodgeId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["remove"],
          message:
            "Only a lodge override can be removed; the club-wide documents can only be edited",
        });
      }
    } else if (data.contentHtml === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contentHtml"],
        message: "contentHtml is required",
      });
    }
  });

/**
 * An explicit lodgeId must name an active lodge. Validated directly (not
 * via resolveOptionalActiveLodgeId) because an omitted lodgeId on this
 * route means the club-wide partition, never the default lodge.
 */
async function validateActiveLodge(lodgeId: string): Promise<boolean> {
  const lodge = await prisma.lodge.findUnique({
    where: { id: lodgeId },
    select: { active: true },
  });
  return lodge?.active === true;
}

/**
 * GET /api/admin/lodge-instructions?lodgeId=<id>
 * Lists the requested partition (club-wide when lodgeId is omitted) for the
 * admin editor. Exact partition, no fallback merge: a lodge key without an
 * override row comes back empty with hasOverride false, so the editor can
 * offer "create override" instead of silently showing club-wide content.
 */
export async function GET(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "view" },
  });
  if (!guard.ok) {
    return guard.response;
  }

  // Editor surface: tokens stay unresolved so admins see and can edit the
  // literal {{club-name}} placeholders (round-trip safety). Reads are
  // partition-scoped: ?lodgeId= shows that lodge's override rows only.
  const lodgeId = request.nextUrl.searchParams.get("lodgeId");

  const records = await prisma.lodgeInstruction.findMany({
    where: { lodgeId: lodgeId ?? null },
    select: { key: true, contentHtml: true, updatedAt: true },
  });
  const byKey = new Map(records.map((record) => [record.key, record]));

  const documents = LODGE_INSTRUCTION_KEYS.map((key) => {
    const record = byKey.get(key);
    return {
      key,
      title: LODGE_INSTRUCTION_LABELS[key].title,
      description: LODGE_INSTRUCTION_LABELS[key].description,
      contentHtml: record ? sanitizePageContentHtml(record.contentHtml) : "",
      updatedAt: record ? record.updatedAt.toISOString() : null,
      hasOverride: Boolean(lodgeId) && byKey.has(key),
    };
  });

  return NextResponse.json({ documents, lodgeId: lodgeId ?? null });
}

/**
 * PUT /api/admin/lodge-instructions
 * Saves one keyed document into one partition (club-wide when lodgeId is
 * omitted), or with `remove: true` deletes a lodge's override row so that
 * lodge reverts to the club-wide document. Content is sanitised on write;
 * render paths sanitise again on read.
 */
export async function PUT(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) {
    return guard.response;
  }

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { key, lodgeId, remove } = parsed.data;

  if (lodgeId && !(await validateActiveLodge(lodgeId))) {
    return NextResponse.json(
      { error: "Lodge not found or not active" },
      { status: 400 },
    );
  }

  if (remove && lodgeId) {
    // Idempotent, mirroring the cancellation route's partition delete.
    const deleted = await prisma.lodgeInstruction.deleteMany({
      where: { key, lodgeId },
    });

    await prisma.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "LODGE_INSTRUCTION_UPDATED",
        actor: { memberId: guard.session.user.id },
        entity: { type: "LodgeInstruction", id: `${lodgeId}:${key}` },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: `Lodge instruction override removed for ${key}`,
        metadata: { key, lodgeId, removed: true, deletedCount: deleted.count },
        request: getAuditRequestContext(request),
      }),
    );

    return NextResponse.json({ removed: true, key, lodgeId });
  }

  const safeContentHtml = sanitizePageContentHtml(parsed.data.contentHtml ?? "");

  // The composite unique is [lodgeId, key], but nulls are distinct under it,
  // so the club-wide partition cannot be addressed by upsert. findFirst +
  // create/update instead. A lost create race is DB-rejected on both
  // partitions ([lodgeId, key] composite unique; club-wide via the
  // LodgeInstruction_clubwide_key_unique partial index, migration
  // 20260709000100) and recovered below as the intended last-writer-wins
  // update.
  const existing = await prisma.lodgeInstruction.findFirst({
    where: { key, lodgeId: lodgeId ?? null },
    select: { id: true, contentHtml: true },
  });

  const writeData = {
    contentHtml: safeContentHtml,
    updatedByMemberId: guard.session.user.id,
  };

  let updated;
  if (existing) {
    updated = await prisma.lodgeInstruction.update({
      where: { id: existing.id },
      data: writeData,
    });
  } else {
    try {
      updated = await prisma.lodgeInstruction.create({
        data: {
          key,
          lodgeId: lodgeId ?? null,
          ...writeData,
        },
      });
    } catch (err) {
      if (!isPrismaUniqueConstraintError(err)) throw err;
      // A concurrent save won the create race; its row exists now, so apply
      // this request as the update it would have been a moment later.
      const winner = await prisma.lodgeInstruction.findFirst({
        where: { key, lodgeId: lodgeId ?? null },
        select: { id: true },
      });
      if (!winner) throw err;
      updated = await prisma.lodgeInstruction.update({
        where: { id: winner.id },
        data: writeData,
      });
    }
  }

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
      summary: `Lodge instructions updated for ${key}`,
      metadata: {
        key,
        lodgeId: lodgeId ?? null,
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
      lodgeId: updated.lodgeId ?? null,
      hasOverride: Boolean(lodgeId),
    },
  });
}
