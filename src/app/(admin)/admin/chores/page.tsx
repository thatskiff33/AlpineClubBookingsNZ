"use client"

import { useEffect, useLayoutEffect, useState, useCallback, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { FieldHint, useFieldHint } from "@/components/ui/field-hint"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import {
  LodgeSelect,
  initialLodgeIdFromLocation,
  useLodgeOptions,
} from "@/components/lodge-select"
import { LodgeScopeStatusNotice } from "@/components/admin/lodge-options-status"
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access"
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action"
import { deriveSettledLodgeOptionScope } from "@/lib/lodge-option-scope"

interface ChoreTemplate {
  id: string
  name: string
  description: string | null
  recommendedPeopleMin: number
  recommendedPeopleMax: number
  isEssential: boolean
  ageRestriction: "ANY" | "ADULTS_ONLY" | "MIXED_PREFERRED" | "ADULT_SUPERVISED"
  conditionalNote: string | null
  minAge: number
  sortOrder: number
  timeOfDay: "MORNING" | "EVENING" | "ANYTIME"
  frequencyMode: "DAILY" | "EVERY_X_DAYS" | "SPECIFIC_DAYS"
  frequencyDays: number | null
  frequencyDaysOfWeek: number[]
  active: boolean
}

const AGE_RESTRICTION_LABELS: Record<string, string> = {
  ANY: "Any age",
  ADULTS_ONLY: "Adults only (18+)",
  MIXED_PREFERRED: "Mixed (adult + child preferred)",
  ADULT_SUPERVISED: "Adult supervised",
}

const TIME_OF_DAY_LABELS: Record<string, string> = {
  MORNING: "Morning",
  EVENING: "Evening",
  ANYTIME: "Anytime",
}

const FREQUENCY_MODE_LABELS: Record<string, string> = {
  DAILY: "Daily",
  EVERY_X_DAYS: "Every X days",
  SPECIFIC_DAYS: "Specific days of week",
}

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

export default function ChoresPage() {
  // Chore templates are lodge config; the write routes enforce lodge:edit, so a
  // lodge:view admin sees this screen read-only (#1940).
  const canEdit = useAdminAreaEditAccess("lodge")
  const [chores, setChores] = useState<ChoreTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // Lodge context for the page; LodgeSelect renders nothing (and reports the
  // sole lodge) while fewer than two lodges exist (ADR-002).
  const {
    lodges,
    loading: lodgesLoading,
    failed: lodgeOptionsFailed,
    forbidden: lodgeOptionsForbidden,
    reload: reloadLodgeOptions,
  } = useLodgeOptions("admin")
  // Hub links (ADR-003) land pre-filtered; read synchronously so the first
  // fetch is already lodge-filtered.
  const [lodgeId, setLodgeId] = useState<string | null>(initialLodgeIdFromLocation)
  /*
    #2701: a FAILED lodge list is not "a club with no lodges", but until now the
    two were the same empty array here. LodgeSelect renders nothing below two
    options (ADR-002) and normalises the selection to null, and an omitted
    lodgeId is resolved server-side to the club's DEFAULT lodge — so carrying on
    would read and (worse) write chore templates against a lodge nobody chose
    and nothing on screen names. While that is true this page does no
    lodge-scoped work at all.

    A `?lodgeId=` hub link is retained through failure/retry, but remains inert
    until a successful lodge response validates that id.
  */
  const lodgeScope = deriveSettledLodgeOptionScope({
    lodges,
    selectedLodgeId: lodgeId,
    loading: lodgesLoading,
    failed: lodgeOptionsFailed,
    forbidden: lodgeOptionsForbidden,
  })
  const scopedLodgeId = lodgeScope.kind === "lodge" ? lodgeScope.lodgeId : null
  const activeScopeRef = useRef<string | null>(scopedLodgeId)
  /*
    #2887: ownership follows the COMMIT, not the render, and this must stay a
    LAYOUT effect - a passive one is flushed after paint, leaving a window in
    which a late lodge-A response still reads A as current. Full reasoning and
    both mutation proofs live in one place:
    `src/lib/__tests__/lodge-scope-committed-ownership.test.tsx`.
  */
  useLayoutEffect(() => {
    activeScopeRef.current = scopedLodgeId
  }, [scopedLodgeId])
  const lodgeScopeReady = scopedLodgeId !== null

  // Form state
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [recommendedPeopleMin, setRecommendedPeopleMin] = useState(1)
  const [recommendedPeopleMax, setRecommendedPeopleMax] = useState(2)
  const [isEssential, setIsEssential] = useState(false)
  const [ageRestriction, setAgeRestriction] = useState<ChoreTemplate["ageRestriction"]>("ANY")
  const [conditionalNote, setConditionalNote] = useState("")
  const [minAge, setMinAge] = useState(0)
  const [sortOrder, setSortOrder] = useState(0)
  const [timeOfDay, setTimeOfDay] = useState<ChoreTemplate["timeOfDay"]>("ANYTIME")
  const [frequencyMode, setFrequencyMode] = useState<ChoreTemplate["frequencyMode"]>("DAILY")
  const [frequencyDays, setFrequencyDays] = useState<number | null>(null)
  const [frequencyDaysOfWeek, setFrequencyDaysOfWeek] = useState<number[]>([])
  const [active, setActive] = useState(true)

  // #2257 — examples live UNDER the field, not inside it as grey pseudo-content.
  const nameHint = useFieldHint()
  const conditionalNoteHint = useFieldHint()

  const fetchChores = useCallback(async (signal?: AbortSignal) => {
    // #2701: no lodge, no read. Whatever is already on screen came from the
    // unscoped request this effect fired before the lodge list failed, so drop
    // it too rather than leave another lodge's templates sitting under a
    // heading that claims to be this lodge's.
    if (!scopedLodgeId) {
      setChores([])
      setShowForm(false)
      setEditingId(null)
      setError("")
      setLoading(false)
      return
    }
    try {
      const res = await fetch(
        `/api/admin/chores?lodgeId=${encodeURIComponent(scopedLodgeId)}`,
        { signal }
      )
      if (!res.ok) throw new Error("Failed to fetch chores")
      const data = await res.json()
      setChores(data)
    } catch (err) {
      // An aborted request means the lodge changed (or the page unmounted);
      // a newer request owns the list now.
      if (err instanceof DOMException && err.name === "AbortError") return
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setLoading(false)
    }
  }, [scopedLodgeId])

  useEffect(() => {
    const controller = new AbortController()
    fetchChores(controller.signal)
    return () => controller.abort()
  }, [fetchChores])

  function resetForm() {
    setName("")
    setDescription("")
    setRecommendedPeopleMin(1)
    setRecommendedPeopleMax(2)
    setIsEssential(false)
    setAgeRestriction("ANY")
    setConditionalNote("")
    setMinAge(0)
    setSortOrder(0)
    setTimeOfDay("ANYTIME")
    setFrequencyMode("DAILY")
    setFrequencyDays(null)
    setFrequencyDaysOfWeek([])
    setActive(true)
    setEditingId(null)
    setShowForm(false)
    setError("")
  }

  function handleLodgeChange(nextLodgeId: string | null) {
    activeScopeRef.current = nextLodgeId
    setLodgeId(nextLodgeId)
    setChores([])
    setLoading(true)
    resetForm()
  }

  function startEdit(chore: ChoreTemplate) {
    if (!lodgeScopeReady) return
    setEditingId(chore.id)
    setName(chore.name)
    setDescription(chore.description ?? "")
    setRecommendedPeopleMin(chore.recommendedPeopleMin)
    setRecommendedPeopleMax(chore.recommendedPeopleMax)
    setIsEssential(chore.isEssential)
    setAgeRestriction(chore.ageRestriction)
    setConditionalNote(chore.conditionalNote ?? "")
    setMinAge(chore.minAge)
    setSortOrder(chore.sortOrder)
    setTimeOfDay(chore.timeOfDay)
    setFrequencyMode(chore.frequencyMode)
    setFrequencyDays(chore.frequencyDays)
    setFrequencyDaysOfWeek(chore.frequencyDaysOfWeek)
    setActive(chore.active)
    setShowForm(true)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!scopedLodgeId) return
    const requestedScope = scopedLodgeId
    setSaving(true)
    setError("")

    const payload = {
      name,
      description: description || undefined,
      recommendedPeopleMin,
      recommendedPeopleMax,
      isEssential,
      ageRestriction,
      conditionalNote: conditionalNote || null,
      minAge,
      sortOrder,
      timeOfDay,
      frequencyMode,
      frequencyDays: frequencyMode === "EVERY_X_DAYS" ? frequencyDays : null,
      frequencyDaysOfWeek: frequencyMode === "SPECIFIC_DAYS" ? frequencyDaysOfWeek : [],
      active,
      // Lodge is set at creation from the page's lodge context and cannot be
      // changed by an update.
      ...(editingId ? {} : { lodgeId: scopedLodgeId }),
    }

    try {
      const url = editingId ? `/api/admin/chores/${editingId}` : "/api/admin/chores"
      const method = editingId ? "PUT" : "POST"
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        if (res.status === 403) {
          setError(ADMIN_FORBIDDEN_SAVE_REASON)
          return
        }
        const data = await res.json()
        throw new Error(data.error || "Failed to save")
      }
      if (activeScopeRef.current !== requestedScope) return
      resetForm()
      fetchChores()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    if (!lodgeScopeReady) return
    const requestedScope = scopedLodgeId
    if (!confirm("Are you sure you want to delete this chore template?")) return
    try {
      const res = await fetch(`/api/admin/chores/${id}`, { method: "DELETE" })
      if (!res.ok) {
        if (res.status === 403) {
          setError(ADMIN_FORBIDDEN_SAVE_REASON)
          return
        }
        const data = await res.json()
        throw new Error(data.error || "Failed to delete")
      }
      if (activeScopeRef.current !== requestedScope) return
      fetchChores()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    }
  }

  async function handleToggleActive(chore: ChoreTemplate) {
    if (!lodgeScopeReady) return
    const requestedScope = scopedLodgeId
    try {
      const res = await fetch(`/api/admin/chores/${chore.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !chore.active }),
      })
      if (!res.ok) {
        if (res.status === 403) {
          setError(ADMIN_FORBIDDEN_SAVE_REASON)
          return
        }
        const data = await res.json()
        throw new Error(data.error || "Failed to update")
      }
      if (activeScopeRef.current !== requestedScope) return
      fetchChores()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    }
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
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view chore templates but cannot change them. Lodge
      edit access is required.
    </AdminViewOnlySectionBanner>
  )

  if (loading && lodgeScopeReady) {
    return (
      <div>
        {viewOnlyBanner}
        <div className="text-center py-8">Loading chore templates...</div>
      </div>
    )
  }

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Chore Templates</h1>
          <p className="text-muted-foreground mt-1">
            Configure chore definitions for the lodge roster
          </p>
        </div>
        {lodgeScopeReady && !showForm && (
          // #2701: creating a template with no lodge resolved would file it
          // against the club's default lodge.
          <ViewOnlyActionButton canEdit={canEdit} describeReason={false} onClick={() => { setSortOrder(chores.length + 1); setShowForm(true) }}>
            Add Chore
          </ViewOnlyActionButton>
        )}
      </div>

      {/* #2701: say the lodge list failed, above the lodge-scoped content it
          silently replaced with the default lodge's. */}
      <LodgeScopeStatusNotice
        scope={lodgeScope}
        onRetry={reloadLodgeOptions}
        what="chore templates"
      />

      <div className="max-w-xs">
        <LodgeSelect lodges={lodges} value={lodgeId} onChange={handleLodgeChange} loading={lodgesLoading}
            // #2701: an empty list from a FAILED request is not evidence the
            // caller's lodge is gone, so the ADR-002 normaliser must not wipe a
            // ?lodgeId= hub link (ADR-003) while the outage lasts.
            deferDefaultSelection={lodgeOptionsFailed || lodgeOptionsForbidden}
          />
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-md">
          {error}
        </div>
      )}

      {lodgeScopeReady && showForm && (
        <Card>
          <CardHeader>
            <CardTitle>{editingId ? "Edit Chore" : "New Chore"}</CardTitle>
            <CardDescription>
              Configure the chore details and allocation rules
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Chore Name</Label>
                  <Input
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    {...nameHint.fieldProps}
                  />
                  <FieldHint {...nameHint.hintProps}>
                    Example: Breakfast dishes
                  </FieldHint>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="sortOrder">Sort Order</Label>
                  <Input
                    id="sortOrder"
                    type="number"
                    value={sortOrder}
                    onChange={(e) => setSortOrder(parseInt(e.target.value) || 0)}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What this chore involves..."
                  rows={2}
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="peopleMin">Min People</Label>
                  <Input
                    id="peopleMin"
                    type="number"
                    min={1}
                    value={recommendedPeopleMin}
                    onChange={(e) => setRecommendedPeopleMin(parseInt(e.target.value) || 1)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="peopleMax">Max People</Label>
                  <Input
                    id="peopleMax"
                    type="number"
                    min={1}
                    value={recommendedPeopleMax}
                    onChange={(e) => setRecommendedPeopleMax(parseInt(e.target.value) || 1)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="minAge">Minimum Age</Label>
                  <Input
                    id="minAge"
                    type="number"
                    min={0}
                    value={minAge}
                    onChange={(e) => setMinAge(parseInt(e.target.value) || 0)}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="ageRestriction">Age Restriction</Label>
                  <select
                    id="ageRestriction"
                    value={ageRestriction}
                    onChange={(e) => setAgeRestriction(e.target.value as ChoreTemplate["ageRestriction"])}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
                  >
                    {Object.entries(AGE_RESTRICTION_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="conditionalNote">Conditional Note</Label>
                  <Input
                    id="conditionalNote"
                    value={conditionalNote}
                    onChange={(e) => setConditionalNote(e.target.value)}
                    {...conditionalNoteHint.fieldProps}
                  />
                  <FieldHint {...conditionalNoteHint.hintProps}>
                    Example: Only required for full lodge
                  </FieldHint>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="timeOfDay">Time of Day</Label>
                  <select
                    id="timeOfDay"
                    value={timeOfDay}
                    onChange={(e) => setTimeOfDay(e.target.value as ChoreTemplate["timeOfDay"])}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
                  >
                    {Object.entries(TIME_OF_DAY_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="frequencyMode">Frequency</Label>
                  <select
                    id="frequencyMode"
                    value={frequencyMode}
                    onChange={(e) => setFrequencyMode(e.target.value as ChoreTemplate["frequencyMode"])}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
                  >
                    {Object.entries(FREQUENCY_MODE_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </div>
                {frequencyMode === "EVERY_X_DAYS" && (
                  <div className="space-y-2">
                    <Label htmlFor="frequencyDays">Every X Days</Label>
                    <Input
                      id="frequencyDays"
                      type="number"
                      min={2}
                      value={frequencyDays ?? 2}
                      onChange={(e) => setFrequencyDays(parseInt(e.target.value) || 2)}
                    />
                  </div>
                )}
              </div>

              {frequencyMode === "SPECIFIC_DAYS" && (
                <div className="space-y-2">
                  <Label>Days of Week</Label>
                  <div className="flex flex-wrap gap-3">
                    {DAY_LABELS.map((label, idx) => {
                      const dayNum = idx + 1
                      return (
                        <label key={dayNum} className="flex items-center space-x-1.5">
                          <input
                            type="checkbox"
                            checked={frequencyDaysOfWeek.includes(dayNum)}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setFrequencyDaysOfWeek([...frequencyDaysOfWeek, dayNum].sort())
                              } else {
                                setFrequencyDaysOfWeek(frequencyDaysOfWeek.filter((d) => d !== dayNum))
                              }
                            }}
                            className="rounded border-input"
                          />
                          <span className="text-sm">{label}</span>
                        </label>
                      )
                    })}
                  </div>
                </div>
              )}

              <div className="flex items-center space-x-6">
                <div className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    id="isEssential"
                    checked={isEssential}
                    onChange={(e) => setIsEssential(e.target.checked)}
                    className="rounded border-input"
                  />
                  <Label htmlFor="isEssential">Essential (always rostered)</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    id="active"
                    checked={active}
                    onChange={(e) => setActive(e.target.checked)}
                    className="rounded border-input"
                  />
                  <Label htmlFor="active">Active</Label>
                </div>
              </div>

              <div className="flex space-x-3">
                {/* #2701: an edit is safe (the route ignores lodgeId on
                    update), but a create with no lodge lands on the default
                    lodge — so the one button both use stays shut. */}
                <ViewOnlyActionButton canEdit={canEdit} describeReason={false} type="submit" disabled={saving || !lodgeScopeReady}>
                  {saving ? "Saving..." : editingId ? "Update Chore" : "Create Chore"}
                </ViewOnlyActionButton>
                <Button type="button" variant="outline" onClick={resetForm}>
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {!lodgeScopeReady ? null : chores.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No chore templates configured yet. Click &quot;Add Chore&quot; to get started.
          </CardContent>
        </Card>
      ) : (
        <>{(["MORNING", "EVENING", "ANYTIME"] as const).map((tod) => {
          const grouped = chores.filter((c) => c.timeOfDay === tod)
          if (grouped.length === 0) return null
          return (
            <Card key={tod}>
              <CardHeader className="pb-2">
                <CardTitle className="text-lg">{TIME_OF_DAY_LABELS[tod]} Chores</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-12">#</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>People</TableHead>
                      <TableHead>Age Rule</TableHead>
                      <TableHead>Frequency</TableHead>
                      <TableHead>Essential</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {grouped.map((chore) => (
                      <TableRow key={chore.id}>
                        <TableCell className="font-mono text-muted-foreground">
                          {chore.sortOrder}
                        </TableCell>
                        <TableCell>
                          <div>
                            <span className="font-medium">{chore.name}</span>
                            {chore.conditionalNote && (
                              <p className="text-xs text-muted-foreground mt-0.5">
                                {chore.conditionalNote}
                              </p>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          {chore.recommendedPeopleMin === chore.recommendedPeopleMax
                            ? chore.recommendedPeopleMin
                            : `${chore.recommendedPeopleMin}-${chore.recommendedPeopleMax}`}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs">
                            {AGE_RESTRICTION_LABELS[chore.ageRestriction]}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm">
                            {chore.frequencyMode === "DAILY" && "Daily"}
                            {chore.frequencyMode === "EVERY_X_DAYS" && `Every ${chore.frequencyDays}d`}
                            {chore.frequencyMode === "SPECIFIC_DAYS" && chore.frequencyDaysOfWeek.map((d) => DAY_LABELS[d - 1]).join(", ")}
                          </span>
                        </TableCell>
                        <TableCell>
                          {chore.isEssential ? (
                            <Badge>Essential</Badge>
                          ) : (
                            <span className="text-muted-foreground text-sm">Optional</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant={chore.active ? "default" : "secondary"}>
                            {chore.active ? "Active" : "Inactive"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end space-x-2">
                            <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="outline" size="sm" onClick={() => handleToggleActive(chore)}>
                              {chore.active ? "Deactivate" : "Activate"}
                            </ViewOnlyActionButton>
                            <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="outline" size="sm" onClick={() => startEdit(chore)}>
                              Edit
                            </ViewOnlyActionButton>
                            <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="destructive" size="sm" onClick={() => handleDelete(chore.id)}>
                              Delete
                            </ViewOnlyActionButton>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )
        })}</>
      )}
      </div>
    </div>
  )
}
