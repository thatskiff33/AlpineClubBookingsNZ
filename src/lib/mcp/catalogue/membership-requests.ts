/**
 * Applications and the archive, cancellation and deletion request queues (Membership admin area, ALP-720).
 *
 * An officer may raise an archive or cancellation request, chase nominators
 * and read every queue. Deciding a request or an application stays on the
 * website (`exclusions.ts`): a second officer approves there.
 */
import {
  adminMembershipCancellationRequestSchema,
  deletionRequestListQuerySchema,
  memberApplicationListQuerySchema,
  memberArchiveRequestSchema,
  memberLifecycleRequestListQuerySchema,
  membershipCancellationParticipantParamsSchema,
  membershipCancellationRequestListQuerySchema,
  replaceNominatorParamsSchema,
  replaceNominatorSchema,
} from "@/lib/admin-membership-api/requests";
import { ADMIN_LIST_DEFAULT_PAGE_SIZE, ADMIN_LIST_MAX_PAGE_SIZE } from "@/lib/admin-list-page";
import {
  DELETION_REQUEST_LIST_CONNECTION_SHAPE,
  MEMBER_APPLICATION_LIST_CONNECTION_SHAPE,
  MEMBER_ARCHIVE_REQUESTED_CONNECTION_SHAPE,
  MEMBER_LIFECYCLE_REQUEST_LIST_CONNECTION_SHAPE,
  MEMBERSHIP_CANCELLATION_REQUEST_LIST_CONNECTION_SHAPE,
  MEMBERSHIP_CANCELLATION_REQUEST_RESULT_CONNECTION_SHAPE,
  NOMINATIONS_REFRESHED_CONNECTION_SHAPE,
  NOMINATOR_REPLACED_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/membership-requests";
import { routeIdParamsSchema } from "@/lib/route-id-params";

import type { McpAction } from "../catalogue";

const PAGING = `Paged: \`page\` from 1, \`pageSize\` ${ADMIN_LIST_DEFAULT_PAGE_SIZE} by default and at most ${ADMIN_LIST_MAX_PAGE_SIZE}; the answer carries \`total\` and \`totalPages\`.`;

export const MEMBERSHIP_REQUEST_MCP_ACTIONS: readonly McpAction[] = [
  {
    id: "list_member_applications",
    title: "List membership applications",
    summary: `Membership applications, with each applicant's name, email and status, how many family members they applied with, each nominator's name, whether they have confirmed, when their link expires and how many automatic reminders they have had, and the review. Filter by \`status\`: PENDING_NOMINATORS, PENDING_ADMIN (waiting on an officer, oldest first), APPROVED or REJECTED; every status, newest first, when left out. \`pendingCount\` is how many wait on an officer. Approving or rejecting stays on the website. ${PAGING}`,
    method: "GET",
    path: "/api/admin/member-applications",
    query: memberApplicationListQuerySchema,
    kind: "read",
    returns: MEMBER_APPLICATION_LIST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "refresh_application_nominations",
    title: "Re-send nomination requests",
    summary:
      "For an application waiting on nominators (`id` from `list_member_applications`), emails each nominator who has not yet confirmed a fresh nomination link and restarts their reminder count. Their earlier links stop working. Refused if the application is not waiting on nominators, or a pending nominator is no longer an active member. `warnings` names any nominator the email could not reach.",
    method: "POST",
    path: "/api/admin/member-applications/[id]/nominations/refresh",
    params: routeIdParamsSchema,
    kind: "destructive",
    returns: NOMINATIONS_REFRESHED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "replace_application_nominator",
    title: "Replace a nominator",
    summary:
      "Swaps one nominator on an application waiting on nominators for another member and emails the new nominator a nomination link; the old nominator's link stops working. `slot` is nominator1 or nominator2 and `memberId` the replacement, who must be an active member able to nominate, not the other nominator and not the applicant. A nominator who has already confirmed cannot be replaced. `warnings` says if the email could not be sent.",
    method: "POST",
    path: "/api/admin/member-applications/[id]/nominators/[slot]/replace",
    params: replaceNominatorParamsSchema,
    body: replaceNominatorSchema,
    kind: "destructive",
    returns: NOMINATOR_REPLACED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "request_member_archive",
    title: "Ask for a member to be archived",
    summary:
      "Raises a request to archive a cancelled member (`id` is the member), with the `reason` the deciding officer reads; the club's admins are emailed an alert. Nothing changes until a different officer approves it on the website. Refused if the member is not cancelled, is already archived or already has a pending archive request; only a Full Admin may put forward a member whose record holds an admin, finance, lodge or custom access role.",
    method: "POST",
    path: "/api/admin/members/[id]/lifecycle/archive",
    params: routeIdParamsSchema,
    body: memberArchiveRequestSchema,
    kind: "destructive",
    returns: MEMBER_ARCHIVE_REQUESTED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "request_membership_cancellation",
    title: "Ask for a membership to be cancelled",
    summary:
      "Raises a request to cancel an active member's membership (`id` is the member), with the `reason` the deciding officer reads. The member is not asked to confirm; the club's admins are emailed an alert. Nothing changes until a different officer approves it on the website, which ends the membership. Refused for a member who is inactive, already cancelled or archived, already on an open cancellation request, or a lodge kiosk login or booking-request contact. `emailWarnings` says if the alert could not be sent.",
    method: "POST",
    path: "/api/admin/members/[id]/membership-cancellation",
    params: routeIdParamsSchema,
    body: adminMembershipCancellationRequestSchema,
    kind: "destructive",
    returns: MEMBERSHIP_CANCELLATION_REQUEST_RESULT_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_member_lifecycle_requests",
    title: "List archive and deletion requests",
    summary: `Requests officers have raised to archive a member (\`action\` ARCHIVE, the default) or delete one (DELETE), each with the member, the reason, who raised it and the decision. \`status\` is REQUESTED (the default; PENDING means the same), APPROVED, REJECTED or ALL. A request is decided on the website, by an officer other than the one who raised it (\`requestedByMemberId\`). \`targetName\` still names a member whose record has been deleted. ${PAGING}`,
    method: "GET",
    path: "/api/admin/member-lifecycle-action-requests",
    query: memberLifecycleRequestListQuerySchema,
    kind: "read",
    returns: MEMBER_LIFECYCLE_REQUEST_LIST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_membership_cancellation_requests",
    title: "List membership cancellation requests",
    summary: `Membership cancellation requests, each with who raised it, its reason and, for every member it would cancel, their status, confirmation and what blocks approval: a future booking (named), money owing in Xero, or a Xero check that could not be made. \`status\` is REQUESTED (the default), APPROVED, REJECTED, WITHDRAWN, COMPLETED or ALL. The live Xero invoice check runs only on the website, where an officer can approve, so here \`invoiceCheckSkipped\` is true for each member awaiting approval and an empty blocker list does not mean nothing is owing. Approving stays on the website, for an officer other than the one who raised it. ${PAGING}`,
    method: "GET",
    path: "/api/admin/membership-cancellation-requests",
    query: membershipCancellationRequestListQuerySchema,
    kind: "read",
    returns: MEMBERSHIP_CANCELLATION_REQUEST_LIST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "resend_cancellation_confirmation",
    title: "Re-send a cancellation confirmation",
    summary:
      "Emails a member on an open cancellation request (`requestId`, and `participantId` from the request's `participants`) a new link to confirm or decline it; their earlier link stops working. Only for a member still awaiting confirmation. `emailWarnings` says if the email could not be sent.",
    method: "POST",
    path: "/api/admin/membership-cancellation-requests/[requestId]/participants/[participantId]/resend-confirmation",
    params: membershipCancellationParticipantParamsSchema,
    kind: "destructive",
    returns: MEMBERSHIP_CANCELLATION_REQUEST_RESULT_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_account_deletion_requests",
    title: "List account deletion requests",
    summary: `Requests members have made to delete their own account, with the member, their reason and the decision. \`status\` is PENDING (the default: every request still open, including one part-way through approval, oldest first), APPROVED, REJECTED or ALL. Deciding stays on the website. ${PAGING}`,
    method: "GET",
    path: "/api/admin/deletion-requests",
    query: deletionRequestListQuerySchema,
    kind: "read",
    returns: DELETION_REQUEST_LIST_CONNECTION_SHAPE,
    core: false,
  },
];
