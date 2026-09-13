"use client"

/**
 * The missing-Xero-contact panel (#2939). `INV-INT-022`.
 *
 * Three states in one section, because they are one decision: run the dry run,
 * read what it found, then confirm. The confirmation posts the member ids the
 * operator has just been shown — the server intersects them with a freshly
 * recomputed pushable set, so this list is what BOUNDS the run rather than what
 * drives it, and a member who became eligible while the panel was open is never
 * created behind the operator's back.
 *
 * The ambiguous and excluded lists are the point of the screen as much as the
 * button is: every row there is a member this tool deliberately will not decide
 * for, and the operator fixing one of them (a shared address, a school's
 * contact, a mis-named contact) is how the population shrinks honestly.
 */

import { useState } from "react"
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react"

import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action"
import { Badge } from "@/components/ui/badge"
import { buildHrefWithReturnTo } from "@/lib/internal-return-path"
import { buildXeroContactUrl } from "@/lib/xero-links"
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access"
import { fetchJson, postJson } from "./api"
import { SectionCard, type ToggleSection } from "./shared"

type MemberRef = { memberId: string; memberName: string; memberEmail: string }
type PushableRow = MemberRef & {
  evidence: "CACHED_CONTACT_MATCH" | "NO_CACHED_MATCH"
  cachedXeroContactId: string | null
}
type ExcludedRow = MemberRef & { reason: string }
type AmbiguousRow = MemberRef & { reason: string; xeroContactIds: string[] }

type Snapshot = {
  cacheReady: boolean
  contactCacheLastRefreshedAt: string | null
  eligible: number
  alreadyLinked: number
  unlinked: number
  pushable: number
  excluded: number
  ambiguous: number
  pushableRows: PushableRow[]
  excludedRows: ExcludedRow[]
  ambiguousRows: AmbiguousRow[]
}

type RunResult = {
  processed: number
  linkedExisting: number
  created: number
  resolvedUnlabelled: number
  failed: number
  failures: Array<{ memberId: string; kind: string; error: string }>
  skippedNoLongerPushable: string[]
  remaining: number
  done: boolean
  haltedByDailyLimit: boolean
}

/**
 * Operator wording for the machine-readable reasons the engine returns. It
 * lives here rather than in the engine because it is copy, and because the
 * engine is read by tests that should key on the stable token, not on a
 * sentence somebody may improve.
 */
const EXCLUDED_COPY: Record<string, string> = {
  SCHOOL_MEMBER_RECORD:
    "This is a school's own record. A school's Xero customer belongs to the school, not to a person.",
  SCHOOL_BOOKING_CONTACT:
    "This record was created as a school's booking contact, so its Xero customer belongs to the school.",
  ANONYMISED_ACCOUNT: "This account was anonymised by an approved deletion request.",
  NO_REAL_EMAIL_ADDRESS:
    "There is no real email address on this record, so a Xero contact made for it could never be matched or emailed.",
  INCOMPLETE_DETAILS:
    "A first name, last name and email address are all needed before a Xero contact can be created.",
}

const AMBIGUOUS_COPY: Record<string, string> = {
  XERO_CONTACT_BELONGS_TO_A_SCHOOL:
    "The only Xero contact with this email address is a school's customer. Give this person their own address, or link them by hand.",
  ANOTHER_MEMBER_HOLDS_THE_CONTACT:
    "Another member is already linked to the Xero contact with this email address.",
  MEMBERS_SHARE_THE_EMAIL_ADDRESS:
    "More than one member here uses this email address, so nothing can tell whose Xero contact it would be.",
  SEVERAL_XERO_CONTACTS_SHARE_THE_EMAIL:
    "Several Xero contacts carry this email address. Tidy them up in Xero, or link this member by hand.",
  XERO_CONTACT_NAME_DIFFERS:
    "A Xero contact has this email address under a different name. Link it by hand if it really is the same person.",
}

function RowList({
  title,
  tone,
  rows,
  describe,
  returnTo,
  shortCode,
}: {
  title: string
  tone: "warning" | "muted"
  rows: Array<MemberRef & { xeroContactIds?: string[] }>
  describe: (row: MemberRef & { xeroContactIds?: string[] }) => string
  returnTo: string
  shortCode: string | null
}) {
  if (rows.length === 0) return null
  return (
    <div className="rounded-md border">
      <p className="border-b px-3 py-2 text-sm font-medium">
        {title} ({rows.length})
      </p>
      <ul className="divide-y">
        {rows.map((row) => (
          <li key={row.memberId} className="px-3 py-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <a
                href={buildHrefWithReturnTo(`/admin/members/${row.memberId}`, returnTo)}
                className="font-medium text-primary hover:underline"
              >
                {row.memberName}
              </a>
              <span className="text-muted-foreground">{row.memberEmail}</span>
              {(row.xeroContactIds ?? []).map((contactId) => (
                <a
                  key={contactId}
                  href={buildXeroContactUrl(contactId, { shortCode })}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  Open in Xero
                </a>
              ))}
            </div>
            <p className={tone === "warning" ? "text-warning" : "text-muted-foreground"}>
              {describe(row)}
            </p>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function MissingContactsPanel({
  connected,
  open,
  onToggle,
  currentXeroPath,
  shortCode,
  onMessage,
  onRefreshOperations,
}: {
  connected: boolean
  open: boolean
  onToggle: ToggleSection
  currentXeroPath: string
  shortCode: string | null
  onMessage: (message: string) => void
  onRefreshOperations: () => void
}) {
  const canEdit = useAdminAreaEditAccess("finance")
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [notReady, setNotReady] = useState("")
  const [busy, setBusy] = useState<"dry-run" | "run" | null>(null)
  const [error, setError] = useState("")
  const [result, setResult] = useState<RunResult | null>(null)

  const runDryRun = async () => {
    setBusy("dry-run")
    setError("")
    setResult(null)
    try {
      const data = await fetchJson<{ snapshot: Snapshot; notReadyMessage: string | null }>(
        "/api/admin/xero/missing-contacts",
        undefined,
        "The dry run could not be completed",
      )
      setSnapshot(data.snapshot)
      setNotReady(data.notReadyMessage ?? "")
    } catch (err) {
      setError(err instanceof Error ? err.message : "The dry run could not be completed")
    } finally {
      setBusy(null)
    }
  }

  const createContacts = async () => {
    if (!snapshot) return
    setBusy("run")
    setError("")
    try {
      const data = await postJson<{ result: RunResult }>(
        "/api/admin/xero/missing-contacts",
        {
          confirmReviewed: true,
          memberIds: snapshot.pushableRows.map((row) => row.memberId),
        },
        "The contacts could not be created",
      )
      setResult(data.result)
      onMessage(
        `Xero contacts: ${data.result.created} created, ${data.result.linkedExisting} linked to a contact Xero already had` +
          (data.result.remaining > 0 ? `, ${data.result.remaining} still to do` : ""),
      )
      onRefreshOperations()
      // The population has changed, so the reviewed list on screen is now stale:
      // replace it rather than leaving a confirm button pointing at old rows.
      await runDryRun()
    } catch (err) {
      setError(err instanceof Error ? err.message : "The contacts could not be created")
    } finally {
      setBusy(null)
    }
  }

  return (
    <SectionCard
      id="missing-contacts"
      title="Members with no Xero contact"
      description="Find every member who has no Xero customer yet, review what would happen, then create the missing ones in small batches."
      open={open}
      onToggle={(nextOpen) => onToggle("missingContacts", nextOpen)}
    >
      <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4" />
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          The dry run reads only — it writes nothing to this site and nothing to Xero.
          Creating contacts always searches Xero for an existing one first, so a member
          who already has a contact is linked to it rather than given a second.
        </p>

        <ViewOnlyActionButton
          canEdit={connected}
          describeReason={false}
          readOnlyReason="Connect Xero before running the dry run."
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={() => void runDryRun()}
        >
          {busy === "dry-run" ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-1 h-4 w-4" />
          )}
          {busy === "dry-run" ? "Checking…" : "Run the dry run"}
        </ViewOnlyActionButton>

        {error ? <p className="text-sm text-danger">{error}</p> : null}
        {notReady ? (
          <p className="flex items-start gap-2 text-sm text-warning">
            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
            {notReady}
          </p>
        ) : null}

        {snapshot && snapshot.cacheReady ? (
          <>
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="secondary">{snapshot.eligible} members considered</Badge>
              <Badge variant="secondary">{snapshot.alreadyLinked} already linked</Badge>
              <Badge variant="secondary">{snapshot.unlinked} with no contact</Badge>
              <Badge variant="secondary">{snapshot.pushable} ready to create or link</Badge>
              <Badge variant="secondary">{snapshot.ambiguous} need a decision</Badge>
              <Badge variant="secondary">{snapshot.excluded} not eligible</Badge>
            </div>

            <RowList
              title="Ready to create or link"
              tone="muted"
              rows={snapshot.pushableRows.map((row) => ({
                ...row,
                xeroContactIds: row.cachedXeroContactId ? [row.cachedXeroContactId] : [],
              }))}
              describe={(row) =>
                (row as PushableRow).evidence === "CACHED_CONTACT_MATCH"
                  ? "A Xero contact with this name and email address already exists — this member will be linked to it."
                  : "No Xero contact was found for this address in the last sync. Xero is searched again before anything is created."
              }
              returnTo={currentXeroPath}
              shortCode={shortCode}
            />

            <RowList
              title="Needs a decision — nothing will be done for these"
              tone="warning"
              rows={snapshot.ambiguousRows}
              describe={(row) =>
                AMBIGUOUS_COPY[(row as AmbiguousRow).reason] ??
                "This member needs a decision before a Xero contact can be created."
              }
              returnTo={currentXeroPath}
              shortCode={shortCode}
            />

            <RowList
              title="Not eligible"
              tone="muted"
              rows={snapshot.excludedRows}
              describe={(row) =>
                EXCLUDED_COPY[(row as ExcludedRow).reason] ??
                "This record is not part of the member population."
              }
              returnTo={currentXeroPath}
              shortCode={shortCode}
            />

            <ViewOnlyActionButton
              canEdit={canEdit && connected}
              readOnlyReason={
                connected
                  ? undefined
                  : "Connect Xero before creating any contacts."
              }
              size="sm"
              disabled={busy !== null || snapshot.pushable === 0}
              onClick={() => void createContacts()}
            >
              {busy === "run" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              {busy === "run"
                ? "Creating…"
                : `Create the next ${Math.min(snapshot.pushable, 25)} of ${snapshot.pushable}`}
            </ViewOnlyActionButton>
          </>
        ) : null}

        {result ? (
          <div className="rounded-md border p-3 text-xs">
            <p className="font-medium">
              {result.created} created, {result.linkedExisting} linked to an existing Xero
              contact
              {result.resolvedUnlabelled > 0
                ? `, ${result.resolvedUnlabelled} resolved (Xero did not say which)`
                : ""}
              .
            </p>
            {result.haltedByDailyLimit ? (
              <p className="mt-1 text-warning">
                Xero&apos;s daily limit stopped the run. Everything still outstanding is
                unchanged — come back tomorrow and run it again.
              </p>
            ) : null}
            {result.remaining > 0 ? (
              <p className="mt-1 text-muted-foreground">
                {result.remaining} still to do. Run the dry run again and repeat.
              </p>
            ) : null}
            {result.failures.length > 0 ? (
              <ul className="mt-2 space-y-1 text-danger">
                {result.failures.map((failure) => (
                  <li key={failure.memberId}>{failure.error}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </SectionCard>
  )
}
