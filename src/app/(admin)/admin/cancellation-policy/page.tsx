"use client"

import { useEffect, useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"

interface PolicyRule {
  id?: string
  daysBeforeStay: number
  refundPercentage: number
}

interface BookingPeriod {
  id: string
  name: string
  startDate: string
  endDate: string
  nonMemberHoldDays: number
  cancellationRules: PolicyRule[]
  active: boolean
}

// ─── Cancellation Rules Editor (reused for defaults and periods) ────────────

function CancellationRulesEditor({
  rules,
  onChange,
}: {
  rules: PolicyRule[]
  onChange: (rules: PolicyRule[]) => void
}) {
  function addRule() {
    onChange([...rules, { daysBeforeStay: 0, refundPercentage: 0 }])
  }
  function removeRule(index: number) {
    onChange(rules.filter((_, i) => i !== index))
  }
  function updateRule(index: number, field: keyof PolicyRule, value: number) {
    onChange(rules.map((r, i) => (i === index ? { ...r, [field]: value } : r)))
  }

  return (
    <div className="space-y-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Days Before Stay (min)</TableHead>
            <TableHead>Refund %</TableHead>
            <TableHead className="w-20"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rules.map((rule, index) => (
            <TableRow key={index}>
              <TableCell>
                <div className="flex items-center space-x-2">
                  <Input
                    type="number"
                    min="0"
                    value={rule.daysBeforeStay}
                    onChange={(e) =>
                      updateRule(index, "daysBeforeStay", parseInt(e.target.value) || 0)
                    }
                    className="w-24"
                  />
                  <span className="text-sm text-muted-foreground">days</span>
                </div>
              </TableCell>
              <TableCell>
                <div className="flex items-center space-x-2">
                  <Input
                    type="number"
                    min="0"
                    max="100"
                    value={rule.refundPercentage}
                    onChange={(e) =>
                      updateRule(index, "refundPercentage", parseInt(e.target.value) || 0)
                    }
                    className="w-24"
                  />
                  <span className="text-sm text-muted-foreground">%</span>
                </div>
              </TableCell>
              <TableCell>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeRule(index)}
                  disabled={rules.length <= 1}
                >
                  Remove
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Button variant="outline" size="sm" onClick={addRule}>
        Add Rule
      </Button>
    </div>
  )
}

// ─── Policy Preview ─────────────────────────────────────────────────────────

function PolicyPreview({ rules }: { rules: PolicyRule[] }) {
  const sortedRules = [...rules].sort((a, b) => b.daysBeforeStay - a.daysBeforeStay)
  return (
    <ul className="space-y-1">
      {sortedRules.map((rule, index) => {
        let description: string
        if (index === 0) {
          description = `${rule.daysBeforeStay}+ days before stay: ${rule.refundPercentage}% refund`
        } else if (rule.daysBeforeStay === 0 && index === sortedRules.length - 1) {
          description = `Less than ${sortedRules[index - 1]?.daysBeforeStay ?? 0} days: ${rule.refundPercentage}% refund`
        } else {
          const prevDays = sortedRules[index - 1]?.daysBeforeStay ?? 0
          description = `${rule.daysBeforeStay}-${prevDays - 1} days: ${rule.refundPercentage}% refund`
        }
        return (
          <li key={index} className="flex items-center space-x-2">
            <div
              className="w-3 h-3 rounded-full"
              style={{
                backgroundColor: `hsl(${(rule.refundPercentage / 100) * 120}, 70%, 50%)`,
              }}
            />
            <span className="text-sm">{description}</span>
          </li>
        )
      })}
    </ul>
  )
}

// ─── Main Page ──────────────────────────────────────────────────────────────

export default function BookingPoliciesPage() {
  // Default policy state
  const [defaultRules, setDefaultRules] = useState<PolicyRule[]>([])
  const [defaultHoldDays, setDefaultHoldDays] = useState(7)
  const [loadingDefaults, setLoadingDefaults] = useState(true)
  const [savingDefaults, setSavingDefaults] = useState(false)

  // Booking periods state
  const [periods, setPeriods] = useState<BookingPeriod[]>([])
  const [loadingPeriods, setLoadingPeriods] = useState(true)

  // Period form state
  const [showPeriodForm, setShowPeriodForm] = useState(false)
  const [editingPeriodId, setEditingPeriodId] = useState<string | null>(null)
  const [periodName, setPeriodName] = useState("")
  const [periodStart, setPeriodStart] = useState("")
  const [periodEnd, setPeriodEnd] = useState("")
  const [periodHoldDays, setPeriodHoldDays] = useState(5)
  const [periodRules, setPeriodRules] = useState<PolicyRule[]>([
    { daysBeforeStay: 21, refundPercentage: 100 },
    { daysBeforeStay: 14, refundPercentage: 50 },
    { daysBeforeStay: 0, refundPercentage: 0 },
  ])
  const [savingPeriod, setSavingPeriod] = useState(false)

  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")

  // ─── Fetch defaults ───────────────────────────────────────────────────────

  const fetchDefaults = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/cancellation-policy")
      if (!res.ok) throw new Error("Failed to fetch policy")
      const data = await res.json()
      if (data.rules && data.rules.length > 0) {
        setDefaultRules(data.rules)
      } else {
        setDefaultRules([
          { daysBeforeStay: 14, refundPercentage: 100 },
          { daysBeforeStay: 7, refundPercentage: 50 },
          { daysBeforeStay: 0, refundPercentage: 0 },
        ])
      }
      setDefaultHoldDays(data.nonMemberHoldDays ?? 7)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setLoadingDefaults(false)
    }
  }, [])

  const fetchPeriods = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/booking-periods")
      if (!res.ok) throw new Error("Failed to fetch periods")
      const data = await res.json()
      setPeriods(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setLoadingPeriods(false)
    }
  }, [])

  useEffect(() => {
    fetchDefaults()
    fetchPeriods()
  }, [fetchDefaults, fetchPeriods])

  // ─── Save defaults ────────────────────────────────────────────────────────

  async function handleSaveDefaults() {
    setSavingDefaults(true)
    setError("")
    setSuccess("")
    try {
      const res = await fetch("/api/admin/cancellation-policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rules: defaultRules,
          nonMemberHoldDays: defaultHoldDays,
        }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Failed to save")
      }
      const data = await res.json()
      setDefaultRules(data.rules)
      setDefaultHoldDays(data.nonMemberHoldDays)
      setSuccess("Default policy saved")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setSavingDefaults(false)
    }
  }

  // ─── Period CRUD ──────────────────────────────────────────────────────────

  function resetPeriodForm() {
    setShowPeriodForm(false)
    setEditingPeriodId(null)
    setPeriodName("")
    setPeriodStart("")
    setPeriodEnd("")
    setPeriodHoldDays(5)
    setPeriodRules([
      { daysBeforeStay: 21, refundPercentage: 100 },
      { daysBeforeStay: 14, refundPercentage: 50 },
      { daysBeforeStay: 0, refundPercentage: 0 },
    ])
  }

  function startEditPeriod(period: BookingPeriod) {
    setEditingPeriodId(period.id)
    setPeriodName(period.name)
    setPeriodStart(period.startDate.split("T")[0])
    setPeriodEnd(period.endDate.split("T")[0])
    setPeriodHoldDays(period.nonMemberHoldDays)
    setPeriodRules(period.cancellationRules)
    setShowPeriodForm(true)
  }

  async function handleSavePeriod() {
    setSavingPeriod(true)
    setError("")
    setSuccess("")
    try {
      const url = editingPeriodId
        ? `/api/admin/booking-periods/${editingPeriodId}`
        : "/api/admin/booking-periods"
      const method = editingPeriodId ? "PUT" : "POST"

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: periodName,
          startDate: periodStart,
          endDate: periodEnd,
          nonMemberHoldDays: periodHoldDays,
          cancellationRules: periodRules,
        }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Failed to save period")
      }
      resetPeriodForm()
      fetchPeriods()
      setSuccess(editingPeriodId ? "Period updated" : "Period created")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setSavingPeriod(false)
    }
  }

  async function handleDeletePeriod(id: string) {
    if (!confirm("Delete this booking period?")) return
    try {
      const res = await fetch(`/api/admin/booking-periods/${id}`, { method: "DELETE" })
      if (!res.ok) throw new Error("Failed to delete")
      fetchPeriods()
      setSuccess("Period deleted")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    }
  }

  async function handleTogglePeriod(period: BookingPeriod) {
    try {
      const res = await fetch(`/api/admin/booking-periods/${period.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !period.active }),
      })
      if (!res.ok) throw new Error("Failed to update")
      fetchPeriods()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    }
  }

  if (loadingDefaults || loadingPeriods) {
    return <div className="text-center py-8">Loading...</div>
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Booking Policies</h1>
        <p className="text-muted-foreground mt-1">
          Configure default cancellation rules and date-specific overrides for school holidays and peak periods
        </p>
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-md">
          {error}
          <button onClick={() => setError("")} className="ml-2 underline">Dismiss</button>
        </div>
      )}
      {success && (
        <div className="bg-green-50 text-green-800 px-4 py-3 rounded-md border border-green-200">
          {success}
          <button onClick={() => setSuccess("")} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      {/* ── Default Policy ─────────────────────────────────────────────────── */}

      <Card>
        <CardHeader>
          <CardTitle>Default Policy</CardTitle>
          <CardDescription>
            These rules apply to all bookings unless a date-specific period overrides them.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2 max-w-xs">
            <Label htmlFor="holdDays">Non-member confirmation threshold</Label>
            <div className="flex items-center space-x-2">
              <Input
                id="holdDays"
                type="number"
                min="1"
                max="30"
                value={defaultHoldDays}
                onChange={(e) => setDefaultHoldDays(parseInt(e.target.value) || 7)}
                className="w-20"
              />
              <span className="text-sm text-muted-foreground">days before check-in</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Non-member bookings are held as pending until this many days before check-in, then confirmed automatically.
            </p>
          </div>

          <div>
            <Label className="text-base font-semibold">Cancellation Refund Rules</Label>
            <p className="text-sm text-muted-foreground mb-3">
              The first matching rule (highest days threshold) applies.
            </p>
            <CancellationRulesEditor rules={defaultRules} onChange={setDefaultRules} />
          </div>

          <div>
            <Label className="text-sm font-semibold">Preview</Label>
            <PolicyPreview rules={defaultRules} />
          </div>

          <div className="flex space-x-3">
            <Button onClick={handleSaveDefaults} disabled={savingDefaults}>
              {savingDefaults ? "Saving..." : "Save Default Policy"}
            </Button>
            <Button variant="outline" onClick={fetchDefaults}>Reset</Button>
          </div>
        </CardContent>
      </Card>

      {/* ── Date-Specific Periods ──────────────────────────────────────────── */}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Date-Specific Periods</CardTitle>
              <CardDescription>
                Override the default policy for specific date ranges (e.g. school holidays).
                If a booking&apos;s check-in falls within a period, that period&apos;s rules apply.
              </CardDescription>
            </div>
            {!showPeriodForm && (
              <Button onClick={() => setShowPeriodForm(true)}>Add Period</Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Period Form */}
          {showPeriodForm && (
            <Card className="border-blue-200 bg-blue-50/30">
              <CardContent className="pt-6 space-y-4">
                <h3 className="font-semibold">
                  {editingPeriodId ? "Edit Period" : "New Period"}
                </h3>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="pName">Period Name</Label>
                    <Input
                      id="pName"
                      value={periodName}
                      onChange={(e) => setPeriodName(e.target.value)}
                      placeholder="e.g. School Holidays Jul 2026"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="pHold">Non-member hold days</Label>
                    <Input
                      id="pHold"
                      type="number"
                      min="1"
                      max="30"
                      value={periodHoldDays}
                      onChange={(e) => setPeriodHoldDays(parseInt(e.target.value) || 5)}
                      className="w-24"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="pStart">Start Date</Label>
                    <Input
                      id="pStart"
                      type="date"
                      value={periodStart}
                      onChange={(e) => setPeriodStart(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="pEnd">End Date</Label>
                    <Input
                      id="pEnd"
                      type="date"
                      value={periodEnd}
                      onChange={(e) => setPeriodEnd(e.target.value)}
                    />
                  </div>
                </div>

                <div>
                  <Label className="text-sm font-semibold">Cancellation Rules for this Period</Label>
                  <CancellationRulesEditor rules={periodRules} onChange={setPeriodRules} />
                </div>

                <div>
                  <Label className="text-sm font-semibold">Preview</Label>
                  <PolicyPreview rules={periodRules} />
                </div>

                <div className="flex space-x-3">
                  <Button onClick={handleSavePeriod} disabled={savingPeriod || !periodName || !periodStart || !periodEnd}>
                    {savingPeriod ? "Saving..." : editingPeriodId ? "Update Period" : "Create Period"}
                  </Button>
                  <Button variant="outline" onClick={resetPeriodForm}>Cancel</Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Periods List */}
          {periods.length === 0 && !showPeriodForm ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No date-specific periods configured. The default policy applies to all bookings.
            </p>
          ) : (
            <div className="space-y-3">
              {periods.map((period) => (
                <Card key={period.id} className={!period.active ? "opacity-60" : ""}>
                  <CardContent className="pt-4">
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <h4 className="font-semibold">{period.name}</h4>
                          <Badge variant={period.active ? "default" : "outline"}>
                            {period.active ? "Active" : "Inactive"}
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {new Date(period.startDate).toLocaleDateString("en-NZ")} &mdash;{" "}
                          {new Date(period.endDate).toLocaleDateString("en-NZ")}
                          <span className="ml-3">
                            Non-member hold: <strong>{period.nonMemberHoldDays} days</strong>
                          </span>
                        </p>
                      </div>
                      <div className="flex space-x-2">
                        <Button variant="outline" size="sm" onClick={() => handleTogglePeriod(period)}>
                          {period.active ? "Deactivate" : "Activate"}
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => startEditPeriod(period)}>
                          Edit
                        </Button>
                        <Button variant="destructive" size="sm" onClick={() => handleDeletePeriod(period.id)}>
                          Delete
                        </Button>
                      </div>
                    </div>
                    <PolicyPreview rules={period.cancellationRules} />
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
