"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useSession } from "next-auth/react"
import { isFullAdmin } from "@/lib/access-roles"
import { Download, RefreshCw, Upload } from "lucide-react"
import { Alert } from "@/components/ui/alert"
import { FocusedActionError } from "@/components/focused-action-error"
import { Button } from "@/components/ui/button"
import { AdminPageHeader } from "@/components/admin/admin-page-header"
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action"
import {
  getMemberPasswordActionKind,
} from "@/components/admin/member-password-action-button"
import { toast } from "sonner"
import { useScrollToFeedback } from "@/hooks/use-scroll-to-feedback"
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access"
import { useXeroOrgShortCode } from "@/hooks/use-xero-org-short-code"
import { useMembershipTypeOptions } from "@/hooks/use-membership-type-options"
import {
  getXeroPartialSuccessGuidance,
  isXeroPartialSuccessRecovery,
} from "@/lib/xero-partial-success"
import type { XeroActionRecovery } from "@/lib/admin-member-xero-actions"
import { buildHrefWithReturnTo } from "@/lib/internal-return-path"
import {
  usePublishDiagnosticsViewState,
  type DiagnosticsViewState,
} from "@/components/help-widget/help-widget-context"
import {
  DIAGNOSTICS_PAGE_NETWORK_ERROR_CODE,
  diagnosticsPageErrorCodeForStatus,
} from "@/lib/diagnostics/page-context/error-code"
import type { DiagnosticsPageErrorCode } from "@/lib/diagnostics/page-context/registry"
import { isPublishableDiagnosticsFilterValue } from "@/lib/diagnostics/page-context/types"
import { isAppliedMemberAgeTier } from "./_age-tier-filter-values"
import { MemberBulkActionBar } from "./_components/member-bulk-action-bar"
import { MemberBulkDialog } from "./_components/member-bulk-dialog"
import { MemberBulkMembershipDialog } from "./_components/member-bulk-membership-dialog"
import { MemberEditorDialog } from "./_components/member-editor-dialog"
import { MemberFilterToolbar } from "./_components/member-filter-toolbar"
import { MemberImportDialog } from "./_components/member-import-dialog"
import { MemberPagination } from "./_components/member-pagination"
import { MemberPasswordActionDialog } from "./_components/member-password-action-dialog"
import { MemberTable } from "./_components/member-table"
import { XeroGroupsRefreshHint } from "./_components/xero-groups-refresh-hint"
import { useMembersQueryState } from "./_hooks/use-members-query-state"
import { useXeroContactGroups } from "./_hooks/use-xero-contact-groups"
import type { BulkAction, ImportResult, Member, PasswordActionTarget } from "./_types"

interface MembersResponse {
  members: Member[]
  total: number
  totalPages: number
}

export default function MembersPage() {
  const { data: session } = useSession()
  const canEditMembership = useAdminAreaEditAccess("membership")
  const actorIsFullAdmin = isFullAdmin({
    accessRoles: session?.user?.accessRoles ?? [],
  })
  const {
    search,
    setSearch,
    debouncedSearch,
    page,
    setPage,
    pageSize,
    sortBy,
    sortDir,
    filters,
    setFilter,
    resetDataset,
    isDatasetDefault,
    activeFilterCount,
    toggleSort,
    buildMembersSearchParams,
    buildMembersListPath,
    buildExportUrl,
  } = useMembersQueryState()
  const [members, setMembers] = useState<Member[]>([])
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  /** The code the last list load failed with, or null (#2816). */
  const [loadErrorCode, setLoadErrorCode] =
    useState<DiagnosticsPageErrorCode | null>(null)
  const [xeroRecoveryError, setXeroRecoveryError] = useState("")
  const [xeroRecoveryAttention, setXeroRecoveryAttention] = useState(0)
  const [xeroRecoveryMemberId, setXeroRecoveryMemberId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false)
  const [bulkAction, setBulkAction] = useState<BulkAction>("")
  const [membershipDialogOpen, setMembershipDialogOpen] = useState(false)
  const [passwordActionDialogOpen, setPasswordActionDialogOpen] = useState(false)
  const [passwordActionTarget, setPasswordActionTarget] =
    useState<PasswordActionTarget | null>(null)
  const errorRef = useRef<HTMLDivElement>(null)
  const { scrollToError } = useScrollToFeedback()

  const showSuccess = useCallback((message: string, durationMs = 3000) => {
    toast.success(message, { duration: durationMs })
  }, [])

  const showWarning = useCallback((message: string) => {
    setError(message)
    setTimeout(() => setError(""), 8000)
  }, [])

  useEffect(() => {
    if (error && !xeroRecoveryError) scrollToError(errorRef)
  }, [error, scrollToError, xeroRecoveryError])

  const fetchMembersWithResult = useCallback(async (): Promise<boolean> => {
    // #2816: the outcome is recorded so the page can publish "there is no list,
    // and here is why" rather than filters that produced nothing on screen. It is
    // separate from `error`, which also carries bulk-action and Xero failures that
    // say nothing about whether the list is a list.
    let failure: DiagnosticsPageErrorCode | null = null
    try {
      const params = buildMembersSearchParams()
      params.set("page", String(page))
      params.set("pageSize", String(pageSize))
      params.set("sortBy", sortBy)
      params.set("sortDir", sortDir)
      const res = await fetch(`/api/admin/members?${params.toString()}`)
      if (!res.ok) {
        failure = diagnosticsPageErrorCodeForStatus(res.status)
        throw new Error("Failed to fetch members")
      }
      const data = (await res.json()) as MembersResponse
      setMembers(data.members)
      setTotal(data.total)
      setTotalPages(data.totalPages)
      return true
    } catch {
      failure = failure ?? DIAGNOSTICS_PAGE_NETWORK_ERROR_CODE
      setError("Failed to load members")
      return false
    } finally {
      setLoadErrorCode(failure)
      setLoading(false)
    }
  }, [buildMembersSearchParams, page, pageSize, sortBy, sortDir])

  const fetchMembers = useCallback(async (): Promise<void> => {
    await fetchMembersWithResult()
  }, [fetchMembersWithResult])

  const showXeroRecovery = useCallback(async (recovery: XeroActionRecovery) => {
    const guidance = isXeroPartialSuccessRecovery(recovery)
      ? getXeroPartialSuccessGuidance(recovery)
      : "A Xero action completed only in part. Do not repeat it until the member's current Xero status has been checked."
    setXeroRecoveryMemberId(
      typeof recovery.memberId === "string" && recovery.memberId.length > 0
        ? recovery.memberId
        : null,
    )
    setXeroRecoveryError(`${guidance} Refreshing the member list now...`)
    setXeroRecoveryAttention((value) => value + 1)
    const refreshed = await fetchMembersWithResult()
    setXeroRecoveryError(
      refreshed
        ? `${guidance} The member list was refreshed successfully; check the current Xero link before taking another action.`
        : `${guidance} The member list could not be refreshed. This warning remains active; reload the page before taking another Xero action.`,
    )
    setXeroRecoveryAttention((value) => value + 1)
  }, [fetchMembersWithResult])

  useEffect(() => {
    void fetchMembers()
  }, [fetchMembers])

  // WHAT THIS LIST ACTUALLY FILTERED BY, published for AI Diagnostics (#2816,
  // owner decision 13 Aug 2026).
  //
  // `q` IS `debouncedSearch`, NOT `search`. `search` is the raw keystroke draft
  // in the box; `useMembersQueryState` only promotes it 300ms later, and only
  // `debouncedSearch` reaches `buildMembersSearchParams` and therefore the fetch.
  // Publishing the draft would report a search that has filtered nothing —
  // including the whole of the window in which an operator types a name and
  // immediately asks why nobody is showing up. The member search is free text
  // over names and emails and it travels per the owner decision, disclosed
  // beside the Diagnostics input.
  //
  // `ageTier` IS CHECKED AGAINST THE VOCABULARY FIRST. `buildMembersWhere` applies
  // it only when it is a real `AgeTier` and otherwise IGNORES it — no 400, no
  // narrowing — so `?ageTier=<junk>` leaves the list unfiltered while the toolbar
  // still displays a tier. A bare truthiness test here published that junk as an
  // applied filter (review finding, 13 Aug 2026).
  //
  // This row allowlists no statuses and no other filter keys, so the rest of the
  // toolbar's filters (role, lifecycle, membership type, family group, Xero) are
  // not published — the route would drop them, and publishing to be dropped is not
  // a contract. The evidence block's header tells the model the selection is
  // always a partial list.
  //
  // Always an OBJECT, empty when nothing is applied: `undefined` would mean "this
  // page publishes nothing" and hand the widget back to its URL fallback.
  //
  // ASSIGNED BY NAME onto a typed empty object rather than built as a spread
  // literal: a conditional spread loses object-literal freshness, so TypeScript
  // runs no excess-property check and a field renamed in the wire contract would
  // compile clean here (mutation-proven, review 13 Aug 2026).
  const publishedView: DiagnosticsViewState = {}
  if (loadErrorCode) {
    // A FAILED LOAD IS NOT AN UNFILTERED LIST. `{}` would assert "I applied
    // nothing", so "why is this member not here?" would be answered against the
    // search when the real cause is that there is no list at all.
    publishedView.errorCode = loadErrorCode
  } else {
    const applied: Record<string, string> = {}
    // `q` IS UNBOUNDED SERVER-SIDE (`optionalSearchParam` is a bare
    // `z.string()`), so an arbitrarily long one is genuinely applied and the only
    // bound that matters is the ask route's own: over it, the route drops the
    // value, and a dropped filter published as applied tells the model nothing
    // about the narrowing that emptied the list (review finding, 14 Aug 2026).
    if (isPublishableDiagnosticsFilterValue(debouncedSearch)) {
      applied.q = debouncedSearch
    }
    if (filters.ageTier && isAppliedMemberAgeTier(filters.ageTier)) {
      applied.ageTier = filters.ageTier
    }
    if (Object.keys(applied).length > 0) publishedView.filters = applied
  }
  usePublishDiagnosticsViewState(publishedView)

  const {
    xeroConnected,
    xeroFeatures,
    xeroContactGroupsList,
    refreshingXeroGroups,
    refreshXeroGroups,
    lastRefreshedAt: xeroGroupsLastRefreshedAt,
  } = useXeroContactGroups({
    onError: setError,
    onSuccess: showSuccess,
    refreshMembers: fetchMembers,
  })

  // Org short code for the table/editor "open in Xero" deep links (#2283).
  // One mount per page; served from the server-side 12h org cache, and null
  // degrades every link to the generic Xero URL rather than hiding it.
  const { shortCode: xeroOrgShortCode } = useXeroOrgShortCode(
    xeroConnected === true,
  )

  // The club's own membership types, fetched ONCE here and handed to both
  // consumers (#2978). The filter toolbar has always needed them for its
  // Membership Type picker; the table now needs them too, to name a non-member
  // category's fallback type the way this club names it. Each calling the hook
  // for itself would fetch the same admin endpoint twice on every page load.
  const membershipTypes = useMembershipTypeOptions()

  const membersListPath = buildMembersListPath()
  const exportUrl = buildExportUrl()

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleSelectAll = useCallback(() => {
    // #2620: never sweep up a member an approved deletion request has
    // anonymised. A deleted account is `active: false, cancelledAt: null`, so it
    // sits in the Inactive filter beside genuinely deactivated members, and a
    // "select all → Reactivate" to undo a mistaken bulk deactivate is exactly how
    // an erased person could get their login back without anyone intending it.
    const selectable = members.filter((member) => !member.deletedAccount)
    setSelectedIds((current) =>
      current.size === selectable.length
        ? new Set()
        : new Set(selectable.map((member) => member.id))
    )
  }, [members])

  const selectedPasswordSummary = useMemo(() => {
    const selectedMembers = members.filter((member) => selectedIds.has(member.id))
    const inviteCount = selectedMembers.filter(
      (member) => getMemberPasswordActionKind(member) === "invite"
    ).length
    const resendInviteCount = selectedMembers.filter(
      (member) => getMemberPasswordActionKind(member) === "resend-invite"
    ).length
    const resetCount = selectedMembers.filter(
      (member) => getMemberPasswordActionKind(member) === "reset-password"
    ).length
    const passwordActionCount = inviteCount + resendInviteCount + resetCount
    const inviteTotalCount = inviteCount + resendInviteCount
    const bulkPasswordActionLabel =
      passwordActionCount === 0
        ? "No Login Email Action"
        : inviteTotalCount > 0 && resetCount > 0
          ? "Invite / Reset Password"
          : resetCount > 0
            ? "Send Password Reset"
            : resendInviteCount > 0 && inviteCount === 0
              ? "Resend Invite"
              : "Send Invite"

    return { passwordActionCount, bulkPasswordActionLabel }
  }, [members, selectedIds])

  const getPasswordActionTarget = useCallback(
    (ids: string[], label: string): PasswordActionTarget => {
      const memberById = new Map(members.map((member) => [member.id, member]))

      return ids.reduce<PasswordActionTarget>(
        (target, id) => {
          const member = memberById.get(id)
          if (!member) return target
          const actionKind = getMemberPasswordActionKind(member)
          if (actionKind === "reset-password") target.resetIds.push(id)
          else if (actionKind === "resend-invite") target.resendInviteIds.push(id)
          else if (actionKind === "invite") target.inviteIds.push(id)
          return target
        },
        { label, inviteIds: [], resendInviteIds: [], resetIds: [] }
      )
    },
    [members]
  )

  const openPasswordActionDialog = useCallback(
    (ids: string[], label: string) => {
      setPasswordActionTarget(getPasswordActionTarget(ids, label))
      setPasswordActionDialogOpen(true)
    },
    [getPasswordActionTarget]
  )

  const openBulkDialog = (action: BulkAction) => {
    if (action === "set-membership-type") {
      setMembershipDialogOpen(true)
      return
    }
    setBulkAction(action)
    setBulkDialogOpen(true)
  }

  const memberNames = useMemo(
    () =>
      new Map(
        members.map((member) => [
          member.id,
          `${member.firstName} ${member.lastName}`.trim() || member.email,
        ]),
      ),
    [members],
  )

  const handleMembershipChanged = (changed: number) => {
    showSuccess(`Changed membership type for ${changed} member(s)`)
    setSelectedIds(new Set())
    void fetchMembers()
  }

  const handleRefreshXeroGroups = () => {
    setError("")
    void refreshXeroGroups()
  }

  const handleBulkUpdated = (updated: number) => {
    showSuccess(`Updated ${updated} member(s)`)
    setSelectedIds(new Set())
    void fetchMembers()
  }

  const handleImported = (result: ImportResult) => {
    const skippedText = result.skipped > 0 ? `, skipped ${result.skipped}` : ""
    const filterNote =
      search.trim() || debouncedSearch.trim() || activeFilterCount > 0
        ? " Current search or filters may hide newly imported members."
        : ""
    showSuccess(`Imported ${result.created} member(s)${skippedText}.${filterNote}`, 7000)
    void fetchMembers()
  }

  const handlePasswordComplete = (message: string) => {
    showSuccess(message, 5000)
    setPasswordActionTarget(null)
    setSelectedIds(new Set())
    void fetchMembers()
  }

  const handlePasswordOpenChange = (open: boolean) => {
    setPasswordActionDialogOpen(open)
    if (!open) setPasswordActionTarget(null)
  }

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It sits OUTSIDE the `space-y-*` stack so
    the empty wrapper an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEditMembership} className="mb-6">
      Your admin role can view membership records but cannot create, edit,
      import, or bulk-update members.
    </AdminViewOnlySectionBanner>
  )

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6">
      <AdminPageHeader
        title="Members"
        description={`${total} member${total !== 1 ? "s" : ""}${
          debouncedSearch ? ` matching "${debouncedSearch}"` : " total"
        }`}
        actions={
          <div className="flex flex-col items-start gap-1.5 sm:items-end">
            <div className="flex flex-wrap gap-2">
              {xeroConnected && (
                <ViewOnlyActionButton
                  canEdit={canEditMembership}
                  describeReason={false}
                  variant="outline"
                  size="sm"
                  onClick={handleRefreshXeroGroups}
                  disabled={refreshingXeroGroups}
                >
                  <RefreshCw
                    className={`h-4 w-4 mr-1 ${refreshingXeroGroups ? "animate-spin" : ""}`}
                  />
                  {refreshingXeroGroups ? "Refreshing Xero Groups..." : "Refresh Xero Groups"}
                </ViewOnlyActionButton>
              )}
              <a href={exportUrl}>
                <Button variant="outline" size="sm">
                  <Download className="h-4 w-4 mr-1" />
                  Export CSV
                </Button>
              </a>
              <ViewOnlyActionButton
                canEdit={canEditMembership}
                describeReason={false}
                variant="outline"
                size="sm"
                onClick={() => setImportDialogOpen(true)}
              >
                <Upload className="h-4 w-4 mr-1" />
                Import CSV
              </ViewOnlyActionButton>
              <ViewOnlyActionButton
                canEdit={canEditMembership}
                describeReason={false}
                onClick={() => setCreateDialogOpen(true)}
              >
                Add Member
              </ViewOnlyActionButton>
            </div>
            {xeroConnected && (
              <XeroGroupsRefreshHint lastRefreshedAt={xeroGroupsLastRefreshedAt} />
            )}
          </div>
        }
      />

      <FocusedActionError
        id="members-xero-recovery-error"
        error={xeroRecoveryError}
        attentionKey={xeroRecoveryAttention}
        className="scroll-mt-20"
        action={
          xeroRecoveryMemberId ? (
            <Button asChild variant="outline" size="sm">
              <Link
                href={buildHrefWithReturnTo(
                  `/admin/members/${encodeURIComponent(xeroRecoveryMemberId)}`,
                  membersListPath,
                )}
              >
                Open affected member
              </Link>
            </Button>
          ) : undefined
        }
      />

      {error && (
        <Alert
          ref={errorRef}
          variant="error"
          role="alert"
          tabIndex={-1}
          className="scroll-mt-20 focus:outline-none"
        >
          {error}
          <button onClick={() => setError("")} className="ml-2 underline">
            Dismiss
          </button>
        </Alert>
      )}
      <MemberFilterToolbar
        search={search}
        filters={filters}
        xeroFeatures={xeroFeatures}
        xeroContactGroupsList={xeroContactGroupsList}
        membershipTypes={membershipTypes}
        onSearchChange={setSearch}
        onSetFilter={setFilter}
        resetDisabled={isDatasetDefault}
        onReset={resetDataset}
      />

      {canEditMembership && (
        <MemberBulkActionBar
          selectedCount={selectedIds.size}
          selectedPasswordActionCount={selectedPasswordSummary.passwordActionCount}
          bulkPasswordActionLabel={selectedPasswordSummary.bulkPasswordActionLabel}
          onOpenBulkDialog={openBulkDialog}
          onOpenPasswordActionDialog={() =>
            openPasswordActionDialog(
              [...selectedIds],
              `${selectedPasswordSummary.passwordActionCount} selected login member(s)`
            )
          }
          onClearSelection={() => setSelectedIds(new Set())}
        />
      )}

      <div className="space-y-4">
        <MemberTable
          members={members}
          loading={loading}
          debouncedSearch={debouncedSearch}
          selectedIds={selectedIds}
          canEdit={canEditMembership}
          xeroOrgShortCode={xeroOrgShortCode}
          sortBy={sortBy}
          sortDir={sortDir}
          membersListPath={membersListPath}
          membershipTypes={membershipTypes}
          onToggleSelect={toggleSelect}
          onToggleSelectAll={toggleSelectAll}
          onToggleSort={toggleSort}
          onOpenPasswordActionDialog={openPasswordActionDialog}
        />
        <MemberPagination
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
        />
      </div>

      <MemberEditorDialog
        open={createDialogOpen}
        actorIsFullAdmin={actorIsFullAdmin}
        xeroConnected={xeroConnected}
        xeroOrgShortCode={xeroOrgShortCode}
        onOpenChange={setCreateDialogOpen}
        onSaved={() => void fetchMembers()}
        onSuccess={showSuccess}
        onWarning={showWarning}
        onRecoveryWarning={showXeroRecovery}
      />
      <MemberBulkDialog
        open={bulkDialogOpen}
        action={bulkAction}
        selectedIds={selectedIds}
        onOpenChange={setBulkDialogOpen}
        onUpdated={handleBulkUpdated}
        onError={setError}
      />
      <MemberBulkMembershipDialog
        open={membershipDialogOpen}
        selectedIds={selectedIds}
        memberNames={memberNames}
        onOpenChange={setMembershipDialogOpen}
        onComplete={handleMembershipChanged}
        onError={setError}
      />
      <MemberPasswordActionDialog
        open={passwordActionDialogOpen}
        target={passwordActionTarget}
        onOpenChange={handlePasswordOpenChange}
        onComplete={handlePasswordComplete}
      />
      <MemberImportDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
        onImported={handleImported}
        onError={setError}
      />
      </div>
    </div>
  )
}
