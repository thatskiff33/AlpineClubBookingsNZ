/**
 * The request schemas of the club notice, sent-email history and message
 * board moderation routes (`/api/admin/notices/**`,
 * `/api/admin/communications/history`, `/api/admin/club-posts/**`), shared
 * with the AI app actions that call them (ALP-720, `INV-SSOT`): the app is
 * described exactly the fields the route enforces.
 */
import { z } from "zod";

import { adminListPageField, adminListPageQueryFields } from "@/lib/admin-list-page";
import { NOTICE_BODY_MAX_LENGTH, NOTICE_TITLE_MAX_LENGTH } from "@/lib/notices-shared";

// ---------------------------------------------------------------------------
// Club notices
// ---------------------------------------------------------------------------

/** One audience rule of a notice: everyone, or one member, membership type, lodge or committee role. */
export const noticeAudienceSchema = z.discriminatedUnion("kind", [
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

/** `POST /api/admin/notices`. */
export const createNoticeSchema = z
  .object({
    title: z.string().trim().min(1).max(NOTICE_TITLE_MAX_LENGTH),
    bodyHtml: z.string().max(NOTICE_BODY_MAX_LENGTH),
    status: z.enum(["DRAFT", "PUBLISHED"]).optional().default("DRAFT"),
    expiresAt: z.string().datetime().nullable().optional(),
    pinned: z.boolean().optional().default(false),
    requiresAcknowledgement: z.boolean().optional().default(false),
    financialMembersOnly: z.boolean().optional().default(false),
    // Optional email-on-publish. Only honoured when the notice is created
    // PUBLISHED (a draft never emails). Never offered to an AI app.
    sendEmail: z.boolean().optional().default(false),
    audiences: z.array(noticeAudienceSchema).min(1),
  })
  .strict();

/** `PATCH /api/admin/notices/[id]`: a field left out keeps its value; `audiences` replaces the whole list. */
export const updateNoticeSchema = z
  .object({
    title: z.string().trim().min(1).max(NOTICE_TITLE_MAX_LENGTH).optional(),
    bodyHtml: z.string().max(NOTICE_BODY_MAX_LENGTH).optional(),
    status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]).optional(),
    expiresAt: z.string().datetime().nullable().optional(),
    pinned: z.boolean().optional(),
    requiresAcknowledgement: z.boolean().optional(),
    financialMembersOnly: z.boolean().optional(),
    // Email-on-publish, honoured only on a publish transition. Never offered to an AI app.
    sendEmail: z.boolean().optional(),
    audiences: z.array(noticeAudienceSchema).min(1).optional(),
  })
  .strict();

export const NOTICE_READS_DEFAULT_PAGE_SIZE = 50;
export const NOTICE_READS_MAX_PAGE_SIZE = 200;

/** `GET /api/admin/notices/[id]/reads`: one page of the notice's audience, with its own page size. */
export const noticeReadsQuerySchema = z.object({
  page: adminListPageField,
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(NOTICE_READS_MAX_PAGE_SIZE)
    .optional()
    .default(NOTICE_READS_DEFAULT_PAGE_SIZE),
});

// ---------------------------------------------------------------------------
// Sent-email history
// ---------------------------------------------------------------------------

/** `GET /api/admin/communications/history`: the shared admin list page keys (INV-OPS-020). */
export const communicationHistoryQuerySchema = z.object({
  ...adminListPageQueryFields,
});

// ---------------------------------------------------------------------------
// Message board moderation
// ---------------------------------------------------------------------------

/**
 * `GET /api/admin/club-posts`. An unknown `tab` lists every post, as the
 * screen always has (`parseAdminPostTab`), so it is caught rather than refused.
 */
export const clubPostListQuerySchema = z.object({
  tab: z.enum(["all", "hidden"]).optional().catch(undefined),
  q: z.string().optional(),
});

/** `PATCH /api/admin/club-posts/[id]`: when both are sent, only `content` is applied. */
export const moderateClubPostSchema = z
  .object({
    hidden: z.boolean().optional(),
    content: z.string().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "No change was supplied.",
  });
