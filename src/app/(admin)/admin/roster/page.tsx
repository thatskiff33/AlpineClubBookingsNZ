"use client"

import { useEffect, useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

interface Guest {
  id: string
  bookingId: string
  firstName: string
  lastName: string
  ageTier: "ADULT" | "YOUTH" | "CHILD"
}

interface Assignment {
  id: string
  choreTemplateId: string
  choreTemplateName: string
  choreDescription: string | null
  choreSortOrder: number
  bookingGuestId: string | null
  guestName: string | null
  guestAgeTier: string | null
  bookingId: string
  status: "SUGGESTED" | "CONFIRMED" | "COMPLETED"
}

interface ChoreTemplate {
  id: string
  name: string
  description: string | null
  recommendedPeopleMin: number
  recommendedPeopleMax: number
  isEssential: boolean
  ageRestriction: string
  conditionalNote: string | null
  minAge: number
  sortOrder: number
  active: boolean
}

interface RosterData {
  date: string
  guests: Guest[]
  assignments: Assignment[]
  templates: ChoreTemplate[]
  guestHistory: Record<string, Array<{ date: string; choreName: string }>>
  guestCount: number
}

const AGE_TIER_COLORS: Record<string, string> = {
  ADULT: "bg-blue-100 text-blue-800",
  YOUTH: "bg-green-100 text-green-800",
  CHILD: "bg-orange-100 text-orange-800",
}

function formatDateForInput(d: Date): string {
  return d.toISOString().split("T")[0]
}

export default function RosterPage() {
  const [selectedDate, setSelectedDate] = useState(formatDateForInput(new Date()))
  const [roster, setRoster] = useState<RosterData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)
  const [includeNonEssential, setIncludeNonEssential] = useState<boolean | null>(null)
  const [sendingEmail, setSendingEmail] = useState(false)

  const fetchRoster = useCallback(async (date: string, regenerate = false) => {
    setLoading(true)
    setError("")
    try {
      let url = `/api/admin/roster/${date}?`
      if (regenerate) url += "regenerate=true&"
      if (includeNonEssential !== null) url += `includeNonEssential=${includeNonEssential}`
      const res = await fetch(url)
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Failed to fetch roster")
      }
      const data: RosterData = await res.json()
      setRoster(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setLoading(false)
    }
  }, [includeNonEssential])

  useEffect(() => {
    if (selectedDate) {
      fetchRoster(selectedDate)
    }
  }, [selectedDate, fetchRoster])

  async function handleReassign(assignmentId: string, bookingGuestId: string) {
    setSaving(true)
    try {
      const res = await fetch(`/api/admin/roster/${selectedDate}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reassign", assignmentId, bookingGuestId }),
      })
      if (!res.ok) throw new Error("Failed to reassign")
      fetchRoster(selectedDate)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setSaving(false)
    }
  }

  async function handleRemove(assignmentId: string) {
    setSaving(true)
    try {
      const res = await fetch(`/api/admin/roster/${selectedDate}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove", assignmentId }),
      })
      if (!res.ok) throw new Error("Failed to remove")
      fetchRoster(selectedDate)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setSaving(false)
    }
  }

  async function handleAddAssignment(choreTemplateId: string) {
    if (!roster || roster.guests.length === 0) return
    const guest = roster.guests[0]
    setSaving(true)
    try {
      const res = await fetch(`/api/admin/roster/${selectedDate}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add",
          choreTemplateId,
          bookingGuestId: guest.id,
          bookingId: guest.bookingId,
        }),
      })
      if (!res.ok) throw new Error("Failed to add")
      fetchRoster(selectedDate)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setSaving(false)
    }
  }

  async function handleConfirm() {
    if (!confirm("Confirm all suggested assignments? This marks them as final.")) return
    setSaving(true)
    try {
      const res = await fetch(`/api/admin/roster/${selectedDate}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "confirm" }),
      })
      if (!res.ok) throw new Error("Failed to confirm")
      fetchRoster(selectedDate)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setSaving(false)
    }
  }

  async function handleSendEmail() {
    if (!confirm("Send chore roster email to all guests for this date?")) return
    setSendingEmail(true)
    try {
      const res = await fetch(`/api/admin/roster/${selectedDate}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "email" }),
      })
      if (!res.ok) throw new Error("Failed to send emails")
      alert("Roster emails sent successfully!")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setSendingEmail(false)
    }
  }

  // Group assignments by chore template
  const assignmentsByChore = new Map<string, Assignment[]>()
  if (roster) {
    for (const a of roster.assignments) {
      if (!assignmentsByChore.has(a.choreTemplateId)) {
        assignmentsByChore.set(a.choreTemplateId, [])
      }
      assignmentsByChore.get(a.choreTemplateId)!.push(a)
    }
  }

  // Get chores that have assignments, sorted by sortOrder
  const choreIds = [...assignmentsByChore.keys()]
  const assignedChores = roster
    ? choreIds
        .map((id) => roster.templates.find((t) => t.id === id) ?? null)
        .filter((t): t is ChoreTemplate => t !== null)
        .sort((a, b) => a.sortOrder - b.sortOrder)
    : []

  // Chores with no assignments (for "add" button)
  const unassignedChores = roster
    ? roster.templates.filter((t) => !assignmentsByChore.has(t.id))
    : []

  const hasAnySuggested = roster?.assignments.some((a) => a.status === "SUGGESTED") ?? false
  const isConfirmed = roster?.assignments.length
    ? roster.assignments.every((a) => a.status === "CONFIRMED" || a.status === "COMPLETED")
    : false

  function getGuestHistoryDisplay(guestId: string): string {
    if (!roster?.guestHistory[guestId]) return ""
    return roster.guestHistory[guestId]
      .map((h) => {
        const d = new Date(h.date)
        const dayDiff = Math.round(
          (new Date(selectedDate).getTime() - d.getTime()) / (1000 * 60 * 60 * 24)
        )
        return `Day -${dayDiff}: ${h.choreName}`
      })
      .join(", ")
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Chore Roster</h1>
          <p className="text-muted-foreground mt-1">
            Review and manage daily chore assignments
          </p>
        </div>
        <div className="flex items-center space-x-3">
          <a
            href={`/admin/roster/${selectedDate}/print`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Button variant="outline">Print Roster</Button>
          </a>
        </div>
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-md">
          {error}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Select Date</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-2">
              <Label htmlFor="date">Date</Label>
              <Input
                id="date"
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
              />
            </div>
            <div className="flex items-center space-x-2">
              <input
                type="checkbox"
                id="includeNonEssential"
                checked={includeNonEssential ?? false}
                onChange={(e) =>
                  setIncludeNonEssential(e.target.checked ? true : null)
                }
                className="rounded border-input"
              />
              <Label htmlFor="includeNonEssential">Include non-essential chores</Label>
            </div>
            <Button
              variant="outline"
              onClick={() => fetchRoster(selectedDate, true)}
              disabled={loading}
            >
              Regenerate Roster
            </Button>
          </div>
        </CardContent>
      </Card>

      {loading && <div className="text-center py-8">Loading roster...</div>}

      {roster && !loading && (
        <>
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>
                    Roster for {new Date(selectedDate + "T00:00:00").toLocaleDateString("en-NZ", {
                      weekday: "long",
                      year: "numeric",
                      month: "long",
                      day: "numeric",
                    })}
                  </CardTitle>
                  <CardDescription>
                    {roster.guestCount} guest{roster.guestCount !== 1 ? "s" : ""} staying
                    {roster.guestCount >= 20 ? " (high occupancy)" : " (low occupancy)"}
                    {" · "}
                    {roster.assignments.length} assignment{roster.assignments.length !== 1 ? "s" : ""}
                  </CardDescription>
                </div>
                <div className="flex items-center space-x-2">
                  {hasAnySuggested && (
                    <Button onClick={handleConfirm} disabled={saving}>
                      Confirm Roster
                    </Button>
                  )}
                  {isConfirmed && roster.assignments.length > 0 && (
                    <Button variant="outline" onClick={handleSendEmail} disabled={sendingEmail}>
                      {sendingEmail ? "Sending..." : "Email Roster to Guests"}
                    </Button>
                  )}
                </div>
              </div>
            </CardHeader>
          </Card>

          {roster.guests.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                No confirmed guests staying on this date.
              </CardContent>
            </Card>
          ) : roster.assignments.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                No chore assignments for this date. Click &quot;Regenerate Roster&quot; to auto-suggest.
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {assignedChores.map((template) => {
                const assignments = assignmentsByChore.get(template.id) ?? []
                return (
                  <Card key={template.id}>
                    <CardHeader className="pb-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-3">
                          <span className="text-lg font-mono text-muted-foreground">
                            {template.sortOrder}.
                          </span>
                          <CardTitle className="text-lg">{template.name}</CardTitle>
                          {!template.isEssential && (
                            <Badge variant="outline">Optional</Badge>
                          )}
                          {template.conditionalNote && (
                            <span className="text-xs text-muted-foreground italic">
                              {template.conditionalNote}
                            </span>
                          )}
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleAddAssignment(template.id)}
                          disabled={saving}
                        >
                          + Add Person
                        </Button>
                      </div>
                      {template.description && (
                        <CardDescription className="ml-10">
                          {template.description}
                        </CardDescription>
                      )}
                    </CardHeader>
                    <CardContent className="pt-0">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Guest</TableHead>
                            <TableHead>Age Tier</TableHead>
                            <TableHead>Recent History (4 days)</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="text-right">Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {assignments.map((a) => (
                            <TableRow key={a.id}>
                              <TableCell>
                                <select
                                  value={a.bookingGuestId ?? ""}
                                  onChange={(e) => {
                                    if (e.target.value) handleReassign(a.id, e.target.value)
                                  }}
                                  disabled={saving || a.status === "CONFIRMED"}
                                  className="flex h-8 w-full max-w-[200px] rounded-md border border-input bg-transparent px-2 py-1 text-sm"
                                >
                                  <option value="">Unassigned</option>
                                  {roster.guests.map((g) => (
                                    <option key={g.id} value={g.id}>
                                      {g.firstName} {g.lastName}
                                    </option>
                                  ))}
                                </select>
                              </TableCell>
                              <TableCell>
                                {a.guestAgeTier && (
                                  <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${AGE_TIER_COLORS[a.guestAgeTier] ?? ""}`}>
                                    {a.guestAgeTier}
                                  </span>
                                )}
                              </TableCell>
                              <TableCell>
                                {a.bookingGuestId && (
                                  <span className="text-xs text-muted-foreground">
                                    {getGuestHistoryDisplay(a.bookingGuestId) || "No recent history"}
                                  </span>
                                )}
                              </TableCell>
                              <TableCell>
                                <Badge
                                  variant={
                                    a.status === "CONFIRMED"
                                      ? "default"
                                      : a.status === "COMPLETED"
                                      ? "secondary"
                                      : "outline"
                                  }
                                >
                                  {a.status}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-right">
                                {a.status === "SUGGESTED" && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleRemove(a.id)}
                                    disabled={saving}
                                  >
                                    Remove
                                  </Button>
                                )}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </CardContent>
                  </Card>
                )
              })}

              {/* Unassigned chores */}
              {unassignedChores.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Unrostered Chores</CardTitle>
                    <CardDescription>
                      These chores have no assignments for this date. Click to add.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="flex flex-wrap gap-2">
                      {unassignedChores.map((t) => (
                        <Button
                          key={t.id}
                          variant="outline"
                          size="sm"
                          onClick={() => handleAddAssignment(t.id)}
                          disabled={saving || roster.guests.length === 0}
                        >
                          + {t.name}
                          {!t.isEssential && (
                            <span className="text-xs ml-1 opacity-60">(optional)</span>
                          )}
                        </Button>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
