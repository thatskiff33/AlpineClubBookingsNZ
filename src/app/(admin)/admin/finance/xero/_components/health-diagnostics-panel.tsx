"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { AlertTriangle, CheckCircle2, Circle, Clock } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { FocusedActionError } from "@/components/focused-action-error"
import { bookingOwner } from "@/lib/booking-owner"
import { buildHrefWithReturnTo } from "@/lib/internal-return-path"
import { buildXeroContactUrl } from "@/lib/xero-links"
import { useClubTime } from "@/components/club-time-provider"
import { requireInstant, formatStayDateOrNull } from "@/lib/club-time"
import {
  AdminMemberXeroActionError,
  unlinkMemberXeroContact,
} from "@/lib/admin-member-xero-actions"
import {
  getXeroPartialSuccessGuidance,
  isXeroPartialSuccessRecovery,
} from "@/lib/xero-partial-success"
import { fetchJson, postJson } from "./api"
import { CreditUsedInXeroCard } from "./credit-used-in-xero-card"
import {
  BudgetStatusChip,
  HealthStatCard,
  SectionCard,
  shortId,
  ToneChip,
  type ToggleSection,
} from "./shared"
import { xeroSectionId } from "./types"
import { useAutoLoadOncePerOpening } from "./use-auto-load-once-per-opening"
import type {
  ContactGroupMismatchResponse,
  ContactLinkMismatchResponse,
  MissingInvoicesResponse,
  SectionKey,
  XeroHealthSnapshot,
} from "./types"
import { adminHref } from "@/lib/admin-hubs";
import { CONTACT_GROUP_MISMATCH_LIMIT, describeContactGroupMismatchTotal, describeContactResync } from "@/lib/xero-contact-group-mismatch-summary";
import { ContactGroupMismatchPanel } from "./contact-group-mismatch-panel"

type Props = {
  connected: boolean
  /**
   * Organisation short code for "Open in Xero" deep links, or null when
   * unavailable — the links then degrade to the generic session-scoped Xero
   * URL, they are never hidden (#2283).
   */
  shortCode: string | null
  currentXeroPath: string
  healthOpen: boolean
  contactGroupMismatchesOpen: boolean
  contactLinkMismatchesOpen: boolean
  onToggle: ToggleSection
  onMessage: (message: string) => void
  onRefreshOperations: () => void
  refreshToken: number
  scrollToSection: (section: SectionKey) => void
}

export function HealthAndDiagnosticsPanels({
  connected,
  shortCode,
  currentXeroPath,
  healthOpen,
  contactGroupMismatchesOpen,
  contactLinkMismatchesOpen,
  onToggle,
  onMessage,
  onRefreshOperations,
  refreshToken,
  scrollToSection,
}: Props) {
  // The membership-refresh stamp below is a real INSTANT, so it projects
  // through the club's persisted zone (CT-4, #2870; INV-CONFIG-002).
  const clubTime = useClubTime()
  const [health, setHealth] = useState<XeroHealthSnapshot | null>(null)
  const [healthError, setHealthError] = useState("")
  const [loadingHealth, setLoadingHealth] = useState(false)
  const [missingInvoices, setMissingInvoices] = useState<MissingInvoicesResponse | null>(null)
  const [loadingMissingInvoices, setLoadingMissingInvoices] = useState(false)
  const [showMissingInvoices, setShowMissingInvoices] = useState(false)
  const [triggeringMissingInvoices, setTriggeringMissingInvoices] = useState(false)

  const [groupMismatches, setGroupMismatches] = useState<ContactGroupMismatchResponse | null>(null)
  const [groupError, setGroupError] = useState("")
  const [loadingGroupMismatches, setLoadingGroupMismatches] = useState(false)
  const [resyncingGroupMismatches, setResyncingGroupMismatches] = useState(false)

  const [linkMismatches, setLinkMismatches] = useState<ContactLinkMismatchResponse | null>(null)
  const [linkError, setLinkError] = useState("")
  const [loadingLinkMismatches, setLoadingLinkMismatches] = useState(false)
  const [resyncingLinkMismatches, setResyncingLinkMismatches] = useState(false)
  const [unlinkingMemberId, setUnlinkingMemberId] = useState<string | null>(null)
  const [linkRecovery, setLinkRecovery] = useState<{
    id: string
    name: string
    message: string
  } | null>(null)
  const [linkRecoveryAttention, setLinkRecoveryAttention] = useState(0)

  const fetchHealth = useCallback(async () => {
    setLoadingHealth(true)
    setHealthError("")
    try {
      setHealth(await fetchJson<XeroHealthSnapshot>("/api/admin/xero/health", undefined, "Failed to fetch Xero health"))
    } catch (err) {
      setHealthError(err instanceof Error ? err.message : "Failed to load Xero health snapshot")
    } finally {
      setLoadingHealth(false)
    }
  }, [])

  const fetchMissingInvoices = useCallback(async () => {
    setLoadingMissingInvoices(true)
    setHealthError("")
    try {
      setMissingInvoices(await fetchJson<MissingInvoicesResponse>("/api/admin/xero/missing-invoices", undefined, "Failed to fetch missing invoices"))
    } catch (err) {
      setHealthError(err instanceof Error ? err.message : "Failed to load bookings missing Xero invoices")
    } finally {
      setLoadingMissingInvoices(false)
    }
  }, [])

  const fetchGroupMismatches = useCallback(async () => {
    setLoadingGroupMismatches(true)
    setGroupError("")
    try {
      setGroupMismatches(await fetchJson<ContactGroupMismatchResponse>(`/api/admin/xero/contact-group-mismatches?limit=${CONTACT_GROUP_MISMATCH_LIMIT}`, undefined, "Failed to fetch contact group mismatches"))
    } catch (err) {
      setGroupError(err instanceof Error ? err.message : "Failed to load Xero contact group mismatches")
    } finally {
      setLoadingGroupMismatches(false)
    }
  }, [])

  const fetchLinkMismatches = useCallback(async () => {
    setLoadingLinkMismatches(true)
    setLinkError("")
    try {
      setLinkMismatches(await fetchJson<ContactLinkMismatchResponse>("/api/admin/xero/contact-link-mismatches?limit=200", undefined, "Failed to fetch contact link mismatches"))
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : "Failed to load Xero contact link mismatches")
    } finally {
      setLoadingLinkMismatches(false)
    }
  }, [])

  // Refresh = resync (#1441): re-fetch the flagged contacts from Xero, then
  // recompute. Initial panel loads stay the cached GETs above.
  const resyncGroupMismatches = useCallback(async () => {
    setResyncingGroupMismatches(true)
    setGroupError("")
    try {
      setGroupMismatches(await postJson<ContactGroupMismatchResponse>("/api/admin/xero/contact-group-mismatches", { limit: CONTACT_GROUP_MISMATCH_LIMIT }, "Failed to re-sync the flagged contacts from Xero"))
    } catch (err) {
      setGroupError(err instanceof Error ? err.message : "Failed to re-sync the flagged contacts from Xero")
    } finally {
      setResyncingGroupMismatches(false)
    }
  }, [])

  const resyncLinkMismatches = useCallback(async () => {
    setResyncingLinkMismatches(true)
    setLinkError("")
    try {
      setLinkMismatches(await postJson<ContactLinkMismatchResponse>("/api/admin/xero/contact-link-mismatches", { limit: 200 }, "Failed to re-sync the flagged contacts from Xero"))
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : "Failed to re-sync the flagged contacts from Xero")
    } finally {
      setResyncingLinkMismatches(false)
    }
  }, [])

  // Each list auto-loads once per opening, so a failed read stays shown until
  // the admin presses its refresh instead of re-firing as it settles (#5276).
  useAutoLoadOncePerOpening({ active: connected && healthOpen, needed: !health, busy: loadingHealth, load: fetchHealth })
  useAutoLoadOncePerOpening({ active: connected && contactGroupMismatchesOpen, needed: !groupMismatches, busy: loadingGroupMismatches || resyncingGroupMismatches, load: fetchGroupMismatches })
  useAutoLoadOncePerOpening({ active: connected && contactLinkMismatchesOpen, needed: !linkMismatches, busy: loadingLinkMismatches || resyncingLinkMismatches, load: fetchLinkMismatches })

  useEffect(() => {
    if (!connected || refreshToken === 0) return
    if (healthOpen) void fetchHealth()
    if (contactGroupMismatchesOpen) void fetchGroupMismatches()
    if (contactLinkMismatchesOpen) void fetchLinkMismatches()
  }, [connected, contactGroupMismatchesOpen, contactLinkMismatchesOpen, fetchGroupMismatches, fetchHealth, fetchLinkMismatches, healthOpen, refreshToken])

  useEffect(() => {
    if (!connected) {
      setHealth(null)
      setGroupMismatches(null)
      setLinkMismatches(null)
      setMissingInvoices(null)
      setShowMissingInvoices(false)
    }
  }, [connected])

  const toggleMissingInvoices = async () => {
    const nextOpen = !showMissingInvoices
    setShowMissingInvoices(nextOpen)
    if (nextOpen && !missingInvoices && !loadingMissingInvoices) await fetchMissingInvoices()
  }

  const triggerMissingInvoices = async () => {
    setTriggeringMissingInvoices(true)
    setHealthError("")
    onMessage("")
    try {
      const data = await postJson<{ message?: string }>("/api/admin/xero/missing-invoices", undefined, "Failed to queue missing invoices")
      onMessage(data.message || "Queued missing booking invoices.")
      await Promise.all([fetchHealth(), fetchMissingInvoices()])
      onRefreshOperations()
    } catch (err) {
      setHealthError(err instanceof Error ? err.message : "Failed to queue missing invoices")
    } finally {
      setTriggeringMissingInvoices(false)
    }
  }

  const unlinkContactMismatch = async (memberId: string, memberName: string) => {
    setUnlinkingMemberId(memberId)
    setLinkError("")
    onMessage("")
    try {
      await unlinkMemberXeroContact(memberId)
      onMessage("Member unlinked from Xero. Open the member record to relink the correct contact.")
      await Promise.all([
        fetchHealth(),
        fetchLinkMismatches(),
        groupMismatches ? fetchGroupMismatches() : Promise.resolve(),
      ])
    } catch (err) {
      if (
        err instanceof AdminMemberXeroActionError &&
        isXeroPartialSuccessRecovery(err.recovery) &&
        err.recovery.xeroContactUnlinked
      ) {
        const guidance = getXeroPartialSuccessGuidance(err.recovery)
        setLinkRecovery({
          id: memberId,
          name: memberName,
          message: `${guidance} Refreshing Xero diagnostics now...`,
        })
        setLinkRecoveryAttention((version) => version + 1)
        setLinkMismatches((current) =>
          current
            ? {
                ...current,
                count: Math.max(0, current.count - 1),
                mismatches: current.mismatches.filter(
                  (mismatch) => mismatch.memberId !== memberId,
                ),
              }
            : current,
        )
        try {
          const [nextHealth, nextLinks, nextGroups] = await Promise.all([
            fetchJson<XeroHealthSnapshot>(
              "/api/admin/xero/health",
              undefined,
              "Failed to refresh Xero health",
            ),
            fetchJson<ContactLinkMismatchResponse>(
              "/api/admin/xero/contact-link-mismatches?limit=200",
              undefined,
              "Failed to refresh contact link mismatches",
            ),
            groupMismatches
              ? fetchJson<ContactGroupMismatchResponse>(
                  `/api/admin/xero/contact-group-mismatches?limit=${CONTACT_GROUP_MISMATCH_LIMIT}`,
                  undefined,
                  "Failed to refresh contact group mismatches",
                )
              : Promise.resolve(null),
          ])
          setHealth(nextHealth)
          setLinkMismatches(nextLinks)
          if (nextGroups) setGroupMismatches(nextGroups)
          setLinkRecovery({
            id: memberId,
            name: memberName,
            message: `${guidance} Diagnostics were refreshed; check the member before taking another Xero action.`,
          })
        } catch {
          setLinkRecovery({
            id: memberId,
            name: memberName,
            message: `${guidance} Diagnostics could not be refreshed. This warning remains active; reload before taking another Xero action.`,
          })
        }
        setLinkRecoveryAttention((version) => version + 1)
        return
      }
      setLinkError(err instanceof Error ? err.message : "Failed to unlink member from Xero")
    } finally {
      setUnlinkingMemberId(null)
    }
  }

  return (
    <>
      <FocusedActionError id="xero-health-error" error={healthError} className="mb-3" />
      <SectionCard
        id={xeroSectionId("health")}
        title="Health Snapshot"
        description="Quick checks for link coverage, stuck work, missing invoices, and daily Xero budget pressure."
        open={healthOpen}
        onToggle={(nextOpen) => onToggle("health", nextOpen)}
        actions={
          <Button variant="outline" size="sm" onClick={() => void fetchHealth()} disabled={loadingHealth}>
            {loadingHealth ? "Refreshing..." : "Refresh Health"}
          </Button>
        }
      >
        {loadingHealth && !health ? (
          <p className="text-sm text-muted-foreground">Loading health snapshot...</p>
        ) : health ? (
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              <HealthStatCard label="Unlinked members" value={health.unlinkedMembers.count} subtitle="Every active member with no Xero contact link — including ones the bulk create tool below sets aside (schools, anonymised accounts, no usable address)." href={health.unlinkedMembers.href} />
              <HealthStatCard
                label="Active failed issues"
                value={health.failedOperations.count}
                subtitle={health.failedOperations.legacyCount > 0 ? `Replayable failures that still need action. ${health.failedOperations.legacyCount} older failed rows are already repaired or superseded.` : "Replayable failures that still need action."}
                badge={health.failedOperations.count > 0 ? <ToneChip tone="danger" icon={AlertTriangle}>Needs attention</ToneChip> : <ToneChip tone="success" icon={CheckCircle2}>Clear</ToneChip>}
                onClick={() => scrollToSection("operations")}
              />
              <HealthStatCard
                label="Pending operations"
                value={health.pendingOperations.count}
                subtitle="Outbox operations waiting for the next cron pick-up. Nothing is executing yet; running work is tracked separately and flagged only when stale."
                badge={health.pendingOperations.count > 0 ? <ToneChip tone="neutral" icon={Clock}>Waiting</ToneChip> : <ToneChip tone="success" icon={CheckCircle2}>Idle</ToneChip>}
                onClick={() => scrollToSection("operations")}
              />
              <HealthStatCard
                label="Last membership refresh"
                value={<span className="text-base font-semibold">{health.lastMembershipRefresh.at ? clubTime.instantDateTime(requireInstant(health.lastMembershipRefresh.at)) : "Never"}</span>}
                subtitle={health.lastMembershipRefresh.lastCronStatus ? `Last cron status: ${health.lastMembershipRefresh.lastCronStatus}` : "No cron run recorded yet."}
                onClick={() => scrollToSection("membershipSync")}
              />
              <HealthStatCard
                label="Group mismatches"
                value={health.contactGroupMismatches.count}
                subtitle={!health.contactGroupMismatches.cacheReady ? "Refresh Xero contact groups before mismatch checks can run." : health.contactGroupMismatches.count > 0 ? `${describeContactGroupMismatchTotal(health.contactGroupMismatches)}. Linked members whose Xero contact groups disagree with the grouping rules.` : "Linked members whose Xero contact groups disagree with the grouping rules."}
                badge={!health.contactGroupMismatches.cacheReady ? <ToneChip tone="neutral" icon={Circle}>Cache needed</ToneChip> : health.contactGroupMismatches.count > 0 ? <ToneChip tone="warning" icon={AlertTriangle}>Review</ToneChip> : <ToneChip tone="success" icon={CheckCircle2}>Clear</ToneChip>}
                onClick={() => scrollToSection("contactGroupMismatches")}
              />
              <HealthStatCard
                label="Link mismatches"
                value={health.contactLinkMismatches.count}
                subtitle={health.contactLinkMismatches.cacheReady ? "Linked members whose local name does not match the cached Xero contact name." : "Run contact sync before name mismatch checks can run."}
                badge={!health.contactLinkMismatches.cacheReady ? <ToneChip tone="neutral" icon={Circle}>Cache needed</ToneChip> : health.contactLinkMismatches.count > 0 ? <ToneChip tone="warning" icon={AlertTriangle}>Review</ToneChip> : <ToneChip tone="success" icon={CheckCircle2}>Clear</ToneChip>}
                onClick={() => scrollToSection("contactLinkMismatches")}
              />
              <CreditUsedInXeroCard count={health.creditNotesSpentOutsideApp?.count ?? null} />
              <HealthStatCard
                label="API budget"
                value={health.apiBudget.usagePercent != null ? `${Math.round(health.apiBudget.usagePercent * 100)}%` : "Unknown"}
                subtitle={health.apiBudget.totalCalls != null ? `${health.apiBudget.totalCalls} calls today, ${health.apiBudget.failedCalls ?? 0} failed` : "Usage snapshot not available yet."}
                badge={<BudgetStatusChip status={health.apiBudget.status} />}
                onClick={() => scrollToSection("usage")}
              />
            </div>

            <div className="rounded-lg border p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold">Missing invoice detector</h3>
                    {health.missingInvoices.count > 0 ? (
                      <ToneChip tone="warning" icon={AlertTriangle}>{health.missingInvoices.count}</ToneChip>
                    ) : (
                      <ToneChip tone="success" icon={CheckCircle2}>{health.missingInvoices.count}</ToneChip>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">Paid bookings for which the club&apos;s records hold no Xero invoice.</p>{/* #3467: the club's invoice records decide this, never the operation's status */}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => void toggleMissingInvoices()}>
                    {showMissingInvoices ? "Hide Details" : "Show Details"}
                  </Button>
                  <Button size="sm" onClick={() => void triggerMissingInvoices()} disabled={triggeringMissingInvoices || health.missingInvoices.count === 0}>
                    {triggeringMissingInvoices ? "Queueing..." : "Trigger All Missing"}
                  </Button>
                </div>
              </div>
              {showMissingInvoices ? <MissingInvoicesList loading={loadingMissingInvoices} details={missingInvoices} currentXeroPath={currentXeroPath} /> : null}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No health data recorded yet.</p>
        )}
      </SectionCard>

      <FocusedActionError id="xero-contact-group-error" error={groupError} className="mb-3" />
      <ContactGroupMismatchPanel
        open={contactGroupMismatchesOpen}
        shortCode={shortCode}
        data={groupMismatches}
        loading={loadingGroupMismatches}
        resyncing={resyncingGroupMismatches}
        currentXeroPath={currentXeroPath}
        onToggle={onToggle}
        onRefresh={resyncGroupMismatches}
      />
      <FocusedActionError
        id="xero-contact-link-error"
        error={linkError}
        className="mb-3"
      />
      <FocusedActionError
        id="xero-contact-link-recovery"
        error={linkRecovery?.message ?? ""}
        attentionKey={linkRecoveryAttention}
        className="mb-3"
        action={
          linkRecovery ? (
            <Button asChild variant="outline" size="sm">
              <Link
                href={buildHrefWithReturnTo(
                  `${adminHref("member-detail", { id: linkRecovery.id })}`,
                  currentXeroPath,
                )}
                aria-label={`Open affected member: ${linkRecovery.name}`}
              >
                Open affected member
              </Link>
            </Button>
          ) : undefined
        }
      />
      <ContactLinkMismatchPanel
        open={contactLinkMismatchesOpen}
        shortCode={shortCode}
        data={linkMismatches}
        loading={loadingLinkMismatches}
        resyncing={resyncingLinkMismatches}
        currentXeroPath={currentXeroPath}
        onToggle={onToggle}
        onRefresh={resyncLinkMismatches}
        unlinkingMemberId={unlinkingMemberId}
        recoveryActive={linkRecovery !== null}
        onUnlink={unlinkContactMismatch}
      />
    </>
  )
}

function MissingInvoicesList({
  loading,
  details,
  currentXeroPath,
}: {
  loading: boolean
  details: MissingInvoicesResponse | null
  currentXeroPath: string
}) {
  // `createdAt` is a real INSTANT and needs the club's zone; `checkIn` and
  // `checkOut` are CALENDAR DATES the API serialises as UTC-midnight `@db.Date`
  // values, so they are decoded in UTC and formatted with no zone at all —
  // projecting them through any zone is the INV-DATE-019 defect, and through a
  // zone behind UTC it showed the night before (CT-4, #2870).
  const clubTime = useClubTime()
  if (loading && !details) return <p className="mt-4 text-sm text-muted-foreground">Loading missing invoice details...</p>
  if (!details) return <p className="mt-4 text-sm text-muted-foreground">No missing invoice details loaded yet.</p>
  if (details.count === 0) return <p className="mt-4 text-sm text-success">No paid bookings are currently missing a Xero invoice.</p>
  return (
    <div className="mt-4 space-y-3 border-t pt-4">
      <p className="text-sm text-muted-foreground">
        Showing {details.bookings.length} of {details.count} booking{details.count === 1 ? "" : "s"}.
      </p>
      {details.bookings.map((booking) => (
        <div key={booking.bookingId} className="rounded-md border p-3">
          <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <a href={buildHrefWithReturnTo(`/bookings/${booking.bookingId}`, currentXeroPath)} className="text-sm font-medium text-primary hover:underline">
                  Booking {shortId(booking.bookingId)}
                </a>
                <Badge variant="outline">{booking.status}</Badge>
              </div>
              <p className="text-sm">
                {/* #3369/#3480: a paid school booking can be missing its Xero invoice
                    too, and a school has no member page — its name is plain text
                    rather than a link to `/admin/members/null`. */}
                {bookingOwner(booking).memberId ? (
                  <a href={buildHrefWithReturnTo(`${adminHref("member-detail", { id: bookingOwner(booking).memberId })}`, currentXeroPath)} className="text-primary hover:underline">
                    {booking.memberName}
                  </a>
                ) : (
                  <span className="text-foreground">{booking.memberName}</span>
                )}
                <span className="ml-2 text-muted-foreground">{booking.memberEmail}</span>
              </p>
              <p className="text-xs text-muted-foreground">
                {formatStayDateOrNull(booking.checkIn, clubTime.format) ?? "—"} to {formatStayDateOrNull(booking.checkOut, clubTime.format) ?? "—"} - Payment {shortId(booking.paymentId)}
              </p>
            </div>
            <p className="text-xs text-muted-foreground">Created {clubTime.instantDateTime(requireInstant(booking.createdAt))}</p>
          </div>
        </div>
      ))}
    </div>
  )
}

function ContactLinkMismatchPanel({
  open,
  shortCode,
  data,
  loading,
  resyncing,
  currentXeroPath,
  onToggle,
  onRefresh,
  unlinkingMemberId,
  recoveryActive,
  onUnlink,
}: {
  open: boolean
  shortCode: string | null
  data: ContactLinkMismatchResponse | null
  loading: boolean
  resyncing: boolean
  currentXeroPath: string
  onToggle: ToggleSection
  onRefresh: () => Promise<void>
  unlinkingMemberId: string | null
  recoveryActive: boolean
  onUnlink: (memberId: string, memberName: string) => Promise<void>
}) {
  // Cache-refresh and re-sync stamps are real INSTANTS (CT-4, #2870).
  const clubTime = useClubTime()
  return (
    <SectionCard
      id={xeroSectionId("contactLinkMismatches")}
      title="Contact Link Mismatches"
      description="Audit linked members whose local name differs from the cached Xero contact name."
      open={open}
      onToggle={(nextOpen) => onToggle("contactLinkMismatches", nextOpen)}
      actions={<Button variant="outline" size="sm" onClick={() => void onRefresh()} disabled={loading || resyncing} title="Re-fetches the flagged contacts from Xero, then recomputes this audit.">{resyncing ? "Re-syncing from Xero..." : loading ? "Loading..." : "Refresh"}</Button>}
    >
      {loading && !data ? (
        <p className="text-sm text-muted-foreground">Loading contact link mismatches...</p>
      ) : data ? (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 rounded-lg border p-4 md:flex-row md:items-start md:justify-between">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold">Member/contact name audit</h3>
                {!data.cacheReady ? (
                  <ToneChip tone="neutral" icon={Circle}>Cache needed</ToneChip>
                ) : data.count > 0 ? (
                  <ToneChip tone="warning" icon={AlertTriangle}>{data.count} mismatch{data.count === 1 ? "" : "es"}</ToneChip>
                ) : (
                  <ToneChip tone="success" icon={CheckCircle2}>{data.count} mismatch{data.count === 1 ? "" : "es"}</ToneChip>
                )}
              </div>
              <p className="text-sm text-muted-foreground">Compares linked members against the cached Xero contact snapshot. Use this to unlink bad email-based matches, then relink the correct contact from the member record.</p>
              <p className="text-xs text-muted-foreground">
                {data.cacheReady && data.lastRefreshedAt ? `Contact cache last refreshed ${clubTime.instantDateTime(requireInstant(data.lastRefreshedAt))}.` : "The shared Xero contact cache has not been refreshed yet."}
              </p>
              {data.resync ? (
                <p className="text-xs text-success">
                  {describeContactResync(data.resync, clubTime.instantTime(requireInstant(data.resync.resyncedAt)))}
                </p>
              ) : null}
            </div>
          </div>
          {!data.cacheReady ? (
            <p className="text-sm text-muted-foreground">Run contact sync before relying on this audit.</p>
          ) : data.mismatches.length === 0 ? (
            <p className="text-sm text-success">No linked members are currently mismatched against the cached Xero contact names.</p>
          ) : (
            <div className="space-y-3">
              {data.mismatches.map((mismatch) => (
                <div key={mismatch.memberId} className="rounded-md border p-3">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <a href={buildHrefWithReturnTo(`${adminHref("member-detail", { id: mismatch.memberId })}`, currentXeroPath)} className="text-sm font-medium text-primary hover:underline">{mismatch.memberName}</a>
                        {mismatch.active ? (
                          <ToneChip tone="success" icon={CheckCircle2}>Active</ToneChip>
                        ) : (
                          <ToneChip tone="neutral" icon={Circle}>Inactive</ToneChip>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground">{mismatch.memberEmail}</p>
                      <p className="text-xs text-muted-foreground">Cached Xero contact: {mismatch.xeroContactName}{mismatch.xeroContactEmail ? ` (${mismatch.xeroContactEmail})` : ""}</p>
                      <p className="text-xs text-warning">{mismatch.reasons.join(", ")}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button asChild variant="outline" size="sm"><a href={buildHrefWithReturnTo(`${adminHref("member-detail", { id: mismatch.memberId })}`, currentXeroPath)}>Open Member</a></Button>
                      <Button asChild variant="outline" size="sm"><a href={buildXeroContactUrl(mismatch.xeroContactId, { shortCode })} target="_blank" rel="noopener noreferrer">Open in Xero</a></Button>
                      <Button size="sm" variant="outline" onClick={() => void onUnlink(mismatch.memberId, mismatch.memberName)} disabled={recoveryActive || unlinkingMemberId === mismatch.memberId}>
                        {unlinkingMemberId === mismatch.memberId ? "Unlinking..." : "Unlink"}
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No contact link mismatch audit has been loaded yet.</p>
      )}
    </SectionCard>
  )
}
