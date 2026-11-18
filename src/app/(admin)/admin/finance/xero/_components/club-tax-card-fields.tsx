"use client"

import { useId, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { formatBasisPoints, type XeroTaxRateOption } from "@/lib/xero-tax-rate-options"

/**
 * The presentational pieces of the "GST / tax treatment" card (#4632), split
 * out of `club-tax-card.tsx` so its one component stays within the function
 * size budget (#4927). Nothing here decides permission or saves anything: every
 * edit affordance, the view-only banner and the staged-edit state stay in
 * `ClubTaxCard`, which passes these pieces their values and setters. None of
 * them renders a `ViewOnlyActionButton`, so the banner contract's same-file
 * rule is untouched.
 */

/** The card's title and description, shared by the loading and loaded states. */
export function ClubTaxCardHeader() {
  return (
    <CardHeader>
      <CardTitle headingLevel={2}>GST / tax treatment</CardTitle>
      <CardDescription>
        How the club&apos;s prices are taxed on Xero documents and in the member-money journal. Prices
        members pay never change; only how much of each price is GST does.
      </CardDescription>
    </CardHeader>
  )
}

/** The card while the schedule loads, or after the load failed. */
export function ClubTaxCardLoading({
  viewOnlyBanner,
  confirmDialog,
  loadFailed,
  onRetry,
}: {
  viewOnlyBanner: ReactNode
  confirmDialog: ReactNode
  loadFailed: boolean
  onRetry: () => void
}) {
  return (
    <div>
      {viewOnlyBanner}
      <Card className="mb-6">
        <ClubTaxCardHeader />
        <CardContent className="space-y-3">
          {loadFailed ? (
            <>
              <p className="text-sm text-danger">Could not load the club&apos;s tax treatment.</p>
              <Button variant="outline" onClick={onRetry}>
                Retry
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Loading the club&apos;s tax treatment…</p>
          )}
        </CardContent>
      </Card>
      {confirmDialog}
    </div>
  )
}

/** Registered, rate and Xero code: the treatment a new period would carry. */
export function ClubTaxTreatmentFields({
  registered,
  onRegisteredChange,
  rateText,
  onRateTextChange,
  rateValid,
  rateBasisPoints,
  taxType,
  onTaxTypeChange,
  codeOptions,
}: {
  registered: boolean
  onRegisteredChange: (registered: boolean) => void
  rateText: string
  onRateTextChange: (text: string) => void
  rateValid: boolean
  rateBasisPoints: number
  taxType: string
  onTaxTypeChange: (taxType: string) => void
  codeOptions: readonly XeroTaxRateOption[]
}) {
  const registeredId = useId()
  const rateId = useId()
  const codeId = useId()

  return (
    <>
      <div className="flex items-center gap-2">
        <Checkbox id={registeredId} checked={registered} onCheckedChange={(checked) => onRegisteredChange(checked)} />
        <Label htmlFor={registeredId}>The club is GST-registered</Label>
      </div>

      {registered ? (
        <>
          <div className="space-y-2">
            <Label htmlFor={rateId}>GST rate, in basis points</Label>
            <Input
              id={rateId}
              inputMode="numeric"
              value={rateText}
              onChange={(event) => {
                onRateTextChange(event.target.value)
                onTaxTypeChange("")
              }}
            />
            <p className="text-xs text-muted-foreground">
              Hundredths of a percent: 1500 is 15%.
              {rateValid && rateText.trim() !== "" ? ` This is ${formatBasisPoints(rateBasisPoints)}.` : null}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor={codeId}>Xero tax code</Label>
            <Select value={taxType} onValueChange={onTaxTypeChange}>
              <SelectTrigger id={codeId}>
                <SelectValue placeholder="Choose a code" />
              </SelectTrigger>
              <SelectContent>
                {/* The chosen code is always offered, so the select never shows a code the form is not on. */}
                {taxType !== "" && !codeOptions.some((option) => option.taxType === taxType) ? (
                  <SelectItem value={taxType}>{`${taxType} — not usable at this rate in Xero`}</SelectItem>
                ) : null}
                {codeOptions.map((option) => (
                  <SelectItem key={option.taxType} value={option.taxType}>
                    {`${option.taxType} — ${option.name}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Only Xero&apos;s active rates that can be used on income at the rate above are offered.
              {codeOptions.length === 0 ? " Xero has none at this rate." : null}
            </p>
          </div>
        </>
      ) : null}
    </>
  )
}

/** The date a new period starts, tomorrow (club time) at the earliest. */
export function ClubTaxEffectiveDateField({
  earliestChangeDate,
  effectiveFrom,
  onEffectiveFromChange,
}: {
  earliestChangeDate: string
  effectiveFrom: string
  onEffectiveFromChange: (date: string) => void
}) {
  const dateId = useId()

  return (
    <div className="space-y-2">
      <Label htmlFor={dateId}>Takes effect from</Label>
      <Input
        id={dateId}
        type="date"
        min={earliestChangeDate}
        value={effectiveFrom}
        onChange={(event) => onEffectiveFromChange(event.target.value)}
      />
      <p className="text-xs text-muted-foreground">
        {`${earliestChangeDate} at the earliest. A date that has started cannot change.`}
      </p>
    </div>
  )
}

/**
 * What the change does and does not do, and the confirmation tick the API
 * requires. `keepingCount` is the number of bookings already made with a night
 * on or after the date, or null while unknown.
 */
export function ClubTaxChangeAcknowledgement({
  chosenTreatment,
  keepingCount,
  acknowledged,
  onAcknowledgedChange,
}: {
  chosenTreatment: string
  keepingCount: number | null
  acknowledged: boolean
  onAcknowledgedChange: (acknowledged: boolean) => void
}) {
  const acknowledgeId = useId()

  return (
    <div className="space-y-3 rounded-md border border-warning-6 bg-warning-2 p-4">
      <p className="text-sm font-semibold">What this changes, and what it does not</p>
      <ul className="list-disc space-y-1 pl-5 text-sm">
        <li>
          Bookings, subscriptions and entrance fees made on or after the date go to Xero and the
          journal as: {chosenTreatment}.
        </li>
        <li data-testid="club-tax-keeping-count">
          {keepingCount === null
            ? "Bookings already made keep the treatment they were made under for their whole life, including later edits, credit notes and refunds."
            : `${keepingCount} booking${keepingCount === 1 ? "" : "s"} already made ha${keepingCount === 1 ? "s" : "ve"} a night on or after this date. They keep the current treatment for their whole life, including later edits, credit notes and refunds; adjust them in Xero by hand if needed.`}
        </li>
        <li>Nothing already sent to Xero or posted in the journal changes, and no price changes.</li>
      </ul>
      <div className="flex items-start gap-2">
        <Checkbox
          id={acknowledgeId}
          checked={acknowledged}
          onCheckedChange={(checked) => onAcknowledgedChange(checked)}
        />
        <Label htmlFor={acknowledgeId} className="text-sm font-normal">
          I understand that this changes the GST on every new Xero document and journal entry from
          this date, and that bookings already made keep their current treatment.
        </Label>
      </div>
    </div>
  )
}
