"use client"

import { formatDistanceToNow } from "date-fns"
import { Info } from "lucide-react"

const CACHE_EXPLANATION =
  "Xero group badges and filters on this page come from a cached snapshot. Use Refresh Xero Groups to update it."

/**
 * Contextual hint shown next to the "Refresh Xero Groups" button on the admin
 * members list. When the contact-group cache has been refreshed it shows how
 * long ago (with an info icon explaining what the cache backs); when it has
 * never been refreshed it prompts the operator to populate it.
 */
export function XeroGroupsRefreshHint({
  lastRefreshedAt,
}: {
  lastRefreshedAt: string | null
}) {
  if (!lastRefreshedAt) {
    return (
      <p className="text-xs text-muted-foreground">
        No cached Xero groups yet — refresh to populate badges.
      </p>
    )
  }

  const relative = formatDistanceToNow(new Date(lastRefreshedAt), {
    addSuffix: true,
  })

  return (
    <p className="flex items-center gap-1 text-xs text-muted-foreground">
      <span>Groups last refreshed {relative}</span>
      <span
        role="img"
        aria-label={CACHE_EXPLANATION}
        title={CACHE_EXPLANATION}
        className="inline-flex text-muted-foreground"
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
    </p>
  )
}
