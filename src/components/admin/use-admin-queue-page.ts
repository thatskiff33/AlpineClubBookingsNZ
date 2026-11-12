"use client"

import { useCallback, useMemo, useState } from "react"

import type { PaginationProps } from "@/components/admin/admin-pagination"
import {
  ADMIN_LIST_DEFAULT_PAGE_SIZE,
  adminListPage,
  formatAdminListRange,
} from "@/lib/admin-list-page"

interface QueuePageState {
  filterKey: string
  page: number
}

interface ReceivedPage {
  pageSize: number
  total: number
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/**
 * Client paging for a row-capped officer queue (INV-OPS-017, #4960).
 *
 * The page belongs to one filter: when `filterKey` changes the effective page
 * is 1 straight away, so the list's fetch effect runs once with the reset page
 * rather than once stale and once reset. `receive` records the total from the
 * route's `adminListPage` keys and steps back a page when a decision emptied
 * the last one. `pagination` is the props for the shared `Pagination`, with
 * the total line shown even on a single page.
 */
export function useAdminQueuePage({
  filterKey,
  initialPage = 1,
}: {
  filterKey: string
  initialPage?: number
}) {
  const [state, setState] = useState<QueuePageState>(() => ({
    filterKey,
    page: initialPage,
  }))
  const [received, setReceived] = useState<(ReceivedPage & { filterKey: string }) | null>(null)

  const page = state.filterKey === filterKey ? state.page : 1

  const setPage = useCallback(
    (nextPage: number) => {
      setState({ filterKey, page: Math.max(1, Math.floor(nextPage)) })
    },
    [filterKey],
  )

  /**
   * Record a queue response. Returns false when the requested page came back
   * empty past page 1 and the hook has stepped back to the new last page; the
   * caller's fetch effect then reloads that page.
   */
  const receive = useCallback(
    (body: unknown, rowCount: number): boolean => {
      const record = (body ?? {}) as Record<string, unknown>
      const nested = (record.pagination ?? {}) as Record<string, unknown>
      const pageSize =
        readNumber(record.pageSize) ??
        readNumber(nested.pageSize) ??
        ADMIN_LIST_DEFAULT_PAGE_SIZE
      const total =
        readNumber(record.total) ??
        readNumber(nested.total) ??
        (page - 1) * pageSize + rowCount
      setReceived({ filterKey, pageSize, total })
      if (rowCount === 0 && page > 1) {
        const lastPage = Math.max(1, adminListPage({ page, pageSize, total }).totalPages)
        if (lastPage < page) {
          setState({ filterKey, page: lastPage })
          return false
        }
      }
      return true
    },
    [filterKey, page],
  )

  const current = received && received.filterKey === filterKey ? received : null

  const pagination = useMemo<PaginationProps | null>(() => {
    if (!current) return null
    const { totalPages } = adminListPage({
      page,
      pageSize: current.pageSize,
      total: current.total,
    })
    return {
      page,
      totalPages,
      onPageChange: setPage,
      summary: formatAdminListRange({
        page,
        pageSize: current.pageSize,
        total: current.total,
      }),
      showSummaryOnSinglePage: true,
    }
  }, [current, page, setPage])

  return {
    page,
    setPage,
    receive,
    total: current?.total ?? null,
    pagination,
  }
}
