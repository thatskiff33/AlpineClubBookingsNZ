"use client"

import { Badge } from "@/components/ui/badge"
import { useClubTime } from "@/components/club-time-provider"
import { formatPayloadInstantDate } from "../../../../_lib/payload-instant"
import type { MemberLifecycleActionRequest } from "../_types"

/**
 * #5540: every decided archive request and every unarchive, newest first. A
 * pending archive request is shown on its own above, with its review controls.
 * Ordered by when each was decided; an unarchive is decided when it is made.
 */
export function memberArchiveHistory(
  requests: readonly MemberLifecycleActionRequest[],
): MemberLifecycleActionRequest[] {
  const decidedAt = (request: MemberLifecycleActionRequest) =>
    request.reviewedAt ?? request.requestedAt
  return requests
    .filter(
      (request) =>
        request.action === "UNARCHIVE" ||
        (request.action === "ARCHIVE" && request.status !== "REQUESTED"),
    )
    .sort((left, right) => decidedAt(right).localeCompare(decidedAt(left)))
}

function entryLabel(request: MemberLifecycleActionRequest) {
  if (request.action === "UNARCHIVE") {
    return { text: "Unarchived", className: "bg-success-3 text-success-11 border-success-6" }
  }
  return request.status === "APPROVED"
    ? { text: "Archived", className: "bg-border text-foreground border-border" }
    : { text: "Archive rejected", className: "bg-danger-3 text-danger-11 border-danger-6" }
}

export function MemberLifecycleHistory({
  requests,
}: {
  requests: readonly MemberLifecycleActionRequest[]
}) {
  // Every stamp here is an instant, shown as a date in the club's zone (INV-CONFIG-002).
  const clubTime = useClubTime()
  const history = memberArchiveHistory(requests)
  if (history.length === 0) return null

  const on = (iso: string | null) =>
    iso ? formatPayloadInstantDate(clubTime, iso) : "an unknown date"

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-foreground">Archive history</p>
      <ul className="space-y-2" aria-label="Archive history">
        {history.map((request) => {
          const label = entryLabel(request)
          const reviewer = request.reviewedBy?.name ?? "Unknown admin"
          return (
            <li key={request.id} className="rounded-md border border-border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary" className={label.className}>
                  {label.text}
                </Badge>
                <span className="text-muted-foreground">
                  {request.action === "UNARCHIVE"
                    ? `By ${reviewer} on ${on(request.reviewedAt)}`
                    : `${request.status === "APPROVED" ? "Approved" : "Rejected"} by ${reviewer} on ${on(request.reviewedAt)}`}
                </span>
              </div>
              {request.action === "ARCHIVE" && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Requested by {request.requestedBy?.name ?? "Unknown admin"} on {on(request.requestedAt)}
                </p>
              )}
              <p className="mt-1 text-foreground">Reason: {request.reason}</p>
              {request.reviewNote && (
                <p className="mt-1 text-muted-foreground">Review note: {request.reviewNote}</p>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
