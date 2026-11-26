/**
 * What the club notice, sent-email history and message board actions send an
 * AI app connection (ALP-720, `INV-MCP-006`).
 *
 * Left out on purpose: members' email addresses on the read report, the
 * internal audience row ids the notice editor keys its list on, the duplicate
 * `data` copy of the sent-email history, and `removedAt` on message board
 * posts (always null: the moderation list leaves removed posts out). The
 * officer's notice read sends `bodyHtml`, the stored markup, because
 * `update_notice` saves `bodyHtml`: an app editing a notice from a plain-text
 * copy would strip its formatting on save.
 */
import type { CleanupOutcome } from "@/lib/club-post-retention";
import type { AdminClubPost } from "@/lib/club-posts-admin";
import {
  connectionShapeFor,
  type ConnectionShape,
  type ConnectionShapeFor,
} from "@/lib/connection-projection";
import type { AdminNotice, AdminNoticeDetail, AdminNoticeGroups } from "@/lib/notices-admin";

// ---------------------------------------------------------------------------
// Club notices
// ---------------------------------------------------------------------------

const NOTICE_SUMMARY_FIELDS = {
  id: true,
  title: true,
  status: true,
  publishedAt: true,
  expiresAt: true,
  pinned: true,
  requiresAcknowledgement: true,
  financialMembersOnly: true,
  emailedAt: true,
  createdAt: true,
  updatedAt: true,
  createdByName: true,
  audiences: { kind: true, targetId: true, targetName: true },
  audienceCount: true,
  readCount: true,
  acknowledgedCount: true,
} satisfies ConnectionShapeFor<AdminNotice>;

export const NOTICE_LIST_CONNECTION_SHAPE = connectionShapeFor<AdminNoticeGroups>({
  published: NOTICE_SUMMARY_FIELDS,
  draft: NOTICE_SUMMARY_FIELDS,
  archived: NOTICE_SUMMARY_FIELDS,
});

export const NOTICE_CONNECTION_SHAPE: ConnectionShape = {
  notice: connectionShapeFor<AdminNoticeDetail>({ ...NOTICE_SUMMARY_FIELDS, bodyHtml: true }),
};

/** `create_notice` and `update_notice` answer with the notice's id only. */
export const NOTICE_SAVED_CONNECTION_SHAPE = connectionShapeFor<{ notice: { id: string } }>({
  notice: { id: true },
});

export const NOTICE_DELETED_CONNECTION_SHAPE = connectionShapeFor<{ ok: boolean }>({ ok: true });

/** The read report as `/api/admin/notices/[id]/reads` builds it. */
interface NoticeReadsAnswer {
  requiresAcknowledgement: boolean;
  rows: Array<{
    memberId: string;
    name: string;
    email: string;
    audienceVia: string;
    readAt: string | null;
    acknowledgedAt: string | null;
  }>;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  audienceCount: number;
  readCount: number;
  acknowledgedCount: number;
}

export const NOTICE_READS_CONNECTION_SHAPE = connectionShapeFor<NoticeReadsAnswer>({
  requiresAcknowledgement: true,
  rows: { memberId: true, name: true, readAt: true, acknowledgedAt: true },
  page: true,
  pageSize: true,
  total: true,
  totalPages: true,
  audienceCount: true,
  readCount: true,
  acknowledgedCount: true,
});

// ---------------------------------------------------------------------------
// Sent-email history
// ---------------------------------------------------------------------------

/** One past bulk email as `/api/admin/communications/history` reads it from the audit log. */
interface CommunicationHistoryEntry {
  id: string;
  sentBy: string | null;
  subject: string;
  recipientFilter: string;
  totalRecipients: number;
  eligibleRecipients: number;
  queued: number;
  sentAt: Date;
}

export const COMMUNICATION_HISTORY_CONNECTION_SHAPE = connectionShapeFor<{
  data: CommunicationHistoryEntry[];
  history: CommunicationHistoryEntry[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}>({
  history: {
    id: true,
    sentBy: true,
    subject: true,
    recipientFilter: true,
    totalRecipients: true,
    eligibleRecipients: true,
    queued: true,
    sentAt: true,
  },
  page: true,
  pageSize: true,
  total: true,
  totalPages: true,
});

// ---------------------------------------------------------------------------
// Message board moderation
// ---------------------------------------------------------------------------

export const CLUB_POST_LIST_CONNECTION_SHAPE = connectionShapeFor<{ posts: AdminClubPost[] }>({
  posts: {
    id: true,
    authorName: true,
    authorMemberId: true,
    content: true,
    postedAt: true,
    hiddenAt: true,
    originClubName: true,
  },
});

/** `status` is "edited" (with the saved text's `length`), "hidden" or "visible". */
export const CLUB_POST_MODERATED_CONNECTION_SHAPE = connectionShapeFor<{
  status: "edited" | "hidden" | "visible" | "withdrawn" | "dismissed";
  length?: number;
}>({ status: true, length: true });

export const CLUB_POST_REMOVED_CONNECTION_SHAPE = connectionShapeFor<{ status: "removed" }>({
  status: true,
});

export const CLUB_POST_CLEANUP_CONNECTION_SHAPE = connectionShapeFor<CleanupOutcome>({
  skipped: true,
  deleted: true,
});
