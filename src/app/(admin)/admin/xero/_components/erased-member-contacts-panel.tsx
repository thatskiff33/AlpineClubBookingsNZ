"use client"

/**
 * The erased-member Xero contact review (#3058). `INV-INT-024`.
 *
 * A NOTICE, not a tool. Every other panel on this page does something; this one
 * tells an officer something and then gets out of the way. There is no action
 * button, no confirmation, no `ViewOnlyActionButton` and therefore no view-only
 * banner — not because the gating was skipped but because there is nothing here
 * to gate. The endpoint behind it is a `GET` with no `POST` sibling.
 *
 * THE COPY IS THE FEATURE, and it is written against one failure mode: an
 * officer reading this list as a to-do list of things the club must delete from
 * Xero. It must not read that way. The settled contract on #3058 is that this
 * application performs no Xero mutation as part of erasure and makes no claim
 * about what Xero should hold; whether a contact is archived, merged, edited or
 * left exactly as it is, is the treasurer's decision in their own system, and
 * invoices raised against it stay valid either way.
 *
 * The reason map below is keyed on the engine's own `ErasureKind` union rather
 * than on `string`, following the missing-contact panel: a third erasure path
 * would then be a compile error here instead of a blank cell shipped silently
 * to a treasurer.
 */

import { useCallback, useEffect, useState } from "react"
import { Loader2, RefreshCw } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { buildHrefWithReturnTo } from "@/lib/internal-return-path"
import { buildXeroContactUrl } from "@/lib/xero-links"
import type {
  ErasedMemberXeroContactReview,
  ErasedMemberXeroContactRow,
  ErasureKind,
  ReviewedContactStatus,
} from "@/lib/xero-erased-member-contact-review-shape"
import { fetchJson } from "./api"
import { SectionCard, type ToggleSection } from "./shared"

/**
 * Operator wording for the machine-readable kinds the engine returns. It lives
 * here rather than in the engine because it is copy, and because the engine is
 * read by tests that should key on the stable token rather than on a sentence
 * somebody may improve.
 */
const ERASURE_COPY: Record<ErasureKind, string> = {
  ANONYMISED_BY_DELETION_REQUEST:
    "Erased by an approved account deletion request. The member record is still here with their details removed.",
  HARD_DELETED:
    "Erased by an approved member delete. There is no member record left in this application at all.",
}

const STATUS_COPY: Record<ReviewedContactStatus, string> = {
  ACTIVE: "Active in Xero as at the last contact sync.",
  // Never rendered: an archived row is counted rather than listed. Present so
  // the map stays total over the union, which is what makes a new status a
  // compile error here.
  ARCHIVED: "Already archived in Xero.",
  UNKNOWN:
    "Not in this application's contact cache, so how Xero holds it is unknown here. Run Contact Sync if you want that filled in.",
}

/** "3 hours ago" / "12 days ago", from whole hours. */
function describeCacheAge(hours: number): string {
  if (hours < 1) return "less than an hour ago"
  if (hours === 1) return "1 hour ago"
  if (hours < 48) return `${hours} hours ago`
  return `${Math.floor(hours / 24)} days ago`
}

function ReviewRow({
  row,
  returnTo,
  shortCode,
}: {
  row: ErasedMemberXeroContactRow
  returnTo: string
  shortCode: string | null
}) {
  return (
    <li className="px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        {/*
          Linked only for the anonymising erasure. A hard delete removed the
          `Member` row, so the same link would be a 404 dressed up as a
          destination — and the id is still shown, because it is what ties this
          row to the club's own audit trail.
        */}
        {row.erasure === "ANONYMISED_BY_DELETION_REQUEST" ? (
          <a
            href={buildHrefWithReturnTo(`/admin/members/${row.memberId}`, returnTo)}
            className="font-mono font-medium text-primary hover:underline"
          >
            {row.memberId}
          </a>
        ) : (
          <span className="font-mono font-medium">{row.memberId}</span>
        )}
        <a
          href={buildXeroContactUrl(row.xeroContactId, { shortCode })}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline"
        >
          Open the contact in Xero
        </a>
        {row.contactStatus === "UNKNOWN" ? (
          <Badge variant="secondary" className="py-0 text-[10px]">
            Not in the cache
          </Badge>
        ) : null}
      </div>
      <p className="mt-0.5 text-muted-foreground">
        {ERASURE_COPY[row.erasure]}
        {row.erasedAt ? ` Erased ${row.erasedAt.slice(0, 10)}.` : ""}
      </p>
      <p className="text-muted-foreground">{STATUS_COPY[row.contactStatus]}</p>
    </li>
  )
}

export function ErasedMemberContactsPanel({
  open,
  onToggle,
  currentXeroPath,
  shortCode,
}: {
  open: boolean
  onToggle: ToggleSection
  currentXeroPath: string
  shortCode: string | null
}) {
  const [review, setReview] = useState<ErasedMemberXeroContactReview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const data = await fetchJson<{ review: ErasedMemberXeroContactReview }>(
        "/api/admin/xero/erased-member-contacts",
        undefined,
        "Could not read the erased-member contact review.",
      )
      setReview(data.review)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read the erased-member contact review.")
    } finally {
      setLoading(false)
    }
  }, [])

  // Loads itself the first time the section is opened. Safe to do without a
  // button, unlike its missing-contact sibling: this read touches the retired
  // link ledger rather than the whole member table, and it can create nothing.
  useEffect(() => {
    if (open && review === null && !loading && !error) void load()
  }, [open, review, loading, error, load])

  return (
    <SectionCard
      id="erased-member-contacts"
      title="Erased members with a Xero contact"
      description="Xero contacts that an erasure in this application left behind. Nothing here changes Xero."
      open={open}
      onToggle={(nextOpen) => onToggle("erasedMemberContacts", nextOpen)}
      actions={
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? (
            <Loader2 aria-hidden className="mr-2 size-4 animate-spin" />
          ) : (
            <RefreshCw aria-hidden className="mr-2 size-4" />
          )}
          Refresh
        </Button>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Erasing a member removes their details from this application and does nothing else. Xero is
          a separate system that this application never edits, archives or deletes anything in — so
          where an erased member had a Xero contact, that contact is still in Xero, and nothing here
          points at it any more.
        </p>
        <p className="text-sm text-muted-foreground">
          Each row below is one of those contacts, for you to look at in Xero if you want to. Whether
          it should be archived, merged, edited or left exactly as it is, is a decision for whoever
          administers Xero — this application is not asking for anything to be removed, and invoices
          and accounting history raised against a contact stay valid and usable either way.
        </p>

        {error ? <p className="text-sm text-danger">{error}</p> : null}

        {loading && review === null ? (
          <p className="text-sm text-muted-foreground">Reading...</p>
        ) : null}

        {review ? (
          <>
            <p className="text-sm">
              <span className="font-medium">{review.needsReview}</span>{" "}
              {review.needsReview === 1 ? "contact" : "contacts"} to look at.
              {review.alreadyArchivedInXero > 0
                ? ` ${review.alreadyArchivedInXero} more ${
                    review.alreadyArchivedInXero === 1 ? "is" : "are"
                  } already archived in Xero and ${
                    review.alreadyArchivedInXero === 1 ? "is" : "are"
                  } not listed.`
                : ""}
            </p>
            <p className="text-xs text-muted-foreground">
              {review.contactCacheLastRefreshedAt === null
                ? "Xero contacts have never been synced into this application, so whether each contact is still active in Xero is unknown here. The list itself does not depend on that."
                : `Contact cache last refreshed ${describeCacheAge(review.contactCacheAgeHours ?? 0)}.${
                    review.contactCacheStale
                      ? " That is old enough that a contact somebody has already archived in Xero may still be listed."
                      : ""
                  }`}
            </p>
            {review.truncated ? (
              <p className="text-xs text-warning">
                Only the oldest {review.rows.length} are listed.
              </p>
            ) : null}
            {review.rows.length > 0 ? (
              <div className="rounded-md border">
                <ul className="divide-y">
                  {review.rows.map((row) => (
                    <ReviewRow
                      key={`${row.memberId}|${row.xeroContactId}`}
                      row={row}
                      returnTo={currentXeroPath}
                      shortCode={shortCode}
                    />
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No erasure in this application has left a Xero contact behind.
              </p>
            )}
          </>
        ) : null}
      </div>
    </SectionCard>
  )
}
