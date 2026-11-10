"use client"

/**
 * The erased-member Xero contact review (#3058). `INV-INT-024`.
 *
 * A NOTICE, not a tool. Every other panel on this page acts on something; this
 * one tells an officer something and hands every decision to them.
 *
 * ONE CONTROL IS STILL GATED, and an earlier revision of this comment argued it
 * should not be — "nothing here is an edit, because the one control that
 * reaches Xero ASKS it a question and changes nothing in it". Changing nothing
 * in XERO is the wrong test. "Check these in Xero" spends the club's metered
 * Xero API budget, which is finite and shared: exhaust it and invoice sync,
 * payment sync and the outbox stop for everybody until it resets. And it writes
 * here, stamping what Xero said onto the retired `CONTACT` link. The route
 * takes `finance:edit` for exactly that, so the button is a
 * `ViewOnlyActionButton` under the section's one
 * `AdminViewOnlySectionBanner` — otherwise a view-only officer would get a live
 * button that answers 403. Refresh stays an ordinary `Button`: it re-reads
 * local state, costs nothing and is what the section is FOR.
 *
 * THE COPY IS THE FEATURE, and it is written against one failure mode: an
 * officer reading this list as a to-do list of things the club must delete from
 * Xero. It must not read that way. The settled contract on #3058 is that this
 * application makes no claim about what Xero should hold; whether a contact is
 * archived, merged, edited or left exactly as it is, is the treasurer's
 * decision in their own system, and invoices raised against it stay valid
 * either way.
 *
 * TWO SENTENCES HAVE BEEN NARROWED FROM AN EARLIER REVISION, because they were
 * not true. "Erasing a member removes their details from this application and
 * does nothing else" is wrong — erasure also cancels the member's future
 * bookings, and cancelling a paid one raises a credit note in Xero. And "this
 * application never edits, archives or deletes anything in it" is wrong for the
 * same reason, and a treasurer could disprove it from their own credit notes.
 * What is true is the narrower claim, which is also the one that matters here:
 * nothing this application does asks Xero to change the CONTACT.
 *
 * The reason and status maps below are keyed on the engine's own unions rather
 * than on `string`, following the missing-contact panel: a third erasure path,
 * or a fourth Xero contact status, is a compile error here instead of a blank
 * cell shipped silently to a treasurer.
 */

import { useCallback, useEffect, useState } from "react"
import { Loader2, RefreshCw, Search } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action"
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access"
import { useClubTime } from "@/components/club-time-provider"
import { requireInstant } from "@/lib/club-time"
import { buildHrefWithReturnTo } from "@/lib/internal-return-path"
import { buildXeroContactUrl } from "@/lib/xero-links"
import type {
  ErasedMemberXeroContactReview,
  ErasedMemberXeroContactRow,
  ErasureKind,
  ListedContactStatus,
} from "@/lib/xero-erased-member-contact-review-shape"
import { fetchJson, postJson } from "./api"
import { describeContactCacheAge, SectionCard, type ToggleSection } from "./shared"

/** What the status check reports back, mirroring the route's `check` field. */
interface StatusCheckSummary {
  checkedContacts: number
  observedContacts: number
  notFoundInXero: number
  retiredInXero: number
  checkedAt: string
}

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

/**
 * Total over `ListedContactStatus`, which is deliberately NARROWER than what
 * Xero can say. A contact Xero holds as archived — or as asked-to-be-erased —
 * is counted and never listed, so this map has no branch that cannot render.
 */
const STATUS_COPY: Record<ListedContactStatus, string> = {
  ACTIVE: "Xero holds this contact as active.",
  UNRECOGNISED:
    "Xero reports a status this application does not recognise, so it is listed to be on the safe side.",
  UNKNOWN:
    "Nobody has asked Xero about this contact yet, so how it holds it is unknown here.",
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
  const clubTime = useClubTime()
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
        {row.contactStatusCheckedAt === null ? (
          <Badge variant="secondary" className="py-0 text-[10px]">
            Not checked in Xero
          </Badge>
        ) : null}
      </div>
      <p className="mt-0.5 text-muted-foreground">
        {ERASURE_COPY[row.erasure]}
        {/*
          Through the club-time kernel, never by slicing an ISO instant. The
          earlier revision took the first ten characters of the UTC string,
          which renders the day BEFORE for most of the New Zealand working day
          — on a list whose whole selling point is working oldest-first by date
          (INV-CONFIG-002, INV-DATE). The SORT is on the raw instant and was
          never affected; only what an officer read was wrong.
        */}
        {row.erasedAt
          ? ` Erased ${clubTime.instantDate(requireInstant(row.erasedAt))}.`
          : ""}
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
  const clubTime = useClubTime()
  const canEdit = useAdminAreaEditAccess("finance")
  const [review, setReview] = useState<ErasedMemberXeroContactReview | null>(null)
  const [check, setCheck] = useState<StatusCheckSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [checking, setChecking] = useState(false)
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

  /*
    The one control that reaches Xero, and it reaches it to ASK. Without it this
    list can never shrink: the bulk contact sync fetches changed contacts with
    archived ones excluded, and the erasure deleted the contact's cache row, so
    a contact the treasurer archives is invisible to everything else here. It
    costs Xero API budget, which is why it is a button and not the page load.
  */
  const runCheck = useCallback(async () => {
    setChecking(true)
    setError("")
    try {
      const data = await postJson<{
        review: ErasedMemberXeroContactReview
        check: StatusCheckSummary
      }>(
        "/api/admin/xero/erased-member-contacts",
        undefined,
        "Could not check these contacts in Xero.",
      )
      setReview(data.review)
      setCheck(data.check)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not check these contacts in Xero.")
    } finally {
      setChecking(false)
    }
  }, [])

  // Loads itself the first time the section is opened. Safe to do without a
  // button, unlike its missing-contact sibling: this read touches the retired
  // link ledger rather than the whole member table, it creates nothing, and it
  // asks Xero nothing.
  useEffect(() => {
    if (open && review === null && !loading && !error) void load()
  }, [open, review, loading, error, load])

  const busy = loading || checking
  const nothingLeftBehind =
    review !== null && review.needsReview === 0 && review.alreadyRetiredInXero === 0

  return (
    <SectionCard
      id="erased-member-contacts"
      title="Erased members with a Xero contact"
      description="Xero contacts that an erasure in this application left behind. Nothing here changes Xero."
      open={open}
      onToggle={(nextOpen) => onToggle("erasedMemberContacts", nextOpen)}
      actions={
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={busy}>
            {loading ? (
              <Loader2 aria-hidden className="mr-2 size-4 animate-spin" />
            ) : (
              <RefreshCw aria-hidden className="mr-2 size-4" />
            )}
            Refresh
          </Button>
          {/*
            `describeReason={false}`, and the section's banner carries the
            explanation instead — the same arrangement as the missing-contact
            panel beside it, for the same measured reason: a kept reason lands
            in a `title` and an sr-only line on a DISABLED button, and
            `buttonVariants` sets `disabled:pointer-events-none`, so the title
            never fires and the sr-only line sits outside the tab order.
          */}
          <ViewOnlyActionButton
            canEdit={canEdit}
            describeReason={false}
            variant="outline"
            size="sm"
            onClick={() => void runCheck()}
            disabled={busy || review === null || review.rows.length === 0}
          >
            {checking ? (
              <Loader2 aria-hidden className="mr-2 size-4 animate-spin" />
            ) : (
              <Search aria-hidden className="mr-2 size-4" />
            )}
            Check these in Xero
          </ViewOnlyActionButton>
        </div>
      }
    >
      <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-3">
        You can read this list. Checking these contacts in Xero spends the
        club&apos;s Xero API allowance, so it needs finance edit access.
      </AdminViewOnlySectionBanner>
      <div className="space-y-3">
        {/*
          THE LOAD-BEARING SENTENCE, and the only emphasised thing on the panel.
          An earlier revision emphasised the backlog COUNT instead and left this
          in grey above it, so a treasurer skimming took away a bolded number —
          which is precisely the to-do-list reading the whole section exists to
          prevent.
        */}
        <p className="text-sm font-medium">
          This application is not asking for anything to be removed from Xero.
        </p>
        <p className="text-sm text-muted-foreground">
          Erasing a member removes their details from this application. It does not ask Xero to
          change, archive or delete their contact — Xero is a separate system, administered
          separately, and that decision is not this application&apos;s to make. So where an erased
          member had a Xero contact, that contact is still in Xero, and nothing here points at it any
          more.
        </p>
        <p className="text-sm text-muted-foreground">
          Each row below is one of those contacts, for you to look at in Xero if you want to. Whether
          it should be archived, merged, edited or left exactly as it is, is a decision for whoever
          administers Xero, and invoices and accounting history raised against a contact stay valid
          and usable either way.
        </p>

        {error ? <p className="text-sm text-danger">{error}</p> : null}

        {loading && review === null ? (
          <p className="text-sm text-muted-foreground">Reading...</p>
        ) : null}

        {review ? (
          <>
            {/*
              One text node, not a bold count beside loose words. Testing
              Library's `getByText` reads an element's OWN text children rather
              than its descendants', so a `<span>{count}</span>` beside the
              sentence is unassertable — the count belongs to the span and the
              words belong to the paragraph, and neither reads as the sentence
              an officer sees.

              And it is written so the DONE state reads as done. With nothing
              left to look at but some already dealt with, the earlier revision
              printed "0 contacts to look at" above "No erasure has left a Xero
              contact behind" — contradicting itself in the one state the
              archived count exists to celebrate.
            */}
            <p className="text-sm">
              {nothingLeftBehind
                ? "No erasure in this application has left a Xero contact behind."
                : review.needsReview === 0
                  ? `Nothing left to look at. All ${review.alreadyRetiredInXero} ${
                      review.alreadyRetiredInXero === 1 ? "contact" : "contacts"
                    } an erasure left behind ${
                      review.alreadyRetiredInXero === 1 ? "has" : "have"
                    } been archived or erased in Xero.`
                  : `${review.needsReview} ${
                      review.needsReview === 1 ? "contact" : "contacts"
                    } to look at.${
                      review.alreadyRetiredInXero > 0
                        ? ` ${review.alreadyRetiredInXero} more ${
                            review.alreadyRetiredInXero === 1 ? "has" : "have"
                          } already been archived or erased in Xero and ${
                            review.alreadyRetiredInXero === 1 ? "is" : "are"
                          } not listed.`
                        : ""
                    }`}
            </p>

            {/*
              How current the answer is, and — the part the earlier revision got
              wrong — what it takes to make it more current. Contact Sync will
              NOT do it: it fetches changed contacts with archived ones
              excluded, so the moment a treasurer archives a contact it becomes
              invisible to that sync for good.
            */}
            <p className="text-xs text-muted-foreground">
              {review.lastContactStatusCheckAt === null
                ? "Nobody has asked Xero about these contacts yet. Use “Check these in Xero” to find out which of them have already been archived; Contact Sync will not tell you, because it does not fetch archived contacts."
                : `Last checked in Xero ${clubTime.instantDateTime(
                    requireInstant(review.lastContactStatusCheckAt),
                  )}. A contact archived in Xero since then is still listed until you check again.`}
            </p>

            {check ? (
              <p className="text-xs text-muted-foreground">
                {`Asked Xero about ${check.checkedContacts} ${
                  check.checkedContacts === 1 ? "contact" : "contacts"
                }: ${check.retiredInXero} already archived or erased there${
                  check.notFoundInXero > 0
                    ? `, ${check.notFoundInXero} Xero no longer returns at all (merged away, most likely), which ${
                        check.notFoundInXero === 1 ? "stays" : "stay"
                      } listed`
                    : ""
                }.`}
              </p>
            ) : null}

            {review.contactCacheLastRefreshedAt !== null ? (
              <p className="text-xs text-muted-foreground">
                {`Where a contact has not been checked, the fallback is the shared Xero contact cache, last refreshed ${describeContactCacheAge(
                  review.contactCacheAgeHours ?? 0,
                )}.${
                  review.contactCacheStale
                    ? " That is old news, and for an erased member's contact the cache is usually empty anyway."
                    : ""
                }`}
              </p>
            ) : null}

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
            ) : null}
          </>
        ) : null}
      </div>
    </SectionCard>
  )
}
