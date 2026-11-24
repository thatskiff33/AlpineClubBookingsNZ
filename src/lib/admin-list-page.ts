/**
 * The one shape and wording for a row-capped admin list (INV-OPS-020, #4960).
 *
 * Every officer queue route caps a read at `pageSize` rows (25 by default,
 * 100 at most). The route spreads `adminListPage(...)` into its JSON so each
 * client reads the same four keys, and the client renders the total through
 * `formatAdminListRange`. The audit timeline reads the same line for the
 * member's own Account Activity list. Pure: safe in route handlers and client
 * components.
 */
import { z } from "zod"

export const ADMIN_LIST_DEFAULT_PAGE_SIZE = 25
export const ADMIN_LIST_MAX_PAGE_SIZE = 100

/**
 * The `page` query field alone, for a list route whose page size is its own
 * (the Xero panels fall back to a `limit`; the audit logs cap at 50).
 */
export const adminListPageField = z.coerce.number().int().min(1).optional().default(1)

/**
 * The `page` / `pageSize` query fields each capped route spreads into its
 * schema. The descriptions are what an AI app is told about them (ALP-719).
 */
export const adminListPageQueryFields = {
  page: adminListPageField.describe("The page to read, from 1."),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(ADMIN_LIST_MAX_PAGE_SIZE)
    .optional()
    .default(ADMIN_LIST_DEFAULT_PAGE_SIZE)
    .describe(`Rows per page, 1 to ${ADMIN_LIST_MAX_PAGE_SIZE}; ${ADMIN_LIST_DEFAULT_PAGE_SIZE} by default.`),
}

/**
 * A focused deep link's record id (`?requestId=` / `?bookingId=`): the route
 * reads that one record so the panel can pin it when it is off the page.
 */
export const adminQueueFocusIdField = z.string().trim().min(1).max(64).optional()

export interface AdminListPage {
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export function adminListPage({
  page,
  pageSize,
  total,
}: {
  page: number
  pageSize: number
  total: number
}): AdminListPage {
  return {
    page,
    pageSize,
    total,
    totalPages: pageSize > 0 ? Math.ceil(total / pageSize) : 0,
  }
}

/**
 * "Showing 1–25 of 40"; "Showing 0 of 0" for an empty list; and, for a page
 * past the last row (a stale link), "Showing 0 of 40" rather than a range that
 * claims a row the page does not hold.
 */
export function formatAdminListRange({
  page,
  pageSize,
  total,
}: {
  page: number
  pageSize: number
  total: number
}): string {
  if (total <= 0) return "Showing 0 of 0"
  const offset = (page - 1) * pageSize
  if (offset >= total) return `Showing 0 of ${total}`
  return `Showing ${offset + 1}–${Math.min(page * pageSize, total)} of ${total}`
}

/**
 * Pending filters read oldest first so the longest-waiting request is on
 * page 1; decided and All filters stay newest first.
 */
export function adminQueueCreatedOrder(isPendingFilter: boolean): "asc" | "desc" {
  return isPendingFilter ? "asc" : "desc"
}

/** A `?page=` URL value as a positive integer, falling back to 1. */
export function parseAdminListPageParam(value: string | null | undefined): number {
  if (!value || !/^\d+$/.test(value)) return 1
  const page = Number(value)
  return Number.isSafeInteger(page) && page >= 1 ? page : 1
}

/**
 * Write a list's page into its URL: page 1 is the default and leaves no key,
 * so a first-page link stays clean. `key` names a second pager's param on a
 * screen with two lists (`archivePage`, `inPage`, `opPage`). Mutates and
 * returns `params`.
 */
export function setAdminListPageParam(
  params: URLSearchParams,
  page: number,
  key = "page",
): URLSearchParams {
  params.delete(key)
  if (page > 1) params.set(key, String(page))
  return params
}

/** The note beside a deep-linked record pinned above a queue page. */
export const PINNED_QUEUE_RECORD_NOTE =
  "Opened from a link — shown here because it is not on the page below."
