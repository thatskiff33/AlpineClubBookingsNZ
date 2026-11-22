/**
 * The Finance area's Xero contact and invoice actions (ALP-721,
 * `INV-MCP-006`): linking members to Xero contacts, the mismatch, duplicate,
 * erased-member and missing-contact reviews, missing invoices and cash
 * credits. Each runs on a route the `finance` admin area gates, with the
 * officer's real permissions, and is offered only to an officer holding that
 * area at the route's level (`mcpActionAdminRequirement`).
 *
 * Linking, creating and unlinking a member's contact, the missing-contact run
 * and queuing missing invoices are `destructive`: each writes to Xero or
 * clears the member's subscription history, and the app cannot put it back.
 * A Refresh that re-reads Xero into the local cache is a `write`.
 */
import {
  XERO_CASH_CREDITS_CONNECTION_SHAPE,
  XERO_CASH_CREDITS_REFRESHED_CONNECTION_SHAPE,
  XERO_CONTACT_GROUP_MISMATCHES_CONNECTION_SHAPE,
  XERO_CONTACT_GROUP_MISMATCHES_RESYNCED_CONNECTION_SHAPE,
  XERO_CONTACT_LINK_MISMATCHES_CONNECTION_SHAPE,
  XERO_CONTACT_LINK_MISMATCHES_RESYNCED_CONNECTION_SHAPE,
  XERO_CONTACT_SEARCH_CONNECTION_SHAPE,
  XERO_DUPLICATE_CONTACTS_CONNECTION_SHAPE,
  XERO_ERASED_MEMBER_CONTACTS_CHECKED_CONNECTION_SHAPE,
  XERO_ERASED_MEMBER_CONTACTS_CONNECTION_SHAPE,
  XERO_MEMBER_LINKED_CONNECTION_SHAPE,
  XERO_MEMBER_PUSHED_CONNECTION_SHAPE,
  XERO_MEMBER_UNLINKED_CONNECTION_SHAPE,
  XERO_MISSING_CONTACTS_CONNECTION_SHAPE,
  XERO_MISSING_CONTACTS_RUN_CONNECTION_SHAPE,
  XERO_MISSING_INVOICES_CONNECTION_SHAPE,
  XERO_MISSING_INVOICES_QUEUED_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/finance-xero-contacts";
import { recordIdParamsSchema } from "@/lib/route-id-params";
import {
  erasedMemberContactReviewQuerySchema,
  xeroContactGroupMismatchResyncBodySchema,
  xeroContactLinkMismatchResyncBodySchema,
  xeroContactMismatchQuerySchema,
  xeroMissingContactCensusQuerySchema,
  xeroMissingContactRunBodySchema,
} from "@/lib/xero-contact-review-requests";
import {
  xeroContactSearchQuerySchema,
  xeroMemberContactLinkBodySchema,
  xeroMemberContactPushBodySchema,
} from "@/lib/xero-member-contact-requests";

import type { McpAction } from "../catalogue";

export const FINANCE_XERO_CONTACTS_MCP_ACTIONS: readonly McpAction[] = [
  {
    id: "search_xero_contacts",
    title: "Search Xero contacts",
    summary:
      "Up to 20 Xero contacts whose name or email address matches `q` (two characters at least), each with the `contactId` that `link_member_to_xero_contact` takes and whether it is already linked to a member, and to whom. Email addresses are not returned: to tell two contacts with the same name apart, search again with the member's email address as `q`.",
    method: "GET",
    path: "/api/admin/xero/search-contacts",
    query: xeroContactSearchQuerySchema,
    kind: "read",
    returns: XERO_CONTACT_SEARCH_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "link_member_to_xero_contact",
    title: "Link a member to a Xero contact",
    summary:
      "Links member `id` to the existing Xero contact `xeroContactId` (from `search_xero_contacts`), then clears and re-reads the member's subscription history from that contact. Refused if another member or organisation already holds the contact. Changes the member's accounting identity; undoing it needs `unlink_member_from_xero_contact` and a fresh link, and the history re-read is not reversed.",
    method: "POST",
    path: "/api/admin/members/[id]/xero-link",
    params: recordIdParamsSchema,
    body: xeroMemberContactLinkBodySchema,
    kind: "destructive",
    returns: XERO_MEMBER_LINKED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "create_xero_contact_for_member",
    title: "Create a Xero contact for a member",
    summary:
      "Creates a new contact in Xero for member `id`, who must not be linked yet, and links them. If Xero already has contacts that look like the member it is refused and lists them (link one with `link_member_to_xero_contact`), unless `forceCreate` is true. `entranceFeeInvoiceDecision` `CREATE` also queues the joining fee invoice (`entranceFeeInvoiceAmountCents` in integer cents overrides the amount, `entranceFeeInvoiceNarration` its description); `SKIP` needs `entranceFeeInvoiceSkipReason`. A contact or invoice created in Xero cannot be removed from the app.",
    method: "POST",
    path: "/api/admin/members/[id]/xero-push",
    params: recordIdParamsSchema,
    body: xeroMemberContactPushBodySchema,
    kind: "destructive",
    returns: XERO_MEMBER_PUSHED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "unlink_member_from_xero_contact",
    title: "Unlink a member from their Xero contact",
    summary:
      "Removes the link between member `id` and their Xero contact and clears the member's subscription history read from it. Nothing changes in Xero. Linking again needs the contact's id from `search_xero_contacts`; the cleared history is re-read only then.",
    method: "POST",
    path: "/api/admin/members/[id]/xero-unlink",
    params: recordIdParamsSchema,
    kind: "destructive",
    returns: XERO_MEMBER_UNLINKED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_xero_cash_credits",
    title: "List open Xero overpayments and prepayments",
    summary:
      "The unallocated Xero overpayments and prepayments the app last read, oldest first, each with its total and remaining amount in integer cents and the member whose contact holds it, and when they were last refreshed. Reads no Xero data live.",
    method: "GET",
    path: "/api/admin/xero/cash-credits",
    kind: "read",
    returns: XERO_CASH_CREDITS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "refresh_xero_cash_credits",
    title: "Refresh Xero overpayments and prepayments",
    summary:
      "Reads every open overpayment and prepayment from Xero again and replaces the app's copy, then answers with the counts written and the refreshed list (amounts in integer cents). Changes nothing in Xero and is safe to repeat; limited to three a minute.",
    method: "POST",
    path: "/api/admin/xero/cash-credits",
    kind: "write",
    returns: XERO_CASH_CREDITS_REFRESHED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_xero_contact_group_mismatches",
    title: "List Xero contact group mismatches",
    summary:
      "Members whose Xero contact sits in the wrong managed contact group for the club's grouping rules, and information-only members in a managed group no rule matches, from the app's cached copy of Xero. `limit` (1 to 500) caps the rows listed; the counts cover everyone.",
    method: "GET",
    path: "/api/admin/xero/contact-group-mismatches",
    query: xeroContactMismatchQuerySchema,
    kind: "read",
    returns: XERO_CONTACT_GROUP_MISMATCHES_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "resync_xero_contact_group_mismatches",
    title: "Re-read flagged contact groups from Xero",
    summary:
      "Re-reads from Xero the contacts the group mismatch list flags (up to `limit`, default 200), updates the app's cached copy and answers with the list again. Changes nothing in Xero and is safe to repeat. Refused until the full Xero groups refresh has run once.",
    method: "POST",
    path: "/api/admin/xero/contact-group-mismatches",
    body: xeroContactGroupMismatchResyncBodySchema,
    kind: "write",
    returns: XERO_CONTACT_GROUP_MISMATCHES_RESYNCED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_xero_contact_link_mismatches",
    title: "List Xero contact link mismatches",
    summary:
      "Members whose name differs from the name of the Xero contact they are linked to, with the reason, from the app's cached copy of Xero. `limit` (1 to 500) caps the rows listed.",
    method: "GET",
    path: "/api/admin/xero/contact-link-mismatches",
    query: xeroContactMismatchQuerySchema,
    kind: "read",
    returns: XERO_CONTACT_LINK_MISMATCHES_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "resync_xero_contact_link_mismatches",
    title: "Re-read flagged linked contacts from Xero",
    summary:
      "Re-reads from Xero the contacts the link mismatch list flags (up to `limit`), updates the app's cached copy and answers with the list again. Changes nothing in Xero and is safe to repeat. Refused until the full Xero contacts refresh has run once.",
    method: "POST",
    path: "/api/admin/xero/contact-link-mismatches",
    body: xeroContactLinkMismatchResyncBodySchema,
    kind: "write",
    returns: XERO_CONTACT_LINK_MISMATCHES_RESYNCED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_xero_duplicate_contacts",
    title: "List duplicate Xero contacts",
    summary:
      "Scans every Xero contact for ones sharing an email address and answers with each group's contacts by name, with invoice counts and the member each is linked to, and whether the group's members could form a family group. The shared address is not returned. Reads Xero live, so it can be slow and uses the club's daily Xero allowance; merging happens in Xero.",
    method: "GET",
    path: "/api/admin/xero/duplicate-contacts",
    kind: "read",
    returns: XERO_DUPLICATE_CONTACTS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_erased_member_xero_contacts",
    title: "List Xero contacts left by erased members",
    summary:
      "How many Xero contacts belonging to members the club has erased still need a look, how many are already archived in Xero, and for each listed contact how and when the member was erased and what is known of it in Xero. Identifies no one: the treasurer opens the contacts from the website's review screen. `limit` (1 to 1000) caps the rows. Asks Xero nothing.",
    method: "GET",
    path: "/api/admin/xero/erased-member-contacts",
    query: erasedMemberContactReviewQuerySchema,
    kind: "read",
    returns: XERO_ERASED_MEMBER_CONTACTS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "check_erased_member_xero_contacts",
    title: "Check erased members' Xero contacts in Xero",
    summary:
      "Asks Xero whether each contact the erased-member review lists (up to `limit`) is still active, records the answer, and answers with the review again and the counts observed. Changes nothing in Xero and is safe to repeat, but uses the club's daily Xero allowance.",
    method: "POST",
    path: "/api/admin/xero/erased-member-contacts",
    query: erasedMemberContactReviewQuerySchema,
    kind: "write",
    returns: XERO_ERASED_MEMBER_CONTACTS_CHECKED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_members_missing_xero_contacts",
    title: "List members missing a Xero contact",
    summary:
      "The dry run for giving members without a Xero contact one: counts, and the members that would be linked or created (`pushableRows`), left out or ambiguous, by name and reason. Writes nothing. The `plannedDigest` and the reviewed `memberId`s are what `create_missing_xero_contacts` takes. `limit` (1 to 2000) caps the rows per list.",
    method: "GET",
    path: "/api/admin/xero/missing-contacts",
    query: xeroMissingContactCensusQuerySchema,
    kind: "read",
    returns: XERO_MISSING_CONTACTS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "create_missing_xero_contacts",
    title: "Create or link missing Xero contacts",
    summary:
      "Runs one chunk of the missing-contact plan for the reviewed `memberIds`: links each to the contact Xero already has or creates one in Xero. `plannedDigest` is the one from `list_members_missing_xero_contacts`; if the plan has changed since, nothing is done. `confirmReviewed` must be true, sent only after the officer has reviewed the list. `limit` (1 to 100) caps the chunk. Contacts created in Xero cannot be removed from the app.",
    method: "POST",
    path: "/api/admin/xero/missing-contacts",
    body: xeroMissingContactRunBodySchema,
    kind: "destructive",
    returns: XERO_MISSING_CONTACTS_RUN_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_bookings_missing_xero_invoices",
    title: "List paid bookings missing a Xero invoice",
    summary:
      "Up to 50 paid bookings the club's records show no Xero invoice for, newest stay first, with the member, stay dates and the total count. Bookings settled outside Xero are not listed.",
    method: "GET",
    path: "/api/admin/xero/missing-invoices",
    kind: "read",
    returns: XERO_MISSING_INVOICES_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "queue_missing_xero_invoices",
    title: "Create missing Xero invoices",
    summary:
      "Queues a Xero invoice for each of up to 200 paid bookings missing one, created in the background, and answers with how many were found, queued and skipped (and why). Invoices created in Xero cannot be removed from the app.",
    method: "POST",
    path: "/api/admin/xero/missing-invoices",
    kind: "destructive",
    returns: XERO_MISSING_INVOICES_QUEUED_CONNECTION_SHAPE,
    core: false,
  },
];
