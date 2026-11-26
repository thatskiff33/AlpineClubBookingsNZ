/**
 * The Finance area's Xero sync actions (ALP-721, `INV-MCP-006`): the
 * connection's status and health, the sync queue, inbound events, and the
 * runs and repairs an officer starts from the Xero screens. Each runs on a
 * route the `finance` admin area gates, with the officer's real permissions,
 * and is offered only to an officer holding that area at the route's level
 * (`mcpActionAdminRequirement`). Setting Xero up, and disconnecting it, stay
 * on the website (`exclusions.ts`).
 *
 * Kinds follow the owner's rule (#5305): an action that notifies anyone, or
 * changes a member's payment, refund, credit, invoice, subscription or Xero
 * record (the app's stored copy included), is `destructive`, so the app
 * confirms first and the call is logged as important. Every change here
 * is one: each sync, replay, retry or repair rewrites members' bookings,
 * payments, credits, contacts, subscriptions or Xero links.
 */
import { z } from "zod";

import {
  xeroForceSyncBodySchema,
  xeroForceSyncFields,
  xeroInboundEventsQuerySchema,
  xeroOperationReasonBodySchema,
  xeroOperationResolveBodySchema,
  xeroOperationsQuerySchema,
  xeroRecordActivityParamsSchema,
  xeroStatusQuerySchema,
  xeroSyncContactsBodySchema,
  xeroSyncMembershipsQuerySchema,
  xeroSyncNowRecordFields,
  xeroSyncNowRequestSchema,
  xeroTaxOverridePauseClearBodySchema,
} from "@/lib/admin-xero-sync-schemas";
import {
  XERO_FORCE_SYNC_CONTACT_CONNECTION_SHAPE,
  XERO_FORCE_SYNC_INVOICE_CONNECTION_SHAPE,
  XERO_FORCE_SYNC_MEMBERSHIP_CONNECTION_SHAPE,
  XERO_HEALTH_CONNECTION_SHAPE,
  XERO_INBOUND_EVENT_REPLAYED_CONNECTION_SHAPE,
  XERO_INBOUND_EVENTS_CONNECTION_SHAPE,
  XERO_LINK_MAINTENANCE_CONNECTION_SHAPE,
  XERO_OPERATION_MARKED_CONNECTION_SHAPE,
  XERO_OPERATION_QUEUED_CONNECTION_SHAPE,
  XERO_OPERATIONS_CONNECTION_SHAPE,
  XERO_RECORD_ACTIVITY_CONNECTION_SHAPE,
  XERO_RETRY_ALL_CONNECTION_SHAPE,
  XERO_STALE_RUNNING_RESET_CONNECTION_SHAPE,
  XERO_STATUS_CONNECTION_SHAPE,
  XERO_SYNC_CONTACTS_CONNECTION_SHAPE,
  XERO_SYNC_MEMBERSHIPS_CONNECTION_SHAPE,
  XERO_SYNC_NOW_CLUB_CONNECTION_SHAPE,
  XERO_SYNC_NOW_RECORD_CONNECTION_SHAPE,
  XERO_TAX_OVERRIDE_MISMATCHES_CONNECTION_SHAPE,
  XERO_TAX_OVERRIDES_RESUMED_CONNECTION_SHAPE,
  XERO_USAGE_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/finance-xero-sync";
import { routeIdParamsSchema } from "@/lib/route-id-params";
import { SEASON_YEAR_MAX, SEASON_YEAR_MIN } from "@/lib/season-year-range";
import { XERO_OPERATION_REASON_MAX, XERO_OPERATION_REASON_MIN } from "@/lib/xero-operation-resolution";
import { XERO_LOCAL_MODELS } from "@/lib/xero-record-links";

import type { McpAction } from "../catalogue";

/** A fixed `syncType` or `scope` must be one the route's schema accepts. */
type ForceSyncType = z.input<typeof xeroForceSyncBodySchema>["syncType"];
type SyncNowScope = z.input<typeof xeroSyncNowRequestSchema>["scope"];

/** A force-sync names its member or booking in `query`; `syncType` is the action's own. */
const forceSyncBody = z.object({ query: xeroForceSyncFields.query });

export const FINANCE_XERO_SYNC_MCP_ACTIONS: readonly McpAction[] = [
  // --- Connection, health and usage ---------------------------------------
  {
    id: "get_xero_connection_status",
    title: "Check the Xero connection",
    summary:
      "Whether the club's Xero connection is working, when its token expires, why it needs reconnecting if it does, and which optional Xero features are on. Send `probe: \"1\"` to also run a live connection check (`probe`); the result is cached for under a minute, so asking again straight away does not call Xero again.",
    method: "GET",
    path: "/api/admin/xero/status",
    query: xeroStatusQuerySchema,
    kind: "read",
    returns: XERO_STATUS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_xero_sync_health",
    title: "Read the Xero sync health",
    summary:
      "The counts behind the Xero screen's health tiles: failed, pending and stuck sync operations, stuck inbound events, members with no Xero contact, paid bookings with no invoice, refunds with no credit note, contact mismatches, the webhook's last delivery, the last membership refresh, the tax treatment check and today's API budget.",
    method: "GET",
    path: "/api/admin/xero/health",
    kind: "read",
    returns: XERO_HEALTH_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_xero_api_usage",
    title: "Read today's Xero API usage",
    summary:
      "Today's Xero API calls against the daily budget (the club's calendar day), the calls by operation and workflow over the last 24 hours, the five most recent failures, and the last time the daily limit was hit.",
    method: "GET",
    path: "/api/admin/xero/usage",
    kind: "read",
    returns: XERO_USAGE_CONNECTION_SHAPE,
    core: false,
  },

  // --- The sync queue ------------------------------------------------------
  {
    id: "list_xero_operations",
    title: "List Xero sync operations",
    summary:
      "One page of the Xero sync queue, newest first. Filters default to `all`: `status` (PENDING, RUNNING, SUCCEEDED, PARTIAL, FAILED), `direction` (OUTBOUND, INBOUND), `entityType`, `operationType`, `localModel` with `localId` (one local record), and `failureState` (ACTIVE, REPAIRED, SUPERSEDED, which lists failed rows only; `hiddenFailedCount` says how many failed rows it left out). `createdFrom`/`createdTo` are the club's calendar days, `YYYY-MM-DD`, inclusive. `pageSize` (at most 100) falls back to `limit`. Each row says whether it can be retried (`supported`, with `reason` when not), whether it is stuck running (`staleRunning`), and whether resolving it by hand asks for a credit note number and for what amount in cents.",
    method: "GET",
    path: "/api/admin/xero/operations",
    query: xeroOperationsQuerySchema,
    kind: "read",
    returns: XERO_OPERATIONS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "retry_xero_operation",
    title: "Retry a Xero sync operation",
    summary:
      "Queues a failed or partly completed Xero operation (`id`, from `list_xero_operations`) to run again in the background, and answers with the queued retry's id. It runs the same work the operation tried, so it may create or update the document in Xero, which cannot be withdrawn from the app; the operation's own guards refuse one that is resolved by hand, non-replayable or already running. Harmless to repeat.",
    method: "POST",
    path: "/api/admin/xero/operations/[id]/retry",
    params: routeIdParamsSchema,
    kind: "destructive",
    returns: XERO_OPERATION_QUEUED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "requeue_xero_operation",
    title: "Requeue a Xero sync operation",
    summary:
      "Puts a Xero operation (`id`, from `list_xero_operations`) back on the background queue, as the operations panel's Requeue button does, and answers with the queued retry's id. The same guards as a retry apply. Harmless to repeat.",
    method: "POST",
    path: "/api/admin/xero/operations/[id]/requeue",
    params: routeIdParamsSchema,
    kind: "destructive",
    returns: XERO_OPERATION_QUEUED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "mark_xero_operation_failed",
    title: "Mark a stuck Xero operation failed",
    summary:
      `Marks one Xero operation (\`id\`) that has been stuck running past the staleness threshold (\`staleRunning\` in \`list_xero_operations\`) as failed, or an interrupted repair back to partly completed, with the officer's \`reason\` (${XERO_OPERATION_REASON_MIN} to ${XERO_OPERATION_REASON_MAX} characters) in the audit log. Refused while it may still be running. It cannot be undone; afterwards the operation can be retried.`,
    method: "POST",
    path: "/api/admin/xero/operations/[id]/mark-failed",
    params: routeIdParamsSchema,
    body: xeroOperationReasonBodySchema,
    kind: "destructive",
    returns: XERO_OPERATION_MARKED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "mark_xero_operation_non_replayable",
    title: "Mark a Xero operation non-replayable",
    summary:
      `Marks one failed or partly completed Xero operation (\`id\`) as never to be retried, with the officer's \`reason\` (${XERO_OPERATION_REASON_MIN} to ${XERO_OPERATION_REASON_MAX} characters) in the audit log. No retry, requeue or retry-all will run it again. It cannot be undone from the app.`,
    method: "POST",
    path: "/api/admin/xero/operations/[id]/mark-non-replayable",
    params: routeIdParamsSchema,
    body: xeroOperationReasonBodySchema,
    kind: "destructive",
    returns: XERO_OPERATION_MARKED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "resolve_xero_operation",
    title: "Mark a Xero operation resolved in Xero",
    summary:
      `Records that an officer fixed a failed or partly completed Xero operation (\`id\`) directly in Xero, with their \`reason\` (${XERO_OPERATION_REASON_MIN} to ${XERO_OPERATION_REASON_MAX} characters). It drops off the active failure list and no repair path runs it again. A failed payment refund note's create asks for \`creditNoteNumber\`, the number of the credit note the officer made in Xero (\`resolveAsksCreditNoteNumber\` in \`list_xero_operations\`), which is checked in Xero and recorded against the payment; send it for no other row. It cannot be undone from the app.`,
    method: "POST",
    path: "/api/admin/xero/operations/[id]/resolve",
    params: routeIdParamsSchema,
    body: xeroOperationResolveBodySchema,
    kind: "destructive",
    returns: XERO_OPERATION_MARKED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "reset_stale_running_xero_operations",
    title: "Reset stuck Xero operations",
    summary:
      "Marks every Xero operation stuck running past the staleness threshold as failed (an interrupted repair goes back to partly completed), and answers with how many of each. Each can then be retried or resolved. It cannot be undone.",
    method: "POST",
    path: "/api/admin/xero/operations/reset-stale-running",
    kind: "destructive",
    returns: XERO_STALE_RUNNING_RESET_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "retry_all_failed_xero_operations",
    title: "Retry every active failed Xero operation",
    summary:
      "Queues a background retry for each active failed Xero operation that can be replayed (up to 200), skipping any its guards refuse, and answers with how many were found, queued and skipped, and why each skipped one was. Rows already repaired or superseded are counted in `legacySkipped` and left alone. Harmless to repeat.",
    method: "POST",
    path: "/api/admin/xero/operations/retry-all",
    kind: "destructive",
    returns: XERO_RETRY_ALL_CONNECTION_SHAPE,
    core: false,
  },

  // --- Inbound events ------------------------------------------------------
  {
    id: "list_xero_inbound_events",
    title: "List Xero inbound events",
    summary:
      "One page of the changes Xero has told the club about (webhooks and polling), newest first. Filters default to `all`: `status`, `eventCategory` (such as INVOICE, CONTACT, CREDITNOTE), `eventType`, `source`, and `localModel` with `localId` for the events about one local record's linked Xero documents. `createdFrom`/`createdTo` are the club's calendar days, `YYYY-MM-DD`, inclusive. `pageSize` (at most 100) falls back to `limit`. `canReplay` says whether `replay_xero_inbound_event` will take it.",
    method: "GET",
    path: "/api/admin/xero/inbound-events",
    query: xeroInboundEventsQuerySchema,
    kind: "read",
    returns: XERO_INBOUND_EVENTS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "replay_xero_inbound_event",
    title: "Replay a Xero inbound event",
    summary:
      "Processes one stored Xero inbound event (`id`, from `list_xero_inbound_events`) again now, as the club's background job would, bringing the linked bookings, payments and members into step with what Xero says. Refused while it is being processed. Answers with the run's counts and the event's new status. Harmless to repeat.",
    method: "POST",
    path: "/api/admin/xero/inbound-events/[id]/replay",
    params: routeIdParamsSchema,
    kind: "destructive",
    returns: XERO_INBOUND_EVENT_REPLAYED_CONNECTION_SHAPE,
    core: false,
  },

  // --- One record's Xero activity -------------------------------------------
  {
    id: "get_xero_record_activity",
    title: "Read one record's Xero activity",
    summary:
      `Everything Xero-related about one local record and the records around it: the latest 25 sync operations, the Xero documents it is linked to (by type and number), the latest 25 inbound events about them, and a summary. \`localModel\` is one of ${XERO_LOCAL_MODELS.slice(0, -1).join(", ")} or ${XERO_LOCAL_MODELS.at(-1)}; \`localId\` is that record's id.`,
    method: "GET",
    path: "/api/admin/xero/records/[localModel]/[localId]",
    params: xeroRecordActivityParamsSchema,
    kind: "read",
    returns: XERO_RECORD_ACTIVITY_CONNECTION_SHAPE,
    core: false,
  },

  // --- Syncs from Xero -------------------------------------------------------
  {
    id: "sync_member_from_xero",
    title: "Sync one member from Xero now",
    summary:
      "Reads one member's Xero contact, invoices and credit notes now and brings the member's contact details, bookings, payments and credits into step with Xero. `id` is the member id; the member must already be linked to a Xero contact. Answers with how many records changed. At most 3 sync-now runs a minute. Harmless to repeat.",
    method: "POST",
    path: "/api/admin/xero/sync-now",
    body: z.object(xeroSyncNowRecordFields),
    fixedBody: { scope: "member" satisfies SyncNowScope },
    kind: "destructive",
    returns: XERO_SYNC_NOW_RECORD_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "sync_booking_from_xero",
    title: "Sync one booking from Xero now",
    summary:
      "Reads one booking's linked Xero invoices and credit notes now and brings the booking's payment and credits into step with Xero. `id` is the booking id; the booking must have a linked Xero document. Answers with how many records changed. At most 3 sync-now runs a minute. Harmless to repeat.",
    method: "POST",
    path: "/api/admin/xero/sync-now",
    body: z.object(xeroSyncNowRecordFields),
    fixedBody: { scope: "booking" satisfies SyncNowScope },
    kind: "destructive",
    returns: XERO_SYNC_NOW_RECORD_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "sync_club_from_xero",
    title: "Sync the whole club from Xero now",
    summary:
      "Runs the club's scheduled Xero inbound sync now: stored inbound events, contact and membership changes, invoices and credit notes. Answers with what it reconciled. At most 3 sync-now runs a minute. Harmless to repeat.",
    method: "POST",
    path: "/api/admin/xero/sync-now",
    fixedBody: { scope: "club" satisfies SyncNowScope },
    kind: "destructive",
    returns: XERO_SYNC_NOW_CLUB_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "sync_xero_contacts",
    title: "Sync contacts from Xero",
    summary:
      "Matches Xero contacts to members by email and links them, changed contacts only by default. `fullResync: true` rescans every contact; `backfillJoinedDates: true` also fills in members' joined dates. Answers with a report by member name: created, updated, skipped (and why) and errors. Harmless to repeat.",
    method: "POST",
    path: "/api/admin/xero/sync-contacts",
    body: xeroSyncContactsBodySchema,
    kind: "destructive",
    returns: XERO_SYNC_CONTACTS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "sync_xero_memberships",
    title: "Refresh membership statuses from Xero",
    summary:
      `Refreshes active linked members' subscription status from their Xero invoices. \`seasonYear\` (${SEASON_YEAR_MIN} to ${SEASON_YEAR_MAX}) picks the season, the current one by default. \`mode\` is \`incremental\` (the default: changed invoices and members due a retry) or \`backfill\` (also rechecks members whose status is stale). Answers with what it checked and updated. Harmless to repeat.`,
    method: "POST",
    path: "/api/admin/xero/sync-memberships",
    query: xeroSyncMembershipsQuerySchema,
    kind: "destructive",
    returns: XERO_SYNC_MEMBERSHIPS_CONNECTION_SHAPE,
    core: false,
  },

  // --- Targeted force-syncs --------------------------------------------------
  {
    id: "force_sync_member_xero_contact",
    title: "Force-sync a member's Xero contact",
    summary:
      "Finds or creates the member's contact in Xero and repairs the member's link to it. A contact it creates cannot be removed from the app. `query` is the member's id (or a unique start of it) or their exact email address. Refused, naming the fields, when the member's record lacks what Xero needs. Harmless to repeat: an existing contact is reused.",
    method: "POST",
    path: "/api/admin/xero/force-sync",
    body: forceSyncBody,
    fixedBody: { syncType: "CONTACT" satisfies ForceSyncType },
    kind: "destructive",
    returns: XERO_FORCE_SYNC_CONTACT_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "force_refresh_member_xero_membership",
    title: "Refresh one member's membership status from Xero",
    summary:
      "Re-reads one member's subscription invoice in Xero and updates their membership status. `query` is the member's id (or a unique start of it) or their exact email address. Answers with the status. Harmless to repeat.",
    method: "POST",
    path: "/api/admin/xero/force-sync",
    body: forceSyncBody,
    fixedBody: { syncType: "MEMBERSHIP" satisfies ForceSyncType },
    kind: "destructive",
    returns: XERO_FORCE_SYNC_MEMBERSHIP_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "force_sync_booking_xero_invoice",
    title: "Force a paid booking's invoice into Xero",
    summary:
      "Queues the invoice for one paid booking to be raised in Xero. `query` is the booking id (or a unique start of it). Only a paid booking with a payment record qualifies. It goes ahead even when an officer marked the last invoice attempt resolved in Xero, so it can raise a second invoice beside one made by hand: check Xero first. It cannot be undone from the app.",
    method: "POST",
    path: "/api/admin/xero/force-sync",
    body: forceSyncBody,
    fixedBody: { syncType: "INVOICE" satisfies ForceSyncType },
    kind: "destructive",
    returns: XERO_FORCE_SYNC_INVOICE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "run_xero_link_maintenance",
    title: "Run Xero link maintenance",
    summary:
      "Runs the nightly Xero link upkeep now: records any missing links between local records and their Xero contacts, invoices and credit notes, and retires stale ones (including links to voided or deleted refund credit notes). Answers with the counts, and a `warning` when some repairs failed and are left for the next nightly run. Harmless to repeat.",
    method: "POST",
    path: "/api/admin/xero/link-maintenance",
    kind: "destructive",
    returns: XERO_LINK_MAINTENANCE_CONNECTION_SHAPE,
    core: false,
  },

  // --- GST overrides (#5208) -----------------------------------------------
  {
    id: "list_xero_tax_override_mismatches",
    title: "List invoices whose GST Xero changed",
    summary:
      "The invoices whose GST Xero changed after the app sent it, oldest first: the booking, the invoice number, whether it was a new invoice or an update, and each line's GST the app sent and Xero kept, in integer cents. While any are listed, new invoices go to Xero without the club's own GST figures (`problem` says so). Reading it changes nothing.",
    method: "GET",
    path: "/api/admin/xero/tax-override-pause",
    kind: "read",
    returns: XERO_TAX_OVERRIDE_MISMATCHES_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "resume_xero_tax_overrides",
    title: "Resume the club's GST overrides in Xero",
    summary:
      "Clears the listed invoices (`ids`, from `list_xero_tax_override_mismatches`) once the officer has checked them in Xero, with `note` saying what they found; `confirmed` must be `true`, sent only after the officer confirms. Only those still listed are cleared, so one flagged since stays. When none remain, new members' invoices carry the club's own GST figures again. Answers with how many cleared and what is still listed. It cannot be undone from the app.",
    method: "POST",
    path: "/api/admin/xero/tax-override-pause/clear",
    body: xeroTaxOverridePauseClearBodySchema,
    kind: "destructive",
    returns: XERO_TAX_OVERRIDES_RESUMED_CONNECTION_SHAPE,
    core: false,
  },
];
