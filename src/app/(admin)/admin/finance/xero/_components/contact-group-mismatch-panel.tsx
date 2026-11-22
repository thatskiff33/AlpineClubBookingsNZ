"use client"

import Link from "next/link"
import { AlertTriangle, CheckCircle2, Circle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useClubTime } from "@/components/club-time-provider"
import { adminHref } from "@/lib/admin-hubs"
import { requireInstant } from "@/lib/club-time"
import { buildHrefWithReturnTo } from "@/lib/internal-return-path"
import { formatAgeTierName } from "@/lib/use-age-tier-options"
import {
  contactGroupMismatchTotal,
  describeContactGroupMismatchCounts,
  describeContactResync,
  REVIEW_BY_HAND_REASON,
  reviewByHandFix,
  unexpectedManagedGroupRefs,
  type ContactGroupMismatchCounts,
} from "@/lib/xero-contact-group-mismatch-summary"
import { buildXeroContactUrl } from "@/lib/xero-links"
import { SectionCard, ToneChip, type ToggleSection } from "./shared"
import { xeroSectionId, type ContactGroupMismatchResponse } from "./types"

// The Contact Group Mismatches section of /admin/xero (#5234 split it out of
// health-diagnostics-panel.tsx). It lists both kinds of entry the health tile
// and Stuck States count: mismatches to re-sync and entries to review by hand.

// Mismatches a grouping rule matches; the bulk re-sync on Xero member grouping repairs them.
function ResyncList({
  data,
  shortCode,
  currentXeroPath,
}: {
  data: ContactGroupMismatchResponse
  shortCode: string | null
  currentXeroPath: string
}) {
  return (
    <div className="space-y-3">
      <h4 className="text-sm font-semibold">To re-sync</h4>
      <p className="text-sm text-muted-foreground">Showing {data.mismatches.length} of {data.mismatchCount} mismatch{data.mismatchCount === 1 ? "" : "es"}.</p>
      {data.mismatches.map((mismatch) => (
        <div key={mismatch.memberId} className="rounded-md border p-3">
          <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <a href={buildHrefWithReturnTo(`${adminHref("member-detail", { id: mismatch.memberId })}`, currentXeroPath)} className="text-sm font-medium text-primary hover:underline">{mismatch.memberName}</a>
                <Badge variant="outline">{formatAgeTierName(mismatch.ageTier)}</Badge>
                {mismatch.addGroupId ? <ToneChip tone="warning" icon={AlertTriangle}>Add {mismatch.managedGroup?.name ?? mismatch.addGroupId}</ToneChip> : null}
                {mismatch.removeGroupIds.length > 0 ? <ToneChip tone="warning" icon={AlertTriangle}>{mismatch.removeGroupIds.length} to remove</ToneChip> : null}
              </div>
              <p className="text-sm text-muted-foreground">{mismatch.memberEmail}</p>
              <p className="text-xs text-muted-foreground">Would add: {mismatch.addGroupId ? (mismatch.managedGroup?.name ?? mismatch.addGroupId) : "nothing"}</p>
              <p className="text-xs text-muted-foreground">Would remove: {mismatch.removeGroupIds.length > 0 ? mismatch.removeGroupIds.join(", ") : "nothing"}</p>
            </div>
            <a href={buildXeroContactUrl(mismatch.xeroContactId, { shortCode })} target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline">Open in Xero</a>
          </div>
        </div>
      ))}
    </div>
  )
}

// #5234: members no grouping rule matches whose contacts still sit in a
// managed group. Counted on the health tile and in Stuck States, so each is
// named here with the group it sits in and what a person does about it.
function ReviewByHandList({
  data,
  shortCode,
  currentXeroPath,
}: {
  data: ContactGroupMismatchResponse
  shortCode: string | null
  currentXeroPath: string
}) {
  return (
    <div className="space-y-3">
      <h4 className="text-sm font-semibold">To review by hand</h4>
      <p className="text-sm text-muted-foreground">{REVIEW_BY_HAND_REASON} Showing {data.informational.length} of {data.informationalCount}.</p>
      {data.informational.map((entry) => {
        const groupNames = unexpectedManagedGroupRefs(entry).map((group) => group.name ?? group.id)
        return (
          <div key={entry.memberId} className="rounded-md border border-dashed p-3">
            <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <a href={buildHrefWithReturnTo(adminHref("member-detail", { id: entry.memberId }), currentXeroPath)} className="text-sm font-medium text-primary hover:underline">{entry.memberName}</a>
                  <Badge variant="outline">{formatAgeTierName(entry.ageTier)}</Badge>
                  <ToneChip tone="neutral" icon={Circle}>In {groupNames.join(", ")}</ToneChip>
                </div>
                <p className="text-sm text-muted-foreground">{entry.memberEmail}</p>
                <p className="text-xs text-muted-foreground">{reviewByHandFix(groupNames)}</p>
              </div>
              <a href={buildXeroContactUrl(entry.xeroContactId, { shortCode })} target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline">Open in Xero</a>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function mismatchCounts(data: ContactGroupMismatchResponse): ContactGroupMismatchCounts {
  return { resyncCount: data.mismatchCount, reviewByHandCount: data.informationalCount }
}

export function ContactGroupMismatchPanel({
  open,
  shortCode,
  data,
  loading,
  resyncing,
  currentXeroPath,
  onToggle,
  onRefresh,
}: {
  open: boolean
  shortCode: string | null
  data: ContactGroupMismatchResponse | null
  loading: boolean
  resyncing: boolean
  currentXeroPath: string
  onToggle: ToggleSection
  onRefresh: () => Promise<void>
}) {
  // Cache-refresh and re-sync stamps are real INSTANTS (CT-4, #2870).
  const clubTime = useClubTime()
  return (
    <SectionCard
      id={xeroSectionId("contactGroupMismatches")}
      title="Contact Group Mismatches"
      description="Audit linked members against the active Xero member-grouping rules under the current mode."
      open={open}
      onToggle={(nextOpen) => onToggle("contactGroupMismatches", nextOpen)}
      actions={<Button variant="outline" size="sm" onClick={() => void onRefresh()} disabled={loading || resyncing} title="Re-fetches the flagged contacts from Xero, then recomputes this audit.">{resyncing ? "Re-syncing from Xero..." : loading ? "Loading..." : "Refresh"}</Button>}
    >
      {loading && !data ? (
        <p className="text-sm text-muted-foreground">Loading contact group mismatches...</p>
      ) : data ? (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 rounded-lg border p-4 md:flex-row md:items-start md:justify-between">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold">Grouping status</h3>
                <Badge variant="outline">{formatGroupingMode(data.mode)}</Badge>
                {!data.cacheReady ? (
                  <ToneChip tone="neutral" icon={Circle}>Cache needed</ToneChip>
                ) : contactGroupMismatchTotal(mismatchCounts(data)) > 0 ? (
                  <ToneChip tone="warning" icon={AlertTriangle}>{describeContactGroupMismatchCounts(mismatchCounts(data))}</ToneChip>
                ) : (
                  <ToneChip tone="success" icon={CheckCircle2}>No mismatches</ToneChip>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {data.mode === "NONE"
                  ? "Grouping mode is None — the sync leaves existing Xero groups untouched."
                  : `${data.activeRuleCount} active rule${data.activeRuleCount === 1 ? "" : "s"}. ${data.addCount} add${data.addCount === 1 ? "" : "s"} / ${data.removeCount} remove${data.removeCount === 1 ? "" : "s"} across ${data.membersConsidered} linked member${data.membersConsidered === 1 ? "" : "s"} (≈ ${data.estimatedXeroCalls} Xero call${data.estimatedXeroCalls === 1 ? "" : "s"} for a full re-sync).`}
              </p>
              {data.skippedNoContact.length > 0 ? (
                <p className="text-xs text-muted-foreground">{data.skippedNoContact.length} member{data.skippedNoContact.length === 1 ? "" : "s"} without a Xero contact skipped.</p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                {data.cacheReady && data.lastRefreshedAt ? `Cache last refreshed ${clubTime.instantDateTime(requireInstant(data.lastRefreshedAt))}.` : "The shared Xero contact-group cache has not been refreshed yet."}
              </p>
              {data.resync ? (
                <p className="text-xs text-success">
                  {describeContactResync(data.resync, clubTime.instantTime(requireInstant(data.resync.resyncedAt)))}
                </p>
              ) : null}
            </div>
            <Link href={adminHref("xero-member-grouping")} className="text-sm text-primary hover:underline">Open Xero member grouping</Link>
          </div>
          {!data.cacheReady ? (
            <p className="text-sm text-muted-foreground">Refresh Xero contact groups before relying on this audit.</p>
          ) : contactGroupMismatchTotal(mismatchCounts(data)) === 0 ? (
            <p className="text-sm text-success">No linked members are currently mismatched against the active grouping rules.</p>
          ) : (
            <div className="space-y-6">
              {data.mismatches.length > 0 ? (
                <ResyncList data={data} shortCode={shortCode} currentXeroPath={currentXeroPath} />
              ) : null}
              {data.informational.length > 0 ? (
                <ReviewByHandList data={data} shortCode={shortCode} currentXeroPath={currentXeroPath} />
              ) : null}
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No mismatch audit has been loaded yet.</p>
      )}
    </SectionCard>
  )
}

function formatGroupingMode(mode: ContactGroupMismatchResponse["mode"]) {
  switch (mode) {
    case "NONE":
      return "Mode: None"
    case "MEMBERSHIP_TYPE":
      return "Mode: Membership Type"
    case "MEMBERSHIP_TYPE_AND_AGE":
      return "Mode: Membership Type + Age"
  }
}
