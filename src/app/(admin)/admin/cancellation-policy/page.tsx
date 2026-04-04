"use client"

import { useEffect, useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

interface PolicyRule {
  id?: string
  daysBeforeStay: number
  refundPercentage: number
}

export default function CancellationPolicyPage() {
  const [rules, setRules] = useState<PolicyRule[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")

  const fetchPolicy = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/cancellation-policy")
      if (!res.ok) throw new Error("Failed to fetch policy")
      const data = await res.json()
      setRules(data.length > 0 ? data : getDefaultRules())
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
      setRules(getDefaultRules())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchPolicy()
  }, [fetchPolicy])

  function getDefaultRules(): PolicyRule[] {
    return [
      { daysBeforeStay: 14, refundPercentage: 100 },
      { daysBeforeStay: 7, refundPercentage: 50 },
      { daysBeforeStay: 0, refundPercentage: 0 },
    ]
  }

  function addRule() {
    setRules((prev) => [...prev, { daysBeforeStay: 0, refundPercentage: 0 }])
  }

  function removeRule(index: number) {
    setRules((prev) => prev.filter((_, i) => i !== index))
  }

  function updateRule(index: number, field: keyof PolicyRule, value: number) {
    setRules((prev) =>
      prev.map((rule, i) => (i === index ? { ...rule, [field]: value } : rule))
    )
  }

  async function handleSave() {
    setSaving(true)
    setError("")
    setSuccess("")

    try {
      const res = await fetch("/api/admin/cancellation-policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Failed to save policy")
      }

      const data = await res.json()
      setRules(data)
      setSuccess("Cancellation policy saved successfully")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="text-center py-8">Loading policy...</div>
  }

  // Sort for display
  const sortedRules = [...rules].sort((a, b) => b.daysBeforeStay - a.daysBeforeStay)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Cancellation Policy</h1>
        <p className="text-muted-foreground mt-1">
          Configure refund percentages based on how far in advance a booking is cancelled
        </p>
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-md">
          {error}
        </div>
      )}

      {success && (
        <div className="bg-green-50 text-green-800 px-4 py-3 rounded-md border border-green-200">
          {success}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Refund Rules</CardTitle>
          <CardDescription>
            Define tiers based on days before check-in. The system applies the first matching rule
            (highest days threshold that the cancellation qualifies for).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Days Before Stay (minimum)</TableHead>
                <TableHead>Refund Percentage</TableHead>
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

          <Button variant="outline" onClick={addRule}>
            Add Rule
          </Button>
        </CardContent>
      </Card>

      {/* Preview */}
      <Card>
        <CardHeader>
          <CardTitle>Policy Preview</CardTitle>
          <CardDescription>
            How the cancellation policy will be applied
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2">
            {sortedRules.map((rule, index) => {
              const nextRule = sortedRules[index + 1]
              const isLast = index === sortedRules.length - 1

              let description: string
              if (index === 0) {
                description = `${rule.daysBeforeStay}+ days before stay: ${rule.refundPercentage}% refund`
              } else if (isLast && rule.daysBeforeStay === 0) {
                description = `Less than ${sortedRules[index - 1]?.daysBeforeStay ?? 0} days before stay: ${rule.refundPercentage}% refund`
              } else {
                const prevRule = sortedRules[index - 1]
                description = `${rule.daysBeforeStay}-${(prevRule?.daysBeforeStay ?? 0) - 1} days before stay: ${rule.refundPercentage}% refund`
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
        </CardContent>
      </Card>

      <div className="flex space-x-3">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save Policy"}
        </Button>
        <Button variant="outline" onClick={fetchPolicy}>
          Reset
        </Button>
      </div>
    </div>
  )
}
