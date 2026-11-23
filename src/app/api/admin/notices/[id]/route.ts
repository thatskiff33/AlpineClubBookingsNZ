import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import { sanitizePageContentHtml } from "@/lib/page-content-html";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import {
  noticeAuditSnapshot,
  replaceNoticeAudiences,
  type NoticeAudienceInput,
} from "@/lib/notices";
import {
  dedupeNoticeAudiences,
  getAdminNoticeById,
  validateNoticeAudienceTargets,
} from "@/lib/notices-admin";
import { sendNoticePublishedEmails } from "@/lib/notices-email";
import {
  NOTICE_BODY_MAX_LENGTH,
  NOTICE_TITLE_MAX_LENGTH,
} from "@/lib/notices-shared";

const paramsSchema = z.object({ id: z.string().min(1) });

const audienceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ALL_MEMBERS") }).strict(),
  z.object({ kind: z.literal("MEMBER"), memberId: z.string().min(1) }).strict(),
  z
    .object({ kind: z.literal("MEMBERSHIP_TYPE"), membershipTypeId: z.string().min(1) })
    .strict(),
  z.object({ kind: z.literal("LODGE"), lodgeId: z.string().min(1) }).strict(),
  z
    .object({ kind: z.literal("COMMITTEE_ROLE"), committeeRoleId: z.string().min(1) })
    .strict(),
]);

const patchSchema = z
  .object({
    title: z.string().trim().min(1).max(NOTICE_TITLE_MAX_LENGTH).optional(),
    bodyHtml: z.string().max(NOTICE_BODY_MAX_LENGTH).optional(),
    status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]).optional(),
    expiresAt: z.string().datetime().nullable().optional(),
    pinned: z.boolean().optional(),
    requiresAcknowledgement: z.boolean().optional(),
    financialMembersOnly: z.boolean().optional(),
    sendEmail: z.boolean().optional(),
    audiences: z.array(audienceSchema).min(1).optional(),
  })
  .strict();

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) {
    return guard.response;
  }

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: "Invalid route parameters" }, { status: 400 });
  }

  const notice = await getAdminNoticeById(parsedParams.data.id);
  if (!notice) {
    return NextResponse.json({ error: "Notice not found" }, { status: 404 });
  }
  return NextResponse.json({ notice });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) {
    return guard.response;
  }
  const session = guard.session;

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: "Invalid route parameters" }, { status: 400 });
  }

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const existing = await prisma.notice.findUnique({
    where: { id: parsedParams.data.id },
  });
  if (!existing) {
    return NextResponse.json({ error: "Notice not found" }, { status: 404 });
  }

  let audiences: NoticeAudienceInput[] | null = null;
  if (parsed.data.audiences) {
    audiences = dedupeNoticeAudiences(parsed.data.audiences as NoticeAudienceInput[]);
    const targetError = await validateNoticeAudienceTargets(audiences);
    if (targetError) {
      return NextResponse.json({ error: targetError }, { status: 400 });
    }
  }

  const now = new Date();
  const becamePublished =
    parsed.data.status === "PUBLISHED" && existing.status !== "PUBLISHED";

  const before = noticeAuditSnapshot(existing);

  const updated = await prisma.$transaction(async (tx) => {
    const notice = await tx.notice.update({
      where: { id: existing.id },
      data: {
        ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
        ...(parsed.data.bodyHtml !== undefined
          ? { bodyHtml: sanitizePageContentHtml(parsed.data.bodyHtml) }
          : {}),
        ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
        // publishedAt is set once, on the first publish, and never rewritten.
        ...(becamePublished && existing.publishedAt === null
          ? { publishedAt: now }
          : {}),
        ...(parsed.data.expiresAt !== undefined
          ? { expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null }
          : {}),
        ...(parsed.data.pinned !== undefined ? { pinned: parsed.data.pinned } : {}),
        ...(parsed.data.requiresAcknowledgement !== undefined
          ? { requiresAcknowledgement: parsed.data.requiresAcknowledgement }
          : {}),
        ...(parsed.data.financialMembersOnly !== undefined
          ? { financialMembersOnly: parsed.data.financialMembersOnly }
          : {}),
        updatedByMemberId: session.user.id,
      },
    });

    if (audiences) {
      await replaceNoticeAudiences(tx, notice.id, audiences);
    }

    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: becamePublished ? "NOTICE_PUBLISHED" : "NOTICE_UPDATED",
        actor: { memberId: session.user.id },
        entity: { type: "Notice", id: notice.id },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: becamePublished ? "Member notice published" : "Member notice updated",
        metadata: {
          before,
          after: noticeAuditSnapshot(notice),
          ...(audiences ? { audienceCount: audiences.length } : {}),
        },
        request: getAuditRequestContext(request),
      }),
    );

    return notice;
  });

  // Email-on-publish: only on a publish transition, when requested, and only if
  // never emailed. Claim the single-send guard, then fire-and-forget.
  if (becamePublished && parsed.data.sendEmail) {
    const claim = await prisma.notice.updateMany({
      where: { id: updated.id, emailedAt: null },
      data: { emailedAt: new Date() },
    });
    if (claim.count > 0) {
      void sendNoticePublishedEmails(updated.id).catch(() => {
        // logged inside the helper
      });
    }
  }

  return NextResponse.json({ notice: { id: updated.id } });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) {
    return guard.response;
  }
  const session = guard.session;

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: "Invalid route parameters" }, { status: 400 });
  }

  const existing = await prisma.notice.findUnique({
    where: { id: parsedParams.data.id },
  });
  if (!existing) {
    return NextResponse.json({ error: "Notice not found" }, { status: 404 });
  }

  // Hard delete; audiences and read receipts cascade at the DB.
  await prisma.$transaction(async (tx) => {
    await tx.notice.delete({ where: { id: existing.id } });

    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "NOTICE_DELETED",
        actor: { memberId: session.user.id },
        entity: { type: "Notice", id: existing.id },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "Member notice deleted",
        metadata: { before: noticeAuditSnapshot(existing) },
        request: getAuditRequestContext(request),
      }),
    );
  });

  return NextResponse.json({ ok: true });
}
