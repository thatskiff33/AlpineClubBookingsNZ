"use client"

import type { Ref } from "react"
import type { XeroOperation } from "./types"

/** #4220: the Failure selector's option names; "all" keeps FilterSelect's own "All failures". */
export const FAILURE_FILTER_LABELS: Record<NonNullable<XeroOperation["failureState"]>, string> = {
  ACTIVE: "Active only",
  REPAIRED: "Repaired",
  SUPERSEDED: "Superseded",
}

/**
 * #4220: the line under the filters while Failure = Active only is hiding rows.
 * The hidden rows are the audit trail, so they stay one click away.
 */
function HiddenFailuresNotice({ count, onShow }: { count: number; onShow: () => void }) {
  if (count <= 0) return null
  return (
    <p className="text-sm text-muted-foreground">
      {count} hidden (repaired, superseded or resolved).{" "}
      <button
        type="button"
        onClick={onShow}
        className="rounded-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Show them
      </button>
    </p>
  )
}

/**
 * #4220: the permanently mounted status region for the Failed view. It shows
 * the hidden-count line while Active only is on, and after "Show them" says
 * what changed and holds focus (the button has gone), so a keyboard or
 * screen-reader officer is not dropped back to the top of the page.
 */
export function FailedViewNotice({
  failureStateFilter,
  loading,
  hiddenCount,
  revealedCount,
  onShow,
  regionRef,
}: {
  failureStateFilter: string
  loading: boolean
  hiddenCount: number
  revealedCount: number | null
  onShow: () => void
  regionRef: Ref<HTMLDivElement>
}) {
  return (
    <div role="status" ref={regionRef} tabIndex={-1} className="focus-visible:outline-none">
      {revealedCount !== null && failureStateFilter === "all" ? (
        <p className="text-sm text-muted-foreground">
          Showing all failures, including {revealedCount} repaired, superseded or resolved.
        </p>
      ) : !loading && failureStateFilter === "ACTIVE" ? (
        <HiddenFailuresNotice count={hiddenCount} onShow={onShow} />
      ) : null}
    </div>
  )
}
