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
  listNoticesForAdmin,
  validateNoticeAudienceTargets,
} from "@/lib/notices-admin";
import { sendNoticePublishedEmails } from "@/lib/notices-email";
import {
  NOTICE_BODY_MAX_LENGTH,
  NOTICE_TITLE_MAX_LENGTH,
} from "@/lib/notices-shared";

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

const createSchema = z
  .object({
    title: z.string().trim().min(1).max(NOTICE_TITLE_MAX_LENGTH),
    bodyHtml: z.string().max(NOTICE_BODY_MAX_LENGTH),
    status: z.enum(["DRAFT", "PUBLISHED"]).optional().default("DRAFT"),
    expiresAt: z.string().datetime().nullable().optional(),
    pinned: z.boolean().optional().default(false),
    requiresAcknowledgement: z.boolean().optional().default(false),
    financialMembersOnly: z.boolean().optional().default(false),
    // Optional email-on-publish. Only honoured when the notice is created
    // PUBLISHED (a draft never emails).
    sendEmail: z.boolean().optional().default(false),
    audiences: z.array(audienceSchema).min(1),
  })
  .strict();

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) {
    return guard.response;
  }

  return NextResponse.json(await listNoticesForAdmin());
}

export async function POST(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) {
    return guard.response;
  }
  const session = guard.session;

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const audiences = dedupeNoticeAudiences(
    parsed.data.audiences as NoticeAudienceInput[],
  );
  const targetError = await validateNoticeAudienceTargets(audiences);
  if (targetError) {
    return NextResponse.json({ error: targetError }, { status: 400 });
  }

  const bodyHtml = sanitizePageContentHtml(parsed.data.bodyHtml);
  const willPublish = parsed.data.status === "PUBLISHED";
  const now = new Date();

  const created = await prisma.$transaction(async (tx) => {
    const notice = await tx.notice.create({
      data: {
        title: parsed.data.title,
        bodyHtml,
        status: parsed.data.status,
        publishedAt: willPublish ? now : null,
        expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
        pinned: parsed.data.pinned,
        requiresAcknowledgement: parsed.data.requiresAcknowledgement,
        financialMembersOnly: parsed.data.financialMembersOnly,
        createdByMemberId: session.user.id,
        updatedByMemberId: session.user.id,
      },
    });

    await replaceNoticeAudiences(tx, notice.id, audiences);

    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "NOTICE_CREATED",
        actor: { memberId: session.user.id },
        entity: { type: "Notice", id: notice.id },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "Member notice created",
        metadata: {
          notice: noticeAuditSnapshot(notice),
          audienceCount: audiences.length,
          published: willPublish,
        },
        request: getAuditRequestContext(request),
      }),
    );

    return notice;
  });

  // Email-on-publish: only when created PUBLISHED, requested, and not yet
  // emailed. Claim the single-send guard atomically, then fire-and-forget the
  // throttled send OUTSIDE the transaction.
  if (willPublish && parsed.data.sendEmail) {
    const claim = await prisma.notice.updateMany({
      where: { id: created.id, emailedAt: null },
      data: { emailedAt: new Date() },
    });
    if (claim.count > 0) {
      void sendNoticePublishedEmails(created.id).catch(() => {
        // errors are logged inside the helper; never surface to the request
      });
    }
  }

  return NextResponse.json({ notice: { id: created.id } }, { status: 201 });
}
