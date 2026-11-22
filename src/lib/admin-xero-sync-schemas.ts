/**
 * The request schemas of the Finance area's Xero sync routes (ALP-721,
 * `INV-SSOT`): each route parses with the schema here and its AI app action
 * (`mcp/catalogue/finance-xero-sync.ts`) describes the same one, so the app is
 * never told one shape while the route enforces another.
 *
 * Pure: no database or server imports, so the catalogue can import it.
 */
import { z } from "zod";

import { adminListPageField } from "@/lib/admin-list-page";
import { HAND_MADE_CREDIT_NOTE_NUMBER_MAX } from "@/lib/bank-refund-void-follow-up-copy";
import { dateOnlyStringSchema } from "@/lib/date-only-schema";
import { XERO_OPERATION_REASON_MAX, XERO_OPERATION_REASON_MIN } from "@/lib/xero-operation-resolution";
import { XERO_LOCAL_MODELS } from "@/lib/xero-record-links";

// --- Connection status ------------------------------------------------------

/**
 * `GET /api/admin/xero/status`. `probe=1` adds a live connection check; any
 * other value is ignored rather than refused, as the route always has.
 */
export const xeroStatusQuerySchema = z.object({
  probe: z.literal("1").optional().catch(undefined),
});

// --- The sync queue and inbound events --------------------------------------

/** The paging every Xero list shares: `pageSize` falls back to `limit`. */
const xeroListPagingFields = {
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  page: adminListPageField,
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
};

/**
 * `GET /api/admin/xero/operations`. `createdFrom`/`createdTo` are the club's
 * calendar days (`YYYY-MM-DD`), bracketed in the club's timezone by the route.
 */
export const xeroOperationsQuerySchema = z.object({
  status: z.string().optional().default("all"),
  entityType: z.string().optional().default("all"),
  direction: z.string().optional().default("all"),
  localModel: z.string().trim().optional().default("all"),
  localId: z.string().trim().optional().default(""),
  operationType: z.string().trim().optional().default("all"),
  resourceId: z.string().trim().optional().default(""),
  createdFrom: dateOnlyStringSchema.optional(),
  createdTo: dateOnlyStringSchema.optional(),
  failureState: z.enum(["all", "ACTIVE", "REPAIRED", "SUPERSEDED"]).optional().default("all"),
  ...xeroListPagingFields,
});

/** `GET /api/admin/xero/inbound-events`, with the same club-day date bounds. */
export const xeroInboundEventsQuerySchema = z.object({
  status: z.string().optional().default("all"),
  eventCategory: z.string().optional().default("all"),
  source: z.string().optional().default("all"),
  localModel: z.string().trim().optional().default("all"),
  localId: z.string().trim().optional().default(""),
  resourceId: z.string().trim().optional().default(""),
  eventType: z.string().trim().optional().default("all"),
  createdFrom: dateOnlyStringSchema.optional(),
  createdTo: dateOnlyStringSchema.optional(),
  ...xeroListPagingFields,
});

// --- Acting on one operation by hand ----------------------------------------

/** The reason an officer gives for acting on a Xero operation by hand. */
const xeroOperationReasonField = z
  .string()
  .trim()
  .min(XERO_OPERATION_REASON_MIN)
  .max(XERO_OPERATION_REASON_MAX);

/** `POST .../operations/[id]/mark-failed` and `.../mark-non-replayable`. */
export const xeroOperationReasonBodySchema = z.object({
  reason: xeroOperationReasonField,
});

/** `POST .../operations/[id]/resolve`. */
export const xeroOperationResolveBodySchema = z.object({
  reason: xeroOperationReasonField,
  // #4421: the Xero credit note the officer made, asked of a FAILED payment
  // refund note's create that names no note of its own
  // (`refundNoteResolveShape`). Refused for every other row (review, money F5).
  creditNoteNumber: z.string().trim().max(HAND_MADE_CREDIT_NOTE_NUMBER_MAX).optional(),
});

// --- One record's Xero activity ---------------------------------------------

/** `GET /api/admin/xero/records/[localModel]/[localId]`. */
export const xeroRecordActivityParamsSchema = z.object({
  localModel: z.enum(XERO_LOCAL_MODELS),
  localId: z.string().min(1),
});

// --- Runs an officer starts -------------------------------------------------

/** The record a member or booking sync-now names. */
export const xeroSyncNowRecordFields = { id: z.string().min(1).max(128) };

/** `POST /api/admin/xero/sync-now`: one member, one booking, or the whole club. */
export const xeroSyncNowRequestSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("member"), ...xeroSyncNowRecordFields }),
  z.object({ scope: z.literal("booking"), ...xeroSyncNowRecordFields }),
  z.object({ scope: z.literal("club") }),
]);

/** `POST /api/admin/xero/sync-contacts`: the optional repair flags. */
export const xeroSyncContactsBodySchema = z.object({
  fullResync: z.boolean().optional(),
  backfillJoinedDates: z.boolean().optional(),
});

/** `POST /api/admin/xero/sync-memberships`: query parameters. */
export const xeroSyncMembershipsQuerySchema = z.object({
  seasonYear: z
    .union([z.coerce.number().int().min(2020).max(2040), z.literal("")])
    .optional(),
  mode: z.enum(["incremental", "backfill"]).default("incremental"),
});

/** `POST /api/admin/xero/force-sync`: the member or booking to sync, by id (or a member's email). */
export const xeroForceSyncFields = {
  syncType: z.enum(["CONTACT", "INVOICE", "MEMBERSHIP"]),
  query: z.string().trim().min(1, "Query is required"),
};

export const xeroForceSyncBodySchema = z.object(xeroForceSyncFields);
