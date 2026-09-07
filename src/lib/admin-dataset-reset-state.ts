import { endOfMonth, format, startOfMonth, subMonths } from "date-fns"

export const PAYMENT_DATASET_QUERY_KEYS = [
  "status",
  "source",
  "xeroState",
  "settlement",
  "lastUpdatedFrom",
  "lastUpdatedTo",
  "checkInFrom",
  "checkInTo",
  "search",
  "amountExact",
  "amountMin",
  "amountMax",
  "sortBy",
  "sortDir",
  "page",
] as const

export const SUBSCRIPTION_DATASET_QUERY_KEYS = [
  "status",
  "ageTier",
  "xeroContactGroup",
  "sortBy",
  "sortDir",
  "page",
] as const

export const XERO_OPERATIONS_DATASET_QUERY_KEYS = [
  "opStatus",
  "opEntityType",
  "opLocalModel",
  "opLocalId",
  "opOperationType",
  "opFailureState",
  "opResourceId",
  "opCreatedFrom",
  "opCreatedTo",
  "opPage",
] as const

export const XERO_INBOUND_DATASET_QUERY_KEYS = [
  "inStatus",
  "inEventCategory",
  "inLocalModel",
  "inLocalId",
  "inResourceId",
  "inEventType",
  "inCreatedFrom",
  "inCreatedTo",
  "inPage",
] as const

export const FINANCE_DASHBOARD_DATASET_QUERY_KEYS = [
  "range",
  "compare",
  "from",
  "to",
  "compareFrom",
  "compareTo",
  "forward",
  "forwardFrom",
  "forwardTo",
  "expenseCategoryId",
  "expenseLine",
] as const

export function withoutDatasetQueryKeys(
  currentSearch: string,
  keys: readonly string[],
): URLSearchParams {
  const params = new URLSearchParams(currentSearch)
  for (const key of keys) params.delete(key)
  return params
}

export function getPaymentsDatasetDefaults(clubToday: string) {
  const [year, month, day] = clubToday.split("-").map(Number)
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`clubToday must be a YYYY-MM-DD date, got: ${clubToday}`)
  }
  return {
    lastUpdatedFrom: format(
      subMonths(new Date(year, month - 1, day), 3),
      "yyyy-MM-dd",
    ),
    lastUpdatedTo: clubToday,
  }
}

export function resetPaymentsDatasetSearchParams(
  currentSearch: string,
  clubToday: string,
): URLSearchParams {
  const params = withoutDatasetQueryKeys(
    currentSearch,
    PAYMENT_DATASET_QUERY_KEYS,
  )
  const defaults = getPaymentsDatasetDefaults(clubToday)
  params.set("lastUpdatedFrom", defaults.lastUpdatedFrom)
  params.set("lastUpdatedTo", defaults.lastUpdatedTo)
  return params
}

export function resetSubscriptionsDatasetSearchParams(
  currentSearch: string,
): URLSearchParams {
  return withoutDatasetQueryKeys(currentSearch, SUBSCRIPTION_DATASET_QUERY_KEYS)
}

export function resetFinanceDashboardDatasetSearchParams(
  currentSearch: string,
): URLSearchParams {
  return withoutDatasetQueryKeys(
    currentSearch,
    FINANCE_DASHBOARD_DATASET_QUERY_KEYS,
  )
}

export function isFinanceDashboardDatasetDefault(selection: {
  range: string
  compare: string
  forward: string
  expenseCategoryId: string | null
  expenseLine: string | null
}): boolean {
  return (
    selection.range === "last-month" &&
    selection.compare === "previous-period" &&
    selection.forward === "next-month" &&
    !selection.expenseCategoryId &&
    !selection.expenseLine
  )
}

function resetXeroDatasetSearchParams(
  currentSearch: string,
  section: "operations" | "inbound",
  keys: readonly string[],
): URLSearchParams {
  const params = withoutDatasetQueryKeys(currentSearch, keys)
  params.set("section", section)
  return params
}

export function resetXeroOperationsDatasetSearchParams(
  currentSearch: string,
): URLSearchParams {
  return resetXeroDatasetSearchParams(
    currentSearch,
    "operations",
    XERO_OPERATIONS_DATASET_QUERY_KEYS,
  )
}

export function resetXeroInboundDatasetSearchParams(
  currentSearch: string,
): URLSearchParams {
  return resetXeroDatasetSearchParams(
    currentSearch,
    "inbound",
    XERO_INBOUND_DATASET_QUERY_KEYS,
  )
}

export function buildBookingRequestDatasetPath({
  basePath,
  currentSearch,
  fixedSearchParams,
  status,
  defaultStatus,
  recordKey,
  recordId,
}: {
  basePath: string
  currentSearch: string
  fixedSearchParams: Record<string, string>
  status: string
  defaultStatus: string
  recordKey: "bookingId" | "requestId"
  recordId: string | null
}): string {
  const params = new URLSearchParams(currentSearch)
  params.delete("status")
  for (const [key, value] of Object.entries(fixedSearchParams)) {
    params.set(key, value)
  }
  if (recordId) params.set(recordKey, recordId)
  if (status !== defaultStatus) params.set("status", status)

  const query = params.toString()
  return query ? `${basePath}?${query}` : basePath
}

export function getReportsDatasetDefaults(clubToday: string) {
  const [year, month, day] = clubToday.split("-").map(Number)
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`clubToday must be a YYYY-MM-DD date, got: ${clubToday}`)
  }
  const today = new Date(year, month - 1, day)
  return {
    from: format(startOfMonth(subMonths(today, 3)), "yyyy-MM-dd"),
    to: format(endOfMonth(today), "yyyy-MM-dd"),
    deleted: "hide",
  }
}

export function resetReportsDatasetState(
  current: { lodgeId: string },
  clubToday: string,
) {
  return {
    ...getReportsDatasetDefaults(clubToday),
    lodgeId: current.lodgeId,
  }
}
