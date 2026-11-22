/**
 * Club notices, sent-email history and the message board (Membership admin area, ALP-720).
 *
 * An AI app never emails members: `create_notice` and `update_notice` leave
 * the email-on-publish switch out of their arguments and pin it off with
 * `fixedBody`. Bulk emails themselves (`/api/admin/communications/send`) have
 * a permanent exclusion.
 */
import {
  clubPostListQuerySchema,
  communicationHistoryQuerySchema,
  createNoticeSchema,
  moderateClubPostSchema,
  NOTICE_READS_DEFAULT_PAGE_SIZE,
  NOTICE_READS_MAX_PAGE_SIZE,
  noticeReadsQuerySchema,
  updateNoticeSchema,
} from "@/lib/admin-membership-api/notices";
import { ADMIN_LIST_DEFAULT_PAGE_SIZE, ADMIN_LIST_MAX_PAGE_SIZE } from "@/lib/admin-list-page";
import {
  CLUB_POST_CLEANUP_CONNECTION_SHAPE,
  CLUB_POST_LIST_CONNECTION_SHAPE,
  CLUB_POST_MODERATED_CONNECTION_SHAPE,
  CLUB_POST_REMOVED_CONNECTION_SHAPE,
  COMMUNICATION_HISTORY_CONNECTION_SHAPE,
  NOTICE_CONNECTION_SHAPE,
  NOTICE_CREATED_CONNECTION_SHAPE,
  NOTICE_DELETED_CONNECTION_SHAPE,
  NOTICE_LIST_CONNECTION_SHAPE,
  NOTICE_READS_CONNECTION_SHAPE,
  NOTICE_SAVED_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/membership-notices";
import { noticeIdParamsSchema } from "@/lib/notices-shared";
import { recordIdParamsSchema } from "@/lib/route-id-params";

import type { McpAction } from "../catalogue";

/** The email-on-publish switch, always off for an AI app. */
const NO_NOTICE_EMAIL = { sendEmail: false } as const;

const AUDIENCE_HELP =
  "`audiences` lists at least one rule: `{ kind: \"ALL_MEMBERS\" }`, or `MEMBER` with `memberId`, `MEMBERSHIP_TYPE` with `membershipTypeId`, `LODGE` with `lodgeId` (from `list_lodges`) or `COMMITTEE_ROLE` with `committeeRoleId`.";

const MESSAGE_BOARD_OFF =
  "Answers not found when the club's message board is switched off.";

export const MEMBERSHIP_NOTICE_MCP_ACTIONS: readonly McpAction[] = [
  {
    id: "list_admin_notices",
    title: "List all club notices",
    summary:
      "Every club notice, grouped into published, draft and archived, with who each is for, who wrote it, when it was published, whether members were emailed (`emailedAt`) and how many members have read and acknowledged it. Bodies are left out: read one with `get_admin_notice`.",
    method: "GET",
    path: "/api/admin/notices",
    kind: "read",
    returns: NOTICE_LIST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_admin_notice",
    title: "Read a club notice",
    summary:
      "One club notice by `id`, as the notice editor shows it: its body as stored HTML (`bodyHtml`), status, dates, audience rules and read counts.",
    method: "GET",
    path: "/api/admin/notices/[id]",
    params: noticeIdParamsSchema,
    kind: "read",
    returns: NOTICE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "create_notice",
    title: "Write a club notice",
    summary: `Creates a club notice, a draft unless \`status\` is "PUBLISHED". \`bodyHtml\` is HTML, cleaned of anything unsafe on save. \`expiresAt\` is a UTC date-time such as 2026-08-01T00:00:00Z, or null for none. \`financialMembersOnly\` limits the group rules to financial members; members named directly always see it. ${AUDIENCE_HELP} Members are never emailed from an AI app: to email them when a notice goes live, publish it on the club website instead.`,
    method: "POST",
    path: "/api/admin/notices",
    body: createNoticeSchema.omit({ sendEmail: true }),
    fixedBody: NO_NOTICE_EMAIL,
    kind: "write",
    returns: NOTICE_CREATED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_notice",
    title: "Edit, publish or archive a club notice",
    summary: `Changes a club notice by \`id\`. A field left out keeps its value; \`audiences\`, when sent, replaces every audience rule. \`status\` "PUBLISHED" puts a draft live (the first publish date is kept), "ARCHIVED" takes it down without deleting it. ${AUDIENCE_HELP} Members are never emailed from an AI app, including when this publishes a notice.`,
    method: "PATCH",
    path: "/api/admin/notices/[id]",
    params: noticeIdParamsSchema,
    body: updateNoticeSchema.omit({ sendEmail: true }),
    fixedBody: NO_NOTICE_EMAIL,
    kind: "write",
    returns: NOTICE_SAVED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "delete_notice",
    title: "Delete a club notice",
    summary:
      "Deletes a club notice by `id`, with its audience rules and every member's read and acknowledgement record. This cannot be undone; `update_notice` with status \"ARCHIVED\" takes a notice down and keeps it.",
    method: "DELETE",
    path: "/api/admin/notices/[id]",
    params: noticeIdParamsSchema,
    kind: "destructive",
    returns: NOTICE_DELETED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_notice_reads",
    title: "See who has read a notice",
    summary: `The members a notice by \`id\` reaches now (its audience is worked out afresh, so it can differ from when it was published), each with when they read and acknowledged it, plus audience, read and acknowledged totals. One page at a time: \`page\` from 1, \`pageSize\` ${NOTICE_READS_DEFAULT_PAGE_SIZE} unless set, at most ${NOTICE_READS_MAX_PAGE_SIZE}.`,
    method: "GET",
    path: "/api/admin/notices/[id]/reads",
    params: noticeIdParamsSchema,
    query: noticeReadsQuerySchema,
    kind: "read",
    returns: NOTICE_READS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_bulk_email_history",
    title: "List sent bulk emails",
    summary: `Bulk emails officers have sent to members, newest first, ${ADMIN_LIST_DEFAULT_PAGE_SIZE} a page unless \`pageSize\` is set (at most ${ADMIN_LIST_MAX_PAGE_SIZE}): the subject, the recipient group (\`recipientFilter\`: all, members-only, admins-only or custom), how many members it was addressed to, how many were eligible after their email preferences, how many were queued, the sender's member id and when. Never the recipients themselves.`,
    method: "GET",
    path: "/api/admin/communications/history",
    query: communicationHistoryQuerySchema,
    kind: "read",
    returns: COMMUNICATION_HISTORY_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_message_board_posts",
    title: "List message board posts",
    summary: `The most recent posts on the club message board for moderation, newest first, with their text, author and when posted (the list is capped, so use \`q\` to find older ones); \`hiddenAt\` is set on a post hidden from members, and \`originClubName\` on one copied from another club. \`tab\` "hidden" lists hidden posts only; \`q\` searches the text and author name. Removed posts are not listed. ${MESSAGE_BOARD_OFF}`,
    method: "GET",
    path: "/api/admin/club-posts",
    query: clubPostListQuerySchema,
    kind: "read",
    returns: CLUB_POST_LIST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "moderate_message_board_post",
    title: "Hide, restore or edit a message board post",
    summary: `Changes a message board post by \`id\`: \`hidden\` true hides it from members and false restores it; \`content\` replaces its text, saved as plain text (the original is kept in the audit log). When both are sent only \`content\` is applied. A post copied from another club cannot be edited, only hidden or removed, and a removed post cannot be changed. ${MESSAGE_BOARD_OFF}`,
    method: "PATCH",
    path: "/api/admin/club-posts/[id]",
    params: recordIdParamsSchema,
    body: moderateClubPostSchema,
    kind: "write",
    returns: CLUB_POST_MODERATED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "remove_message_board_post",
    title: "Remove a message board post",
    summary: `Removes a message board post by \`id\` for good: its text and images are deleted, and a post this club shared is withdrawn from other clubs' boards too. This cannot be undone; \`moderate_message_board_post\` with \`hidden\` true hides a post and keeps it. ${MESSAGE_BOARD_OFF}`,
    method: "DELETE",
    path: "/api/admin/club-posts/[id]",
    params: recordIdParamsSchema,
    kind: "destructive",
    returns: CLUB_POST_REMOVED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "run_message_board_cleanup",
    title: "Delete old message board posts now",
    summary: `Runs the message board's retention pass now, the same one the scheduled cleanup runs: every post older than the club's retention window is deleted with its images, and \`deleted\` says how many. \`skipped\` is "disabled" when the club's retention window is off and "busy" when a pass is already running. This cannot be undone. ${MESSAGE_BOARD_OFF}`,
    method: "POST",
    path: "/api/admin/club-posts/cleanup",
    kind: "destructive",
    returns: CLUB_POST_CLEANUP_CONNECTION_SHAPE,
    core: false,
  },
];
