"use client"

import { useEffect, useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatCents } from "@/lib/pricing"

interface SeasonRate {
  id: string
  ageTier: "ADULT" | "YOUTH" | "CHILD"
  isMember: boolean
  pricePerNightCents: number
}

interface Season {
  id: string
  name: string
  type: "WINTER" | "SUMMER"
  startDate: string
  endDate: string
  active: boolean
  rates: SeasonRate[]
}

const AGE_TIERS = ["ADULT", "YOUTH", "CHILD"] as const
const RATE_LABELS: Record<string, string> = {
  "ADULT-true": "Adult Member (18+)",
  "ADULT-false": "Adult Non-Member (18+)",
  "YOUTH-true": "Youth Member (10\u201317)",
  "YOUTH-false": "Youth Non-Member (10\u201317)",
  "CHILD-true": "Child Member (under 10)",
  "CHILD-false": "Child Non-Member (under 10)",
}

function emptyRates(): Record<string, number> {
  const rates: Record<string, number> = {}
  for (const tier of AGE_TIERS) {
    for (const isMember of [true, false]) {
      rates[`${tier}-${isMember}`] = 0
    }
  }
  return rates
}

function seasonToRatesMap(rates: SeasonRate[]): Record<string, number> {
  const map: Record<string, number> = {}
  for (const rate of rates) {
    map[`${rate.ageTier}-${rate.isMember}`] = rate.pricePerNightCents
  }
  return map
}

export default function SeasonsPage() {
  const [seasons, setSeasons] = useState<Season[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  // Form state
  const [name, setName] = useState("")
  const [type, setType] = useState<"WINTER" | "SUMMER">("WINTER")
  const [startDate, setStartDate] = useState("")
  const [endDate, setEndDate] = useState("")
  const [active, setActive] = useState(true)
  const [rates, setRates] = useState<Record<string, number>>(emptyRates())
  const [saving, setSaving] = useState(false)

  const fetchSeasons = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/seasons")
      if (!res.ok) throw new Error("Failed to fetch seasons")
      const data = await res.json()
      setSeasons(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSeasons()
  }, [fetchSeasons])

  function resetForm() {
    setName("")
    setType("WINTER")
    setStartDate("")
    setEndDate("")
    setActive(true)
    setRates(emptyRates())
    setEditingId(null)
    setShowForm(false)
    setError("")
  }

  function startEdit(season: Season) {
    setEditingId(season.id)
    setName(season.name)
    setType(season.type)
    setStartDate(season.startDate.split("T")[0])
    setEndDate(season.endDate.split("T")[0])
    setActive(season.active)
    setRates(seasonToRatesMap(season.rates))
    setShowForm(true)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError("")

    const ratesArray = Object.entries(rates).map(([key, price]) => {
      const [ageTier, isMemberStr] = key.split("-")
      return {
        ageTier: ageTier as "ADULT" | "YOUTH" | "CHILD",
        isMember: isMemberStr === "true",
        pricePerNightCents: price,
      }
    })

    const payload = { name, type, startDate, endDate, active, rates: ratesArray }

    try {
      const url = editingId
        ? `/api/admin/seasons/${editingId}`
        : "/api/admin/seasons"
      const method = editingId ? "PUT" : "POST"

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Failed to save season")
      }

      resetForm()
      fetchSeasons()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Are you sure you want to delete this season?")) return

    try {
      const res = await fetch(`/api/admin/seasons/${id}`, { method: "DELETE" })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Failed to delete")
      }
      fetchSeasons()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    }
  }

  async function handleToggleActive(season: Season) {
    try {
      const res = await fetch(`/api/admin/seasons/${season.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !season.active }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Failed to update")
      }
      fetchSeasons()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    }
  }

  function handleRateChange(key: string, value: string) {
    // Convert dollar input to cents
    const dollars = parseFloat(value)
    if (isNaN(dollars)) {
      setRates((prev) => ({ ...prev, [key]: 0 }))
    } else {
      setRates((prev) => ({ ...prev, [key]: Math.round(dollars * 100) }))
    }
  }

  if (loading) {
    return <div className="text-center py-8">Loading seasons...</div>
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Hut Fees & Seasons</h1>
          <p className="text-muted-foreground mt-1">
            Configure seasonal pricing periods and nightly hut fee rates
          </p>
        </div>
        {!showForm && (
          <Button onClick={() => setShowForm(true)}>Add Season</Button>
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
            <CardTitle>{editingId ? "Edit Season" : "New Season"}</CardTitle>
            <CardDescription>
              Configure the season period and set rates for each guest type
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Season Name</Label>
                  <Input
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Winter 2026"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="type">Type</Label>
                  <select
                    id="type"
                    value={type}
                    onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setType(e.target.value as "WINTER" | "SUMMER")}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
                  >
                    <option value="WINTER">Winter</option>
                    <option value="SUMMER">Summer</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="startDate">Start Date</Label>
                  <Input
                    id="startDate"
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="endDate">End Date</Label>
                  <Input
                    id="endDate"
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    required
                  />
                </div>
              </div>

              <div>
                <Label className="text-base font-semibold">Nightly Rates (NZD)</Label>
                <p className="text-sm text-muted-foreground mb-3">
                  Set the price per night for each guest type
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {Object.entries(RATE_LABELS).map(([key, label]) => (
                    <div key={key} className="space-y-1">
                      <Label htmlFor={`rate-${key}`} className="text-sm">
                        {label}
                      </Label>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                          $
                        </span>
                        <Input
                          id={`rate-${key}`}
                          type="number"
                          step="0.01"
                          min="0"
                          className="pl-7"
                          value={rates[key] ? (rates[key] / 100).toFixed(2) : ""}
                          onChange={(e) => handleRateChange(key, e.target.value)}
                          placeholder="0.00"
                        />
                      </div>
                    </div>
                  ))}
                </div>
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

              <div className="flex space-x-3">
                <Button type="submit" disabled={saving}>
                  {saving ? "Saving..." : editingId ? "Update Season" : "Create Season"}
                </Button>
                <Button type="button" variant="outline" onClick={resetForm}>
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Seasons List */}
      {seasons.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No seasons configured yet. Click &quot;Add Season&quot; to get started.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {seasons.map((season) => (
            <Card key={season.id}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <CardTitle className="text-xl">{season.name}</CardTitle>
                    <Badge variant={season.type === "WINTER" ? "default" : "secondary"}>
                      {season.type}
                    </Badge>
                    <Badge variant={season.active ? "default" : "outline"}>
                      {season.active ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                  <div className="flex space-x-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleToggleActive(season)}
                    >
                      {season.active ? "Deactivate" : "Activate"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => startEdit(season)}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => handleDelete(season.id)}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
                <CardDescription>
                  {new Date(season.startDate).toLocaleDateString("en-NZ")} &mdash;{" "}
                  {new Date(season.endDate).toLocaleDateString("en-NZ")}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Guest Type</TableHead>
                      <TableHead className="text-right">Price/Night</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {Object.entries(RATE_LABELS).map(([key, label]) => {
                      const [ageTier, isMemberStr] = key.split("-")
                      const rate = season.rates.find(
                        (r) => r.ageTier === ageTier && r.isMember === (isMemberStr === "true")
                      )
                      return (
                        <TableRow key={key}>
                          <TableCell>{label}</TableCell>
                          <TableCell className="text-right font-mono">
                            {rate ? formatCents(rate.pricePerNightCents) : "Not set"}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
