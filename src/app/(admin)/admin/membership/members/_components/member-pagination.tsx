"use client"

import { Pagination } from "@/components/admin/admin-pagination"

interface MemberPaginationProps {
  page: number
  totalPages: number
  onPageChange: (page: number | ((current: number) => number)) => void
}

// Thin wrapper over the shared admin Pagination (#1805): callback mode, the same
// 5-slot window math, and the "Page N of M" summary. The shared control always
// hands back a concrete target page, which `setPage` accepts, so the members
// page keeps paginating unchanged. Rendered as a <div> to preserve this list's
// existing wrapper.
export function MemberPagination({
  page,
  totalPages,
  onPageChange,
}: MemberPaginationProps) {
  return (
    <Pagination
      as="div"
      aria-label="Members pagination"
      page={page}
      totalPages={totalPages}
      onPageChange={(target) => onPageChange(target)}
    />
  )
}
