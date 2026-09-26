"use client"

import { useEffect, useId, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { MONEY_INPUT_PROPS, parseDecimalDollarsToCents } from "@/lib/money-input"
import { formatCentsPlain } from "@/lib/utils"
import type { PolicyRule } from "./types"

/** What a refused fixed-fee box says (#2685). */
const FEE_FIELD_ERROR = "Enter a fee in dollars and cents, for example 25.00."

type FeeField = "fixedFeeCents" | "creditFixedFeeCents"

function feeKey(index: number, field: FeeField): string {
  return `${index}:${field}`
}

export function CancellationRulesEditor({
  rules,
  onChange,
  disabled = false,
  onInvalidAmountsChange,
}: {
  rules: PolicyRule[]
  onChange: (rules: PolicyRule[]) => void
  disabled?: boolean
  /**
   * #2685: told whenever a fixed-fee box holds something that is not an amount,
   * so the section around this editor can refuse to save. Without it the stored
   * cents would stay at the PREVIOUS value while the box shows something else.
   */
  onInvalidAmountsChange?: (hasInvalidAmounts: boolean) => void
}) {
  /*
    #2685: the raw text of each fixed-fee box, and the complaint for any box
    whose text is not an amount.

    `rules` holds integer cents, so it cannot also hold a half-typed entry. The
    fee used to be `Math.round((parseFloat(value) || 0) * 100)`, which turned a
    third decimal place into a silent half-cent rounding and anything else into
    a fee of $0.00 — a cancellation charge quietly set to nothing.
  */
  const [feeDrafts, setFeeDrafts] = useState<Record<string, string>>({})
  const [feeErrors, setFeeErrors] = useState<Record<string, string>>({})
  // Both booking-policy sections can render an editor on the same page, so the
  // error element ids are scoped per instance rather than by row index alone.
  const instanceId = useId()

  /*
    #2685 review — A DRAFT MUST NOT OUTLIVE THE RULES IT WAS TYPED AGAINST.

    `feeDrafts` and `feeErrors` are keyed by ROW INDEX, and index 0 of the next
    thing to arrive is a different fee entirely. Nothing cleared them when the
    surrounding section replaced `rules`, so:

      * press Cancel and the abandoned text was still in the box, the complaint
        was still on screen, and `onInvalidAmountsChange` still said "invalid",
        which latched Save off for a policy the admin had just reverted;
      * switch the policy scope and the boxes showed the PREVIOUS lodge's typed
        text over the new lodge's stored fees.

    The section owns `rules`, so the honest signal is its IDENTITY — but the
    editor is what changes it on every keystroke, and wiping the draft then
    would make the box untypable. So the editor remembers the array it last
    emitted: an array that is not that one came from outside, and the drafts
    belong to something that is gone.

    Both consumers pass the array straight back (`section.setDraft({ rules })`
    spreads it onto the draft object unchanged), which is what makes the
    identity test reliable rather than a guess.
  */
  const emittedRulesRef = useRef<PolicyRule[] | null>(null)
  useEffect(() => {
    if (rules === emittedRulesRef.current) return
    emittedRulesRef.current = rules
    // Keep the existing object when there is nothing to drop, so an ordinary
    // reload does not force a re-render for no reason.
    setFeeDrafts((prev) => (Object.keys(prev).length === 0 ? prev : {}))
    setFeeErrors((prev) => (Object.keys(prev).length === 0 ? prev : {}))
  }, [rules])

  /** Every `onChange` goes through here, so the editor knows its own output. */
  function emitRules(next: PolicyRule[]) {
    emittedRulesRef.current = next
    onChange(next)
  }

  function feeErrorId(index: number, field: FeeField): string {
    return `${instanceId}-${index}-${field}-error`
  }

  const hasInvalidAmounts = Object.keys(feeErrors).length > 0
  useEffect(() => {
    onInvalidAmountsChange?.(hasInvalidAmounts)
  }, [hasInvalidAmounts, onInvalidAmountsChange])

  function feeValue(index: number, field: FeeField): string {
    const draft = feeDrafts[feeKey(index, field)]
    if (draft !== undefined) return draft
    return formatCentsPlain(rules[index]?.[field] ?? 0)
  }

  function handleFeeChange(index: number, field: FeeField, value: string) {
    const key = feeKey(index, field)
    setFeeDrafts((prev) => ({ ...prev, [key]: value }))

    // An empty box is a deliberate "no fee", not a mistake.
    const cents = value.trim() === "" ? 0 : parseDecimalDollarsToCents(value)
    if (cents === null) {
      setFeeErrors((prev) => ({ ...prev, [key]: FEE_FIELD_ERROR }))
      return
    }

    setFeeErrors((prev) => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
    updateRule(index, field, cents)
  }
  function addRule() {
    emitRules([
      ...rules,
      {
        daysBeforeStay: 0,
        refundPercentage: 0,
        creditRefundPercentage: 0,
        fixedFeeCents: 0,
        creditFixedFeeCents: 0,
      },
    ])
  }
  function removeRule(index: number) {
    // Drop the removed row's drafts and complaints, and shift the rows after it
    // down a place, so a stale error cannot outlive the rule it belonged to.
    const reindex = (prev: Record<string, string>) => {
      const next: Record<string, string> = {}
      for (const [key, value] of Object.entries(prev)) {
        const [rowText, field] = key.split(":")
        const row = Number(rowText)
        if (row === index) continue
        next[feeKey(row > index ? row - 1 : row, field as FeeField)] = value
      }
      return next
    }
    setFeeDrafts(reindex)
    setFeeErrors(reindex)
    emitRules(rules.filter((_, i) => i !== index))
  }
  function updateRule(index: number, field: keyof PolicyRule, value: number) {
    emitRules(rules.map((r, i) => (i === index ? { ...r, [field]: value } : r)))
  }

  return (
    <div className="space-y-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Days Before Stay (min)</TableHead>
            <TableHead>Card Refund %</TableHead>
            <TableHead>Credit Refund %</TableHead>
            <TableHead>Card Fixed Fee ($)</TableHead>
            <TableHead>Credit Fixed Fee ($)</TableHead>
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
                    className={`w-24 ${disabled ? "bg-muted text-muted-foreground" : ""}`}
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
                    className={`w-24 ${disabled ? "bg-muted text-muted-foreground" : ""}`}
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
                    className={`w-24 ${disabled ? "bg-muted text-muted-foreground" : ""}`}
                    disabled={disabled}
                  />
                  <span className="text-sm text-muted-foreground">%</span>
                </div>
              </TableCell>
              <TableCell>
                <div className="flex items-center space-x-2">
                  <span className="text-sm text-muted-foreground">$</span>
                  <Input
                    {...MONEY_INPUT_PROPS}
                    value={feeValue(index, "fixedFeeCents")}
                    onChange={(e) => handleFeeChange(index, "fixedFeeCents", e.target.value)}
                    aria-invalid={feeErrors[feeKey(index, "fixedFeeCents")] ? true : undefined}
                    aria-describedby={
                      feeErrors[feeKey(index, "fixedFeeCents")]
                        ? feeErrorId(index, "fixedFeeCents")
                        : undefined
                    }
                    className={`w-24 ${disabled ? "bg-muted text-muted-foreground" : ""}`}
                    disabled={disabled}
                  />
                </div>
                {feeErrors[feeKey(index, "fixedFeeCents")] && (
                  <p
                    id={feeErrorId(index, "fixedFeeCents")}
                    role="alert"
                    className="text-destructive mt-1 text-sm"
                  >
                    {feeErrors[feeKey(index, "fixedFeeCents")]}
                  </p>
                )}
              </TableCell>
              <TableCell>
                <div className="flex items-center space-x-2">
                  <span className="text-sm text-muted-foreground">$</span>
                  <Input
                    {...MONEY_INPUT_PROPS}
                    value={feeValue(index, "creditFixedFeeCents")}
                    onChange={(e) =>
                      handleFeeChange(index, "creditFixedFeeCents", e.target.value)
                    }
                    aria-invalid={
                      feeErrors[feeKey(index, "creditFixedFeeCents")] ? true : undefined
                    }
                    aria-describedby={
                      feeErrors[feeKey(index, "creditFixedFeeCents")]
                        ? feeErrorId(index, "creditFixedFeeCents")
                        : undefined
                    }
                    className={`w-24 ${disabled ? "bg-muted text-muted-foreground" : ""}`}
                    disabled={disabled}
                  />
                </div>
                {feeErrors[feeKey(index, "creditFixedFeeCents")] && (
                  <p
                    id={feeErrorId(index, "creditFixedFeeCents")}
                    role="alert"
                    className="text-destructive mt-1 text-sm"
                  >
                    {feeErrors[feeKey(index, "creditFixedFeeCents")]}
                  </p>
                )}
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
