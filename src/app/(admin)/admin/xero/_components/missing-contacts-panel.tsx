"use client"

/**
 * The missing-Xero-contact panel (#2939). `INV-INT-022`.
 *
 * Three states in one section, because they are one decision: run the dry run,
 * read what it found, then confirm. The confirmation posts the member ids the
 * operator has just been shown together with the DIGEST of the plan they were
 * shown — the server intersects the ids with a freshly recomputed pushable set
 * and refuses outright if the plan itself has moved, so this list is what
 * BOUNDS the run rather than what drives it, and a member who became eligible
 * while the panel was open is never created behind the operator's back.
 *
 * The ambiguous and excluded lists are the point of the screen as much as the
 * button is: every row there is a member this tool deliberately will not decide
 * for, and the operator fixing one of them (a shared address, a school's
 * contact, a mis-named contact) is how the population shrinks honestly.
 *
 * The reason maps below are keyed on the ENGINE'S OWN exported unions rather
 * than on `string`. A `Record<Union, string>` makes a new reason a compile
 * error here instead of a fallback sentence quietly shipped to an operator —
 * which is exactly what happened when a sixth ambiguity class was added. The
 * wording belongs in the panel (it is copy); the KEYS belong to the engine.
 */

import { useState } from "react"
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react"

import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action"
import { useConfirm } from "@/components/confirm-dialog"
import { Badge } from "@/components/ui/badge"
import { buildHrefWithReturnTo } from "@/lib/internal-return-path"
import { buildXeroContactUrl } from "@/lib/xero-links"
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access"
import type {
  MissingContactAmbiguity,
  MissingContactEvidence,
  MissingContactExclusion,
  SeedingFailureKind,
  SeedingSkipReason,
} from "@/lib/xero-missing-contact-seeding"
import { fetchJson, postJson } from "./api"
import { SectionCard, type ToggleSection } from "./shared"

type MemberRef = { memberId: string; memberName: string; memberEmail: string }
type PushableRow = MemberRef & {
  evidence: MissingContactEvidence
  cachedXeroContactId: string | null
}
type ExcludedRow = MemberRef & { reason: MissingContactExclusion }
type AmbiguousRow = MemberRef & {
  reason: MissingContactAmbiguity
  xeroContactIds: string[]
}

type Snapshot = {
  cacheReady: boolean
  contactCacheLastRefreshedAt: string | null
  contactCacheAgeHours: number | null
  contactCacheStale: boolean
  plannedDigest: string
  chunkSize: number
  estimatedXeroCallsPerChunk: number
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

type Outcome = MemberRef & {
  outcome: "created" | "linked" | "unlabelled" | "failed"
  xeroContactId: string | null
  plannedEvidence: MissingContactEvidence
  kind: SeedingFailureKind | null
  error: string | null
}

type RunResult = {
  processed: number
  linkedExisting: number
  created: number
  resolvedUnlabelled: number
  failed: number
  failures: Array<{ memberId: string; kind: SeedingFailureKind; error: string }>
  outcomes: Outcome[]
  skipped: Array<{ memberId: string; reason: SeedingSkipReason }>
  remaining: number
  outstandingPushable: number
  done: boolean
  haltedByDailyLimit: boolean
  haltedByTimeBudget: boolean
}

/**
 * Operator wording for the machine-readable reasons the engine returns. It
 * lives here rather than in the engine because it is copy, and because the
 * engine is read by tests that should key on the stable token, not on a
 * sentence somebody may improve.
 */
const EXCLUDED_COPY: Record<MissingContactExclusion, string> = {
  SCHOOL_MEMBER_RECORD:
    "This is a school's own record. A school's Xero customer belongs to the school, not to a person.",
  SCHOOL_BOOKING_CONTACT:
    "This record was created as a school's booking contact, so its Xero customer belongs to the school.",
  ANONYMISED_ACCOUNT: "This account was anonymised by an approved deletion request.",
  INHERITED_ADDRESS_LOST:
    "This person used to get their email through somebody else, and that arrangement ended — so the address on the record is no longer a real one. Give them their own address if they should be contactable.",
  NO_REAL_EMAIL_ADDRESS:
    "There is no real email address on this record, so a Xero contact made for it could never be emailed by Xero, and a later sync could never match it back by address. Nothing needs doing: this record gets its Xero contact automatically the first time somebody raises an invoice for it.",
  INCOMPLETE_DETAILS:
    "A first name, last name and email address are all needed before a Xero contact can be created.",
}

const AMBIGUOUS_COPY: Record<MissingContactAmbiguity, string> = {
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
  XERO_CONTACT_ALREADY_HAS_THIS_NAME:
    "Xero already has a contact with exactly this name at a different address. Xero will not let a second contact use the name, and nothing here can tell whether it is the same person — check it in Xero, then link this member by hand or rename the old contact.",
}

/**
 * What a failed member means, and what to do about it. `PARTIAL_SUCCESS` is the
 * one class this application already has standing operator guidance for, and
 * that guidance is: do not repeat the action.
 */
const FAILURE_COPY: Record<SeedingFailureKind, string> = {
  TWO_HOMES_REFUSAL:
    "The Xero contact this member would have taken already belongs to another record here. Nothing was changed.",
  PROVIDER_ANSWER_UNAVAILABLE:
    "Xero could not be searched for an existing contact, so nothing was done rather than risk a second contact for somebody who already has one. Run this again later.",
  NAME_ALREADY_IN_XERO:
    "Xero already has a contact with this member's name, and nothing here may decide on the name alone whether it is the same person. Link this member by hand, or rename the old contact in Xero.",
  PLAN_DIVERGED:
    "Xero resolved a different contact from the one the dry run showed you. Check both contacts in Xero before raising anything for this member.",
  PARTIAL_SUCCESS:
    "Part of this went through at Xero and part did not. DO NOT RUN THIS AGAIN for this member — open Failed operations above and resolve it there.",
  OTHER: "This member could not be given a Xero contact.",
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

/** "3 hours ago" / "12 days ago", from whole hours. */
function describeCacheAge(hours: number): string {
  if (hours < 1) return "less than an hour ago"
  if (hours === 1) return "1 hour ago"
  if (hours < 48) return `${hours} hours ago`
  return `${Math.floor(hours / 24)} days ago`
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
  const { confirm, confirmDialog } = useConfirm()
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
    const batch = snapshot.pushableRows.slice(0, snapshot.chunkSize)
    const toCreate = batch.filter((row) => row.evidence === "NO_CACHED_MATCH").length
    const toLink = batch.length - toCreate

    /*
      THE CONFIRMATION, as a dialog rather than as one click on a button.

      The server-side revalidation underneath this is real; the operator half of
      "explicit confirmation" was not. There was no restatement of the count, no
      split between creating and linking, and the confirmation literal is set by
      the client, so it proved nothing about what a human saw. Every other write
      on this page — disconnect, mark non-replayable, resolve, the bulk member
      import — goes through this same shared confirm; the one action that writes
      new contacts into the club's real Xero ledger in bulk was the exception.
    */
    const confirmed = await confirm({
      title: `Create ${toCreate} new Xero contact${toCreate === 1 ? "" : "s"}?`,
      description:
        `This writes to the club's real Xero organisation. Of the next ` +
        `${batch.length} member${batch.length === 1 ? "" : "s"}, ${toCreate} ` +
        `will be given a brand-new Xero contact and ${toLink} will be linked ` +
        `to a contact Xero already has. Xero is searched again for each one ` +
        `first, and anything it cannot answer for is left alone.` +
        (snapshot.pushable > batch.length
          ? ` ${snapshot.pushable - batch.length} more will be left for the next batch.`
          : ""),
      confirmLabel: `Create ${toCreate} and link ${toLink}`,
    })
    if (!confirmed) return

    setBusy("run")
    setError("")
    try {
      const data = await postJson<{ result: RunResult }>(
        "/api/admin/xero/missing-contacts",
        {
          confirmReviewed: true,
          memberIds: snapshot.pushableRows.map((row) => row.memberId),
          // What the operator reviewed, as a value. The server recomputes it
          // and refuses the run if the plan has moved underneath them.
          plannedDigest: snapshot.plannedDigest,
        },
        "The contacts could not be created",
      )
      setResult(data.result)
      onMessage(
        `Xero contacts: ${data.result.created} created, ${data.result.linkedExisting} linked to a contact Xero already had` +
          (data.result.failed > 0 ? `, ${data.result.failed} not done` : "") +
          (data.result.outstandingPushable > 0
            ? `, ${data.result.outstandingPushable} still to do`
            : ""),
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

  const skippedNoLongerPushable =
    result?.skipped.filter((row) => row.reason === "NO_LONGER_PUSHABLE") ?? []

  return (
    <SectionCard
      id="missing-contacts"
      title="Members with no Xero contact"
      description="Find every member who has no Xero customer yet, review what would happen, then create the missing ones in small batches."
      open={open}
      onToggle={(nextOpen) => onToggle("missingContacts", nextOpen)}
    >
      <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4" />
      {confirmDialog}
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          The dry run reads only — it writes nothing to this site and nothing to Xero.
          Creating contacts always searches Xero for an existing one first, so a member
          who already has a contact is linked to it rather than given a second. This
          counts a narrower group than the &ldquo;Unlinked members&rdquo; figure at the top
          of this page: that one counts every active member with no Xero link, while this
          one sets aside schools, anonymised accounts, records with no usable address and
          incomplete profiles.
        </p>

        {/*
          BOTH buttons in this section opt out, because the section renders one
          banner above them — and both are gated on a SECOND axis the banner
          says nothing about: whether Xero is connected.

          That second axis is carried by the visible paragraph below rather than
          by a per-button reason, and deliberately so. A `ViewOnlyActionButton`
          that keeps its reason puts it in a `title` and an sr-only line on a
          DISABLED button — and `buttonVariants` sets
          `disabled:pointer-events-none`, so the title never fires at all, while
          the sr-only line sits on a control that is out of the tab order. That
          is the exact weakness `AdminViewOnlySectionBanner` was introduced to
          fix. Before this, the dry-run button passed a connection reason AND
          `describeReason={false}`, which suppressed the only channel that would
          have rendered it, and the file's banner is conditioned on the finance
          permission — so a full admin with Xero disconnected got a dead button
          and no explanation anywhere on the screen. The paragraph below is in
          the reading order, visible to everyone, and says it once.
        */}
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

        {!connected ? (
          <p className="flex items-start gap-2 text-sm text-warning">
            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
            Xero is not connected, so nothing on this panel can run. Connect Xero at the
            top of this page first.
          </p>
        ) : null}

        {error ? <p className="text-sm text-danger">{error}</p> : null}
        {notReady ? (
          <p className="flex items-start gap-2 text-sm text-warning">
            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
            {notReady}
          </p>
        ) : null}

        {snapshot && snapshot.cacheReady ? (
          <>
            {/*
              WHEN the cached contact list was last refreshed, beside the counts
              it decides. Its existence was always checked; its AGE was not, and
              age is what turns a "no Xero contact found" row into a duplicate —
              a six-month-old cache reads exactly like a five-minute-old one.
            */}
            <p
              className={
                snapshot.contactCacheStale
                  ? "flex items-start gap-2 text-sm text-warning"
                  : "text-xs text-muted-foreground"
              }
            >
              {snapshot.contactCacheStale ? (
                <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
              ) : null}
              <span>
                These counts are worked out from the Xero contacts cached here, last
                refreshed{" "}
                {snapshot.contactCacheAgeHours === null
                  ? "at an unknown time"
                  : describeCacheAge(snapshot.contactCacheAgeHours)}
                .
                {snapshot.contactCacheStale
                  ? " That is old enough to be wrong: a contact added in Xero since then looks like no contact at all here, which is how duplicates get made. Run Contact Sync before creating anything."
                  : ""}
              </span>
            </p>

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
              describe={(row) => AMBIGUOUS_COPY[(row as AmbiguousRow).reason]}
              returnTo={currentXeroPath}
              shortCode={shortCode}
            />

            <RowList
              title="Not eligible"
              tone="muted"
              rows={snapshot.excludedRows}
              describe={(row) => EXCLUDED_COPY[(row as ExcludedRow).reason]}
              returnTo={currentXeroPath}
              shortCode={shortCode}
            />

            {/* Opts out for the same reason as the dry-run button above. */}
            <ViewOnlyActionButton
              canEdit={canEdit && connected}
              describeReason={false}
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
                : `Create the next ${Math.min(snapshot.pushable, snapshot.chunkSize)} of ${snapshot.pushable}`}
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
              {result.failed > 0 ? `, ${result.failed} not done` : ""}.
            </p>
            {result.haltedByDailyLimit ? (
              <p className="mt-1 text-warning">
                Xero&apos;s daily limit stopped the run. Everything still outstanding is
                unchanged — come back tomorrow and run it again.
              </p>
            ) : null}
            {result.haltedByTimeBudget ? (
              <p className="mt-1 text-warning">
                The run stopped itself before it ran out of time, so that what it had
                already done was recorded. Everything else is unchanged — run it again.
              </p>
            ) : null}
            {result.outstandingPushable > 0 ? (
              <p className="mt-1 text-muted-foreground">
                {result.outstandingPushable} still to do. Run the dry run again and repeat.
              </p>
            ) : null}
            {skippedNoLongerPushable.length > 0 ? (
              <p className="mt-1 text-warning">
                {skippedNoLongerPushable.length} member
                {skippedNoLongerPushable.length === 1 ? "" : "s"} you approved
                {skippedNoLongerPushable.length === 1 ? " was" : " were"} left alone,
                because {skippedNoLongerPushable.length === 1 ? "it" : "they"} stopped
                being safe to push between the dry run and now. Run the dry run again to
                see why.
              </p>
            ) : null}

            {/*
              WHO, not just how many. "Three created, twenty-two linked" says
              nothing about which contact each member was linked to, and that is
              the one thing a wrong adoption would show up in.
            */}
            {result.outcomes.length > 0 ? (
              <ul className="mt-2 space-y-1">
                {result.outcomes.map((outcome) => (
                  <li
                    key={outcome.memberId}
                    className={outcome.outcome === "failed" ? "text-danger" : ""}
                  >
                    <span className="font-medium">{outcome.memberName}</span>{" "}
                    <span className="text-muted-foreground">{outcome.memberEmail}</span>
                    {" — "}
                    {outcome.outcome === "created"
                      ? "given a new Xero contact"
                      : outcome.outcome === "linked"
                        ? "linked to a contact Xero already had"
                        : outcome.outcome === "unlabelled"
                          ? "resolved (Xero did not say whether it was new)"
                          : (outcome.kind ? FAILURE_COPY[outcome.kind] : FAILURE_COPY.OTHER)}
                    {outcome.xeroContactId ? (
                      <>
                        {" "}
                        <a
                          href={buildXeroContactUrl(outcome.xeroContactId, { shortCode })}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline"
                        >
                          Open in Xero
                        </a>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </SectionCard>
  )
}
