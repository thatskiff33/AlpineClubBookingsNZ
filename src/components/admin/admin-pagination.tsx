import * as React from "react"
import Link from "next/link"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

/**
 * Windowed page numbers: at most five slots, sliding so the current page stays
 * centred. This is the exact 5-slot math the admin bookings and members lists
 * have always used; it is the single source of truth now that both delegate
 * here.
 */
export function pageWindowNumbers(page: number, totalPages: number): number[] {
  return Array.from({ length: Math.min(5, Math.max(totalPages, 0)) }, (_, index) => {
    if (totalPages <= 5) return index + 1
    if (page <= 3) return index + 1
    if (page >= totalPages - 2) return totalPages - 4 + index
    return page - 2 + index
  })
}

const DEFAULT_PAGE_SIZE_OPTIONS = [10, 25, 50, 100]

export interface PaginationProps {
  /** Current 1-based page. */
  page: number
  /** Total number of pages. */
  totalPages: number

  // ── URL mode ──
  /** Builds the href for a page. Presence selects URL mode (renders <Link>s). */
  hrefForPage?: (page: number) => string
  /** Builds the href for a page size. Enables the page-size selector in URL mode. */
  hrefForPageSize?: (pageSize: number) => string

  // ── Callback mode ──
  /** Called with the target page. Presence selects callback mode (renders buttons). */
  onPageChange?: (page: number) => void
  /** Called with the chosen page size. Enables the page-size selector in callback mode. */
  onPageSizeChange?: (pageSize: number) => void

  /** Current page size (required to render the page-size selector). */
  pageSize?: number
  /** Page-size options. Defaults to [10, 25, 50, 100]. */
  pageSizeOptions?: number[]

  /**
   * Left-hand summary text. Defaults to "Page {page} of {totalPages}". Pass a
   * node to customise (e.g. include a total count).
   */
  summary?: React.ReactNode
  /**
   * Render the summary even when everything fits on one page, so a capped
   * list always states its total (INV-OPS-019).
   */
  showSummaryOnSinglePage?: boolean

  /** Wrapper element. Defaults to "nav". */
  as?: "nav" | "div"
  /** Accessible label for the wrapper. Defaults to "Pagination". */
  "aria-label"?: string
  /** Extra classes for the wrapper. */
  className?: string
}

/**
 * The one admin pagination control. Supports URL-driven pages (shareable links,
 * `hrefForPage`) and client callback pages (`onPageChange`), plus an optional
 * page-size selector in either mode. Shared (non-client) so a Server Component
 * can render it directly; callback mode only mounts inside a client page.
 *
 * Renders nothing when there is a single page (or none) and no page-size
 * selector — matching the long-standing behaviour of the admin lists — unless
 * `showSummaryOnSinglePage` asks for the summary line alone.
 */
export function Pagination({
  page,
  totalPages,
  hrefForPage,
  hrefForPageSize,
  onPageChange,
  onPageSizeChange,
  pageSize,
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
  summary,
  showSummaryOnSinglePage = false,
  as = "nav",
  "aria-label": ariaLabel = "Pagination",
  className,
}: PaginationProps) {
  const showPageSize =
    pageSize !== undefined &&
    (hrefForPageSize !== undefined || onPageSizeChange !== undefined)

  if (totalPages <= 1 && !showPageSize && !showSummaryOnSinglePage) return null

  const atFirst = page <= 1
  const atLast = page >= totalPages
  const isUrlMode = hrefForPage !== undefined

  function renderPageButton(target: number, label: string, content: React.ReactNode) {
    if (isUrlMode) {
      return (
        <Button variant="outline" size="sm" asChild>
          <Link href={hrefForPage!(target)} aria-label={label}>
            {content}
          </Link>
        </Button>
      )
    }
    return (
      <Button
        variant="outline"
        size="sm"
        aria-label={label}
        onClick={() => onPageChange?.(target)}
      >
        {content}
      </Button>
    )
  }

  const Wrapper = as
  const summaryText = summary ?? `Page ${page} of ${totalPages}`

  return (
    <Wrapper
      aria-label={ariaLabel}
      className={cn(
        "mt-4 flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <p className="text-sm text-muted-foreground">{summaryText}</p>

      <div className="flex flex-wrap items-center gap-3">
        {showPageSize ? (
          <div
            role="group"
            aria-label="Rows per page"
            className="flex items-center gap-1"
          >
            <span className="mr-1 text-sm text-muted-foreground">Rows</span>
            {pageSizeOptions.map((size) => {
              const isCurrent = size === pageSize
              if (isCurrent) {
                return (
                  <Button
                    key={size}
                    variant="default"
                    size="sm"
                    aria-current="true"
                    aria-label={`${size} rows per page, current`}
                    disabled
                  >
                    {size}
                  </Button>
                )
              }
              if (hrefForPageSize !== undefined) {
                return (
                  <Button key={size} variant="outline" size="sm" asChild>
                    <Link
                      href={hrefForPageSize(size)}
                      aria-label={`Show ${size} rows per page`}
                    >
                      {size}
                    </Link>
                  </Button>
                )
              }
              return (
                <Button
                  key={size}
                  variant="outline"
                  size="sm"
                  aria-label={`Show ${size} rows per page`}
                  onClick={() => onPageSizeChange?.(size)}
                >
                  {size}
                </Button>
              )
            })}
          </div>
        ) : null}

        {totalPages > 1 ? (
          <div className="flex gap-1">
            {atFirst ? (
              <Button variant="outline" size="sm" disabled aria-label="Previous page">
                <ChevronLeft className="h-4 w-4" />
              </Button>
            ) : (
              renderPageButton(page - 1, "Previous page", <ChevronLeft className="h-4 w-4" />)
            )}

            {pageWindowNumbers(page, totalPages).map((pageNumber) =>
              pageNumber === page ? (
                <Button
                  key={pageNumber}
                  variant="default"
                  size="sm"
                  aria-current="page"
                  aria-label={`Page ${pageNumber}, current page`}
                  disabled
                >
                  {pageNumber}
                </Button>
              ) : (
                <React.Fragment key={pageNumber}>
                  {renderPageButton(
                    pageNumber,
                    `Go to page ${pageNumber}`,
                    pageNumber,
                  )}
                </React.Fragment>
              ),
            )}

            {atLast ? (
              <Button variant="outline" size="sm" disabled aria-label="Next page">
                <ChevronRight className="h-4 w-4" />
              </Button>
            ) : (
              renderPageButton(page + 1, "Next page", <ChevronRight className="h-4 w-4" />)
            )}
          </div>
        ) : null}
      </div>
    </Wrapper>
  )
}
