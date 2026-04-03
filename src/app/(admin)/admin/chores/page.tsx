"use client"

import { useEffect, useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"

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
  active: boolean
}

const AGE_RESTRICTION_LABELS: Record<string, string> = {
  ANY: "Any age",
  ADULTS_ONLY: "Adults only (18+)",
  MIXED_PREFERRED: "Mixed (adult + child preferred)",
  ADULT_SUPERVISED: "Adult supervised",
}

export default function ChoresPage() {
  const [chores, setChores] = useState<ChoreTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

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
  const [active, setActive] = useState(true)

  const fetchChores = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/chores")
      if (!res.ok) throw new Error("Failed to fetch chores")
      const data = await res.json()
      setChores(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchChores()
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
    setActive(true)
    setEditingId(null)
    setShowForm(false)
    setError("")
  }

  function startEdit(chore: ChoreTemplate) {
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
    setActive(chore.active)
    setShowForm(true)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
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
      active,
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
        const data = await res.json()
        throw new Error(data.error || "Failed to save")
      }
      resetForm()
      fetchChores()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Are you sure you want to delete this chore template?")) return
    try {
      const res = await fetch(`/api/admin/chores/${id}`, { method: "DELETE" })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Failed to delete")
      }
      fetchChores()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    }
  }

  async function handleToggleActive(chore: ChoreTemplate) {
    try {
      const res = await fetch(`/api/admin/chores/${chore.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !chore.active }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Failed to update")
      }
      fetchChores()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    }
  }

  if (loading) {
    return <div className="text-center py-8">Loading chore templates...</div>
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Chore Templates</h1>
          <p className="text-muted-foreground mt-1">
            Configure chore definitions for the lodge roster
          </p>
        </div>
        {!showForm && (
          <Button onClick={() => { setSortOrder(chores.length + 1); setShowForm(true) }}>
            Add Chore
          </Button>
        )}
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-md">
          {error}
        </div>
      )}

      {showForm && (
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
                    placeholder="e.g. Breakfast dishes"
                    required
                  />
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
                    placeholder="e.g. Only required for full lodge"
                  />
                </div>
              </div>

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
                <Button type="submit" disabled={saving}>
                  {saving ? "Saving..." : editingId ? "Update Chore" : "Create Chore"}
                </Button>
                <Button type="button" variant="outline" onClick={resetForm}>
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {chores.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No chore templates configured yet. Click &quot;Add Chore&quot; to get started.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>People</TableHead>
                  <TableHead>Age Rule</TableHead>
                  <TableHead>Essential</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {chores.map((chore) => (
                  <TableRow key={chore.id} className={!chore.active ? "opacity-50" : ""}>
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
                        <Button variant="outline" size="sm" onClick={() => handleToggleActive(chore)}>
                          {chore.active ? "Deactivate" : "Activate"}
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => startEdit(chore)}>
                          Edit
                        </Button>
                        <Button variant="destructive" size="sm" onClick={() => handleDelete(chore.id)}>
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
