"use client"

import { useEffect, useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const

interface MinStayPolicy {
  id: string
  name: string
  startDate: string
  endDate: string
  triggerDays: number[]
  minimumNights: number
  active: boolean
}

interface PolicyRule {
  id?: string
  daysBeforeStay: number
  refundPercentage: number
  creditRefundPercentage: number
  fixedFeeCents: number
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
  disabled = false,
}: {
  rules: PolicyRule[]
  onChange: (rules: PolicyRule[]) => void
  disabled?: boolean
}) {
  function addRule() {
    onChange([...rules, { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0, fixedFeeCents: 0 }])
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
            <TableHead>Card Refund %</TableHead>
            <TableHead>Credit Refund %</TableHead>
            <TableHead>Fixed Fee ($)</TableHead>
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
                    className={`w-24 ${disabled ? "bg-slate-50 text-slate-700" : ""}`}
                    disabled={disabled}
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
                    className={`w-24 ${disabled ? "bg-slate-50 text-slate-700" : ""}`}
                    disabled={disabled}
                  />
                  <span className="text-sm text-muted-foreground">%</span>
                </div>
              </TableCell>
              <TableCell>
                <div className="flex items-center space-x-2">
                  <Input
                    type="number"
                    min="0"
                    max="100"
                    value={rule.creditRefundPercentage}
                    onChange={(e) =>
                      updateRule(index, "creditRefundPercentage", parseInt(e.target.value) || 0)
                    }
                    className={`w-24 ${disabled ? "bg-slate-50 text-slate-700" : ""}`}
                    disabled={disabled}
                  />
                  <span className="text-sm text-muted-foreground">%</span>
                </div>
              </TableCell>
              <TableCell>
                <div className="flex items-center space-x-2">
                  <span className="text-sm text-muted-foreground">$</span>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={((rule.fixedFeeCents ?? 0) / 100).toFixed(2)}
                    onChange={(e) =>
                      updateRule(index, "fixedFeeCents", Math.round((parseFloat(e.target.value) || 0) * 100))
                    }
                    className={`w-24 ${disabled ? "bg-slate-50 text-slate-700" : ""}`}
                    disabled={disabled}
                  />
                </div>
              </TableCell>
              <TableCell>
                {!disabled && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeRule(index)}
                    disabled={rules.length <= 1}
                  >
                    Remove
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {!disabled && (
        <Button variant="outline" size="sm" onClick={addRule}>
          Add Rule
        </Button>
      )}
    </div>
  )
}

// ─── Policy Preview ─────────────────────────────────────────────────────────

function PolicyPreview({ rules }: { rules: PolicyRule[] }) {
  const sortedRules = [...rules].sort((a, b) => b.daysBeforeStay - a.daysBeforeStay)
  return (
    <ul className="space-y-1">
      {sortedRules.map((rule, index) => {
        let prefix: string
        if (index === 0) {
          prefix = `${rule.daysBeforeStay}+ days before stay:`
        } else if (rule.daysBeforeStay === 0 && index === sortedRules.length - 1) {
          prefix = `Less than ${sortedRules[index - 1]?.daysBeforeStay ?? 0} days:`
        } else {
          const prevDays = sortedRules[index - 1]?.daysBeforeStay ?? 0
          prefix = `${rule.daysBeforeStay}-${prevDays - 1} days:`
        }
        const creditDiffers = rule.creditRefundPercentage !== rule.refundPercentage
        const fixedFee = rule.fixedFeeCents ?? 0
        const feeStr = fixedFee > 0 ? ` minus $${(fixedFee / 100).toFixed(2)} fee` : ""
        const description = creditDiffers
          ? `${prefix} ${rule.refundPercentage}% card / ${rule.creditRefundPercentage}% credit${feeStr}`
          : `${prefix} ${rule.refundPercentage}% refund${feeStr}`
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
  const [editingDefaults, setEditingDefaults] = useState(false)
  const [savedDefaultRules, setSavedDefaultRules] = useState<PolicyRule[]>([])
  const [savedDefaultHoldDays, setSavedDefaultHoldDays] = useState(7)

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
    { daysBeforeStay: 21, refundPercentage: 100, creditRefundPercentage: 100, fixedFeeCents: 0 },
    { daysBeforeStay: 14, refundPercentage: 50, creditRefundPercentage: 50, fixedFeeCents: 0 },
    { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0, fixedFeeCents: 0 },
  ])
  const [savingPeriod, setSavingPeriod] = useState(false)

  // Group discount state
  const [groupMinSize, setGroupMinSize] = useState(5)
  const [groupSummerOnly, setGroupSummerOnly] = useState(true)
  const [groupEnabled, setGroupEnabled] = useState(false)
  const [loadingGroup, setLoadingGroup] = useState(true)
  const [savingGroup, setSavingGroup] = useState(false)
  const [editingGroup, setEditingGroup] = useState(false)
  const [savedGroup, setSavedGroup] = useState({ minGroupSize: 5, summerOnly: true, enabled: false })

  // Minimum stay state
  const [minStayPolicies, setMinStayPolicies] = useState<MinStayPolicy[]>([])
  const [loadingMinStay, setLoadingMinStay] = useState(true)
  const [showMinStayForm, setShowMinStayForm] = useState(false)
  const [editingMinStayId, setEditingMinStayId] = useState<string | null>(null)
  const [msName, setMsName] = useState("")
  const [msStart, setMsStart] = useState("")
  const [msEnd, setMsEnd] = useState("")
  const [msTriggerDays, setMsTriggerDays] = useState<number[]>([6]) // default Saturday
  const [msMinNights, setMsMinNights] = useState(2)
  const [savingMinStay, setSavingMinStay] = useState(false)

  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")

  // ─── Fetch defaults ───────────────────────────────────────────────────────

  const fetchDefaults = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/booking-policies/cancellation")
      if (!res.ok) throw new Error("Failed to fetch policy")
      const data = await res.json()
      const rules = data.rules && data.rules.length > 0
        ? data.rules.map((r: PolicyRule) => ({ ...r, fixedFeeCents: r.fixedFeeCents ?? 0 }))
        : [
            { daysBeforeStay: 14, refundPercentage: 100, creditRefundPercentage: 100, fixedFeeCents: 0 },
            { daysBeforeStay: 7, refundPercentage: 50, creditRefundPercentage: 50, fixedFeeCents: 0 },
            { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0, fixedFeeCents: 0 },
          ]
      const holdDays = data.nonMemberHoldDays ?? 7
      setDefaultRules(rules)
      setDefaultHoldDays(holdDays)
      setSavedDefaultRules(rules)
      setSavedDefaultHoldDays(holdDays)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setLoadingDefaults(false)
    }
  }, [])

  const fetchPeriods = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/booking-policies/periods")
      if (!res.ok) throw new Error("Failed to fetch periods")
      const data = await res.json()
      setPeriods(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setLoadingPeriods(false)
    }
  }, [])

  const fetchMinStay = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/booking-policies/minimum-stay")
      if (!res.ok) throw new Error("Failed to fetch minimum stay policies")
      const data = await res.json()
      setMinStayPolicies(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setLoadingMinStay(false)
    }
  }, [])

  const fetchGroupDiscount = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/booking-policies/group-discount")
      if (!res.ok) throw new Error("Failed to fetch group discount")
      const data = await res.json()
      setGroupMinSize(data.minGroupSize)
      setGroupSummerOnly(data.summerOnly)
      setGroupEnabled(data.enabled)
      setSavedGroup({ minGroupSize: data.minGroupSize, summerOnly: data.summerOnly, enabled: data.enabled })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setLoadingGroup(false)
    }
  }, [])

  useEffect(() => {
    fetchDefaults()
    fetchPeriods()
    fetchMinStay()
    fetchGroupDiscount()
  }, [fetchDefaults, fetchPeriods, fetchMinStay, fetchGroupDiscount])

  // ─── Save defaults ────────────────────────────────────────────────────────

  function handleCancelDefaults() {
    setDefaultRules(savedDefaultRules)
    setDefaultHoldDays(savedDefaultHoldDays)
    setEditingDefaults(false)
  }

  async function handleSaveDefaults() {
    setSavingDefaults(true)
    setError("")
    setSuccess("")
    try {
      const res = await fetch("/api/admin/booking-policies/cancellation", {
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
      setSavedDefaultRules(data.rules)
      setSavedDefaultHoldDays(data.nonMemberHoldDays)
      setEditingDefaults(false)
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
      { daysBeforeStay: 21, refundPercentage: 100, creditRefundPercentage: 100, fixedFeeCents: 0 },
      { daysBeforeStay: 14, refundPercentage: 50, creditRefundPercentage: 50, fixedFeeCents: 0 },
      { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0, fixedFeeCents: 0 },
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
        ? `/api/admin/booking-policies/periods/${editingPeriodId}`
        : "/api/admin/booking-policies/periods"
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
      const res = await fetch(`/api/admin/booking-policies/periods/${id}`, { method: "DELETE" })
      if (!res.ok) throw new Error("Failed to delete")
      fetchPeriods()
      setSuccess("Period deleted")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    }
  }

  async function handleTogglePeriod(period: BookingPeriod) {
    try {
      const res = await fetch(`/api/admin/booking-policies/periods/${period.id}`, {
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

  // ─── Minimum Stay CRUD ─────────────────────────────────────────────────

  function resetMinStayForm() {
    setShowMinStayForm(false)
    setEditingMinStayId(null)
    setMsName("")
    setMsStart("")
    setMsEnd("")
    setMsTriggerDays([6])
    setMsMinNights(2)
  }

  function startEditMinStay(policy: MinStayPolicy) {
    setEditingMinStayId(policy.id)
    setMsName(policy.name)
    setMsStart(policy.startDate.split("T")[0])
    setMsEnd(policy.endDate.split("T")[0])
    setMsTriggerDays(policy.triggerDays)
    setMsMinNights(policy.minimumNights)
    setShowMinStayForm(true)
  }

  function toggleTriggerDay(day: number) {
    setMsTriggerDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort()
    )
  }

  async function handleSaveMinStay() {
    setSavingMinStay(true)
    setError("")
    setSuccess("")
    try {
      const url = editingMinStayId
        ? `/api/admin/booking-policies/minimum-stay/${editingMinStayId}`
        : "/api/admin/booking-policies/minimum-stay"
      const method = editingMinStayId ? "PUT" : "POST"

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: msName,
          startDate: msStart,
          endDate: msEnd,
          triggerDays: msTriggerDays,
          minimumNights: msMinNights,
        }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Failed to save")
      }
      resetMinStayForm()
      fetchMinStay()
      setSuccess(editingMinStayId ? "Minimum stay policy updated" : "Minimum stay policy created")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setSavingMinStay(false)
    }
  }

  async function handleDeleteMinStay(id: string) {
    if (!confirm("Deactivate this minimum stay policy?")) return
    try {
      const res = await fetch(`/api/admin/booking-policies/minimum-stay/${id}`, { method: "DELETE" })
      if (!res.ok) throw new Error("Failed to deactivate")
      fetchMinStay()
      setSuccess("Minimum stay policy deactivated")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    }
  }

  async function handleToggleMinStay(policy: MinStayPolicy) {
    try {
      const res = await fetch(`/api/admin/booking-policies/minimum-stay/${policy.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !policy.active }),
      })
      if (!res.ok) throw new Error("Failed to update")
      fetchMinStay()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    }
  }

  function handleCancelGroup() {
    setGroupMinSize(savedGroup.minGroupSize)
    setGroupSummerOnly(savedGroup.summerOnly)
    setGroupEnabled(savedGroup.enabled)
    setEditingGroup(false)
  }

  async function handleSaveGroup() {
    setSavingGroup(true)
    setError("")
    setSuccess("")
    try {
      const res = await fetch("/api/admin/booking-policies/group-discount", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          minGroupSize: groupMinSize,
          summerOnly: groupSummerOnly,
          enabled: groupEnabled,
        }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Failed to save")
      }
      const data = await res.json()
      setGroupMinSize(data.minGroupSize)
      setGroupSummerOnly(data.summerOnly)
      setGroupEnabled(data.enabled)
      setSavedGroup({ minGroupSize: data.minGroupSize, summerOnly: data.summerOnly, enabled: data.enabled })
      setEditingGroup(false)
      setSuccess("Group discount settings saved")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setSavingGroup(false)
    }
  }

  if (loadingDefaults || loadingPeriods || loadingMinStay || loadingGroup) {
    return <div className="text-center py-8">Loading...</div>
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Booking Policies</h1>
        <p className="text-muted-foreground mt-1">
          Configure cancellation refund rules, date-specific overrides, and minimum night stay requirements
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
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Default Policy</CardTitle>
            <CardDescription>
              These rules apply to all bookings unless a date-specific period overrides them.
            </CardDescription>
          </div>
          {!editingDefaults && (
            <Button variant="outline" size="sm" onClick={() => setEditingDefaults(true)}>
              Edit
            </Button>
          )}
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
                className={`w-20 ${!editingDefaults ? "bg-slate-50 text-slate-700" : ""}`}
                disabled={!editingDefaults}
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
            <CancellationRulesEditor rules={defaultRules} onChange={setDefaultRules} disabled={!editingDefaults} />
          </div>

          <div>
            <Label className="text-sm font-semibold">Preview</Label>
            <PolicyPreview rules={defaultRules} />
          </div>

          {editingDefaults && (
            <div className="flex space-x-3">
              <Button onClick={handleSaveDefaults} disabled={savingDefaults}>
                {savingDefaults ? "Saving..." : "Save Default Policy"}
              </Button>
              <Button variant="outline" onClick={handleCancelDefaults} disabled={savingDefaults}>
                Cancel
              </Button>
            </div>
          )}
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

      {/* ── Group Discount ──────────────────────────────────────────────── */}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Group Discount</CardTitle>
            <CardDescription>
              When a booking has enough guests, all guests are charged at member rates.
            </CardDescription>
          </div>
          {!editingGroup && (
            <Button variant="outline" size="sm" onClick={() => setEditingGroup(true)}>
              Edit
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center space-x-2">
            <input
              type="checkbox"
              id="groupEnabled"
              checked={groupEnabled}
              onChange={(e) => setGroupEnabled(e.target.checked)}
              className="rounded border-input"
              disabled={!editingGroup}
            />
            <Label htmlFor="groupEnabled">Enabled</Label>
          </div>

          <div className="space-y-2 max-w-xs">
            <Label htmlFor="groupMinSize">Minimum group size</Label>
            <div className="flex items-center space-x-2">
              <Input
                id="groupMinSize"
                type="number"
                min="2"
                max="29"
                value={groupMinSize}
                onChange={(e) => setGroupMinSize(parseInt(e.target.value) || 5)}
                className={`w-20 ${!editingGroup ? "bg-slate-50 text-slate-700" : ""}`}
                disabled={!editingGroup}
              />
              <span className="text-sm text-muted-foreground">guests</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Bookings with this many or more guests will have all guests charged at member rates.
            </p>
          </div>

          <div className="flex items-center space-x-2">
            <input
              type="checkbox"
              id="groupSummerOnly"
              checked={groupSummerOnly}
              onChange={(e) => setGroupSummerOnly(e.target.checked)}
              className="rounded border-input"
              disabled={!editingGroup}
            />
            <Label htmlFor="groupSummerOnly">Summer seasons only</Label>
          </div>

          {editingGroup && (
            <div className="flex space-x-3">
              <Button onClick={handleSaveGroup} disabled={savingGroup}>
                {savingGroup ? "Saving..." : "Save Group Discount"}
              </Button>
              <Button variant="outline" onClick={handleCancelGroup} disabled={savingGroup}>
                Cancel
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Minimum Night Stay Policies ───────────────────────────────────── */}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Minimum Night Stay</CardTitle>
              <CardDescription>
                Require a minimum number of nights when a booking touches specific days of the week
                within a date range. Admins can override these rules.
              </CardDescription>
            </div>
            {!showMinStayForm && (
              <Button onClick={() => setShowMinStayForm(true)}>Add Policy</Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Min Stay Form */}
          {showMinStayForm && (
            <Card className="border-blue-200 bg-blue-50/30">
              <CardContent className="pt-6 space-y-4">
                <h3 className="font-semibold">
                  {editingMinStayId ? "Edit Policy" : "New Minimum Stay Policy"}
                </h3>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="msName">Policy Name</Label>
                    <Input
                      id="msName"
                      value={msName}
                      onChange={(e) => setMsName(e.target.value)}
                      placeholder="e.g. Winter Saturday Minimum Stay"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="msMinNights">Minimum Nights</Label>
                    <Input
                      id="msMinNights"
                      type="number"
                      min="2"
                      value={msMinNights}
                      onChange={(e) => setMsMinNights(parseInt(e.target.value) || 2)}
                      className="w-24"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="msStart">Start Date</Label>
                    <Input
                      id="msStart"
                      type="date"
                      value={msStart}
                      onChange={(e) => setMsStart(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="msEnd">End Date</Label>
                    <Input
                      id="msEnd"
                      type="date"
                      value={msEnd}
                      onChange={(e) => setMsEnd(e.target.value)}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label className="text-sm font-semibold">Trigger Days</Label>
                  <p className="text-xs text-muted-foreground">
                    The minimum stay applies when a booking includes any of these days within the date range.
                  </p>
                  <div className="flex flex-wrap gap-3">
                    {DAY_LABELS.map((label, i) => (
                      <label key={i} className="flex items-center gap-1.5 text-sm">
                        <Checkbox
                          checked={msTriggerDays.includes(i)}
                          onCheckedChange={() => toggleTriggerDay(i)}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>

                <div className="flex space-x-3">
                  <Button
                    onClick={handleSaveMinStay}
                    disabled={savingMinStay || !msName || !msStart || !msEnd || msTriggerDays.length === 0}
                  >
                    {savingMinStay ? "Saving..." : editingMinStayId ? "Update Policy" : "Create Policy"}
                  </Button>
                  <Button variant="outline" onClick={resetMinStayForm}>Cancel</Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Min Stay List */}
          {minStayPolicies.length === 0 && !showMinStayForm ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No minimum night stay policies configured. Members can book any number of nights.
            </p>
          ) : (
            <div className="space-y-3">
              {minStayPolicies.map((policy) => (
                <Card key={policy.id} className={!policy.active ? "opacity-60" : ""}>
                  <CardContent className="pt-4">
                    <div className="flex items-start justify-between mb-2">
                      <div>
                        <div className="flex items-center gap-2">
                          <h4 className="font-semibold">{policy.name}</h4>
                          <Badge variant={policy.active ? "default" : "outline"}>
                            {policy.active ? "Active" : "Inactive"}
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {new Date(policy.startDate).toLocaleDateString("en-NZ")} &mdash;{" "}
                          {new Date(policy.endDate).toLocaleDateString("en-NZ")}
                        </p>
                      </div>
                      <div className="flex space-x-2">
                        <Button variant="outline" size="sm" onClick={() => handleToggleMinStay(policy)}>
                          {policy.active ? "Deactivate" : "Activate"}
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => startEditMinStay(policy)}>
                          Edit
                        </Button>
                        {policy.active && (
                          <Button variant="destructive" size="sm" onClick={() => handleDeleteMinStay(policy.id)}>
                            Deactivate
                          </Button>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-muted-foreground">Trigger days:</span>
                      {policy.triggerDays.map((d) => (
                        <Badge key={d} variant="secondary">{DAY_LABELS[d]}</Badge>
                      ))}
                      <span className="ml-2 text-muted-foreground">
                        Min <strong>{policy.minimumNights}</strong> nights
                      </span>
                    </div>
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
