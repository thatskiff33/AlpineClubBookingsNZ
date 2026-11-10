"use client"

import { useEffect, useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { useConfirm } from "@/components/confirm-dialog"
import { AdminDataTable } from "@/components/admin/admin-data-table"
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action"
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access"
import { AGE_UNAVAILABLE_LABEL } from "@/lib/member-age"
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

interface SuggestedMember {
  id: string
  firstName: string
  lastName: string
  email: string
  ageTier: string
  canLogin: boolean
  xeroContactId: string | null
  /**
   * #2568: calculated server-side, never a date of birth. This screen binds
   * specific member records into a new family group off nothing more than a
   * shared surname or a shared mailbox, so the age is what tells a parent from
   * an adult child before the group is created.
   */
  ageLabel?: string | null
}

interface Suggestion {
  signature: string
  suggestedName: string
  reason: string
  score: number
  members: SuggestedMember[]
}

interface SuggestionsData {
  suggestions: Suggestion[]
  ungroupedCount: number
  totalMembers: number
  hiddenCount: number
}

/**
 * The Suggestions tab of Family Groups (S1 #4796), which was its own page at
 * `/admin/family-suggestions` until the owner approved merging the two on
 * #4468. Same area (`membership`) and the same gating as the page had: it
 * mounts only while its tab is open, and a view-only membership admin browses
 * but cannot create, hide or reset.
 */
export function FamilySuggestionsPanel() {
  // Create-group / hide / reset-hidden all POST membership-area
  // family-suggestions routes; a view-only membership admin browses the
  // suggestions but cannot act (#1997).
  const canEdit = useAdminAreaEditAccess("membership")
  const [data, setData] = useState<SuggestionsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [creating, setCreating] = useState<string | null>(null)
  const [hiding, setHiding] = useState<string | null>(null)
  const [resetting, setResetting] = useState(false)
  const [editNames, setEditNames] = useState<Record<string, string>>({})
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [created, setCreated] = useState<Set<string>>(new Set())
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const { confirm, confirmDialog } = useConfirm()

  const fetchSuggestions = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const res = await fetch("/api/admin/family-suggestions")
      if (!res.ok) throw new Error("Failed to fetch suggestions")
      const json = await res.json()
      setData(json)
      setDismissed(new Set())
      setCreated(new Set())
      setHidden(new Set())
      setEditNames({})
    } catch {
      setError("Failed to load suggestions")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSuggestions()
  }, [fetchSuggestions])

  async function handleCreate(suggestion: Suggestion) {
    if (!canEdit) return
    const name = editNames[suggestion.signature] ?? suggestion.suggestedName
    const memberIds = suggestion.members.map((m) => m.id)

    setCreating(name)
    try {
      const res = await fetch("/api/admin/family-suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, memberIds }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || "Failed to create group")
      setCreated((prev) => new Set(prev).add(suggestion.signature))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create group")
    } finally {
      setCreating(null)
    }
  }

  async function handleHide(suggestion: Suggestion) {
    if (!canEdit) return
    const memberIds = suggestion.members.map((m) => m.id)

    setHiding(suggestion.signature)
    setError("")
    try {
      const res = await fetch("/api/admin/family-suggestions/hide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberIds }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || "Failed to hide suggestion")
      setHidden((prev) => new Set(prev).add(suggestion.signature))
      setData((prev) =>
        prev ? { ...prev, hiddenCount: prev.hiddenCount + 1 } : prev
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to hide suggestion")
    } finally {
      setHiding(null)
    }
  }

  async function handleResetHidden() {
    if (!canEdit || !data?.hiddenCount) return
    const confirmed = await confirm({
      title: "Reset hidden family suggestions?",
      description:
        "This will restore every permanently hidden family suggestion for all admins.",
      confirmLabel: "Reset hidden",
      destructive: true,
    })
    if (!confirmed) return

    setResetting(true)
    setError("")
    try {
      const res = await fetch("/api/admin/family-suggestions/reset", {
        method: "POST",
      })
      const json = await res.json()
      if (!res.ok) {
        throw new Error(json.error || "Failed to reset hidden suggestions")
      }
      await fetchSuggestions()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset hidden suggestions")
    } finally {
      setResetting(false)
    }
  }

  const activeSuggestions = data?.suggestions.filter(
    (suggestion) =>
      !dismissed.has(suggestion.signature) &&
      !created.has(suggestion.signature) &&
      !hidden.has(suggestion.signature)
  ) ?? []

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
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view family group suggestions but cannot create,
      hide, or reset them.
    </AdminViewOnlySectionBanner>
  )

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6">
      {confirmDialog}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h2 className="text-lg font-semibold text-foreground">
            Family Group Suggestions
          </h2>
          <p className="text-sm text-muted-foreground">
            Review suggested family groups based on shared emails and last names among ungrouped members.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
          <ViewOnlyActionButton
            canEdit={canEdit}
            describeReason={false}
            onClick={handleResetHidden}
            disabled={loading || resetting || !data?.hiddenCount}
            variant="outline"
          >
            {resetting ? "Resetting..." : `Reset hidden (${data?.hiddenCount ?? 0})`}
          </ViewOnlyActionButton>
          <Button onClick={fetchSuggestions} disabled={loading} variant="outline">
            {loading ? "Loading..." : "Refresh"}
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-danger/20 bg-danger-muted p-3 text-sm text-danger">
          {error}
        </div>
      )}

      {data && (
        <div className="grid grid-cols-3 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Total Members</CardDescription>
              <CardTitle className="text-2xl">{data.totalMembers}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Ungrouped Members</CardDescription>
              <CardTitle className="text-2xl">{data.ungroupedCount}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Suggestions</CardDescription>
              <CardTitle className="text-2xl">{activeSuggestions.length}</CardTitle>
            </CardHeader>
          </Card>
        </div>
      )}

      {loading && !data && (
        <div className="text-center py-12 text-muted-foreground">Loading suggestions...</div>
      )}

      {data && activeSuggestions.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No suggestions found. All members are already in family groups, or there are no patterns to suggest.
          </CardContent>
        </Card>
      )}

      {data?.suggestions.map((suggestion) => {
        if (
          dismissed.has(suggestion.signature) ||
          hidden.has(suggestion.signature)
        ) return null
        if (created.has(suggestion.signature)) {
          return (
            <Card key={suggestion.signature} className="border-success/20 bg-success-muted">
              <CardContent className="py-4 text-center text-success">
                Family group &ldquo;{editNames[suggestion.signature] ?? suggestion.suggestedName}&rdquo; created successfully.
              </CardContent>
            </Card>
          )
        }

        return (
          <Card key={suggestion.signature}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Input
                    value={editNames[suggestion.signature] ?? suggestion.suggestedName}
                    onChange={(e) =>
                      setEditNames((prev) => ({
                        ...prev,
                        [suggestion.signature]: e.target.value,
                      }))
                    }
                    className="font-semibold text-lg w-64"
                  />
                  <Badge variant={suggestion.score >= 10 ? "default" : "secondary"}>
                    {suggestion.score >= 10 ? "High confidence" : "Medium confidence"}
                  </Badge>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setDismissed((prev) =>
                        new Set(prev).add(suggestion.signature)
                      )
                    }
                  >
                    Skip
                  </Button>
                  <ViewOnlyActionButton
                    canEdit={canEdit}
                    describeReason={false}
                    size="sm"
                    variant="outline"
                    onClick={() => handleHide(suggestion)}
                    disabled={hiding !== null}
                  >
                    {hiding === suggestion.signature ? "Hiding..." : "Permanently Hide"}
                  </ViewOnlyActionButton>
                  <ViewOnlyActionButton
                    canEdit={canEdit}
                    describeReason={false}
                    size="sm"
                    onClick={() => handleCreate(suggestion)}
                    disabled={creating !== null}
                  >
                    {creating === (editNames[suggestion.signature] ?? suggestion.suggestedName) ? "Creating..." : "Create Group"}
                  </ViewOnlyActionButton>
                </div>
              </div>
              <CardDescription>{suggestion.reason}</CardDescription>
            </CardHeader>
            <CardContent>
              <AdminDataTable showDensityToggle={false}>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    {/* #2568 */}
                    <TableHead>Age</TableHead>
                    <TableHead>Age Tier</TableHead>
                    <TableHead>Can Login</TableHead>
                    <TableHead>Xero</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {suggestion.members.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell className="break-words">{m.firstName} {m.lastName}</TableCell>
                      <TableCell className="break-words text-muted-foreground">{m.email}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {m.ageLabel ?? AGE_UNAVAILABLE_LABEL}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">{m.ageTier}</Badge>
                      </TableCell>
                      <TableCell>
                        {m.canLogin
                          ? <Badge className="bg-success-muted text-success text-xs">Yes</Badge>
                          : <Badge variant="secondary" className="text-xs">No</Badge>}
                      </TableCell>
                      <TableCell>
                        {m.xeroContactId
                          ? <Badge className="bg-info-muted text-info text-xs">Linked</Badge>
                          : <span className="text-muted-foreground text-xs">-</span>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </AdminDataTable>
            </CardContent>
          </Card>
        )
      })}
      </div>
    </div>
  )
}
