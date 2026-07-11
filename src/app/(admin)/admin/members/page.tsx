"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { useSession } from "next-auth/react"
import { isFullAdmin } from "@/lib/access-roles"
import { Download, RefreshCw, Upload } from "lucide-react"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  AdminViewOnlyNotice,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action"
import {
  getMemberPasswordActionKind,
} from "@/components/admin/member-password-action-button"
import { toast } from "sonner"
import { useScrollToFeedback } from "@/hooks/use-scroll-to-feedback"
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access"
import { buildHrefWithReturnTo } from "@/lib/internal-return-path"
import { MemberBulkActionBar } from "./_components/member-bulk-action-bar"
import { MemberBulkDialog } from "./_components/member-bulk-dialog"
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
  const router = useRouter()
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
    clearFilters,
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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false)
  const [bulkAction, setBulkAction] = useState<BulkAction>("")
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
    if (error) scrollToError(errorRef)
  }, [error, scrollToError])

  const fetchMembers = useCallback(async () => {
    try {
      const params = buildMembersSearchParams()
      params.set("page", String(page))
      params.set("pageSize", String(pageSize))
      params.set("sortBy", sortBy)
      params.set("sortDir", sortDir)
      const res = await fetch(`/api/admin/members?${params.toString()}`)
      if (!res.ok) throw new Error("Failed to fetch members")
      const data = (await res.json()) as MembersResponse
      setMembers(data.members)
      setTotal(data.total)
      setTotalPages(data.totalPages)
    } catch {
      setError("Failed to load members")
    } finally {
      setLoading(false)
    }
  }, [buildMembersSearchParams, page, pageSize, sortBy, sortDir])

  useEffect(() => {
    void fetchMembers()
  }, [fetchMembers])

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
    setSelectedIds((current) =>
      current.size === members.length ? new Set() : new Set(members.map((member) => member.id))
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
    setBulkAction(action)
    setBulkDialogOpen(true)
  }

  const handleRefreshXeroGroups = () => {
    setError("")
    void refreshXeroGroups()
  }

  const handleEditMember = (member: Member) => {
    router.push(buildHrefWithReturnTo(`/admin/members/${member.id}?edit=true`, membersListPath))
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

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Members</h1>
          <p className="mt-1 text-sm text-slate-500">
            {total} member{total !== 1 ? "s" : ""}
            {debouncedSearch ? ` matching "${debouncedSearch}"` : " total"}
          </p>
        </div>
        <div className="flex flex-col items-start gap-1.5">
          <div className="flex gap-2">
            {xeroConnected && (
              <ViewOnlyActionButton
                canEdit={canEditMembership}
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
              variant="outline"
              size="sm"
              onClick={() => setImportDialogOpen(true)}
            >
              <Upload className="h-4 w-4 mr-1" />
              Import CSV
            </ViewOnlyActionButton>
            <ViewOnlyActionButton
              canEdit={canEditMembership}
              onClick={() => setCreateDialogOpen(true)}
            >
              Add Member
            </ViewOnlyActionButton>
          </div>
          {xeroConnected && (
            <XeroGroupsRefreshHint lastRefreshedAt={xeroGroupsLastRefreshedAt} />
          )}
        </div>
      </div>

      {!canEditMembership && (
        <AdminViewOnlyNotice>
          Your admin role can view membership records but cannot create, edit,
          import, or bulk-update members.
        </AdminViewOnlyNotice>
      )}

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
        activeFilterCount={activeFilterCount}
        xeroFeatures={xeroFeatures}
        xeroContactGroupsList={xeroContactGroupsList}
        onSearchChange={setSearch}
        onSetFilter={setFilter}
        onClearFilters={clearFilters}
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

      <Card>
        <CardHeader className="pb-0">
          <CardTitle className="text-base font-medium">Member List</CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          <MemberTable
            members={members}
            loading={loading}
            debouncedSearch={debouncedSearch}
            selectedIds={selectedIds}
            canEdit={canEditMembership}
            sortBy={sortBy}
            sortDir={sortDir}
            membersListPath={membersListPath}
            onToggleSelect={toggleSelect}
            onToggleSelectAll={toggleSelectAll}
            onToggleSort={toggleSort}
            onOpenPasswordActionDialog={openPasswordActionDialog}
            onEditMember={handleEditMember}
          />
          <MemberPagination
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
          />
        </CardContent>
      </Card>

      <MemberEditorDialog
        open={createDialogOpen}
        actorIsFullAdmin={actorIsFullAdmin}
        xeroConnected={xeroConnected}
        onOpenChange={setCreateDialogOpen}
        onSaved={() => void fetchMembers()}
        onSuccess={showSuccess}
        onWarning={showWarning}
      />
      <MemberBulkDialog
        open={bulkDialogOpen}
        action={bulkAction}
        selectedIds={selectedIds}
        onOpenChange={setBulkDialogOpen}
        onUpdated={handleBulkUpdated}
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
  )
}
