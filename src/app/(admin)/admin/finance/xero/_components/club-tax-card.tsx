"use client"

import { useEffect, useId, useState } from "react"

import { useConfirm } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  AdminForbiddenSaveNotice,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action"
import {
  ADMIN_FULL_ADMIN_ONLY_ACTION_REASON,
  useFullAdminEditAccess,
} from "@/hooks/use-admin-area-edit-access"
import { formatBasisPoints, usableXeroTaxRates, type XeroTaxRateOption } from "@/lib/xero-tax-rate-options"

/**
 * The "GST / tax treatment" card on the Xero page (#4632; `INV-CONFIG-007`),
 * served by `/api/admin/club-tax`.
 *
 * EVERY FINANCE VIEWER SEES IT; ONLY A FULL ADMIN CHANGES IT (the #3596
 * precedent, the `ClubFormatPanel` shape): `canEdit` comes from
 * `useFullAdminEditAccess`, one `AdminViewOnlySectionBanner` sits at the top,
 * and every edit affordance is a `ViewOnlyActionButton` with
 * `describeReason={false}`. The server is the enforcement; this only decides
 * what the screen offers.
 *
 * A CHANGE IS A NEW DATED PERIOD, never an edit of one. The schedule is history:
 * documents already sent to Xero and journal legs already posted were rendered
 * under the periods shown, and a booking made before a change keeps the old
 * treatment for its whole life (owner decision A). So the staged edit (Edit ->
 * choose -> acknowledge -> Save) schedules a period from tomorrow at the
 * earliest, and only a period that has not started can be cancelled. The
 * acknowledgement is not decoration: the API refuses an unconfirmed change.
 *
 * THE DIRTY GATE compares the choice with the period it would follow; the
 * writer refuses the same "unchanged" save, so a caller that skips this card
 * gets the same answer.
 */

type ClubTaxPeriodView = {
  gstRegistered: boolean
  taxRateBasisPoints: number
  xeroTaxType: string | null
  effectiveFrom: string
  status: "past" | "current" | "scheduled"
}

type ClubTaxStateView = {
  periods: ClubTaxPeriodView[]
  earliestChangeDate: string
  xeroRevenueRates: XeroTaxRateOption[] | null
}

const API_PATH = "/api/admin/club-tax"

const STATUS_LABEL: Record<ClubTaxPeriodView["status"], string> = {
  past: "Ended",
  current: "In force",
  scheduled: "Scheduled",
}

function describeTreatment(period: Pick<ClubTaxPeriodView, "gstRegistered" | "taxRateBasisPoints" | "xeroTaxType">): string {
  if (!period.gstRegistered) return "Not GST-registered — no tax on Xero documents"
  return `GST-registered at ${formatBasisPoints(period.taxRateBasisPoints)}, prices include GST, Xero code ${period.xeroTaxType ?? "(none)"}`
}

/**
 * The period a change starting on `date` would follow: the last one starting
 * before it. Calendar dates compare as strings; the server's own answer is
 * `clubTaxPeriodOn`, which the writer's "unchanged" refusal uses.
 */
function periodBefore(periods: readonly ClubTaxPeriodView[], date: string): ClubTaxPeriodView | null {
  return periods.filter((period) => period.effectiveFrom < date).at(-1) ?? null
}

export function ClubTaxCard() {
  const [state, setState] = useState<ClubTaxStateView | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [editing, setEditing] = useState(false)
  const [registered, setRegistered] = useState(true)
  const [rateText, setRateText] = useState("")
  const [taxType, setTaxType] = useState("")
  const [effectiveFrom, setEffectiveFrom] = useState("")
  const [acknowledged, setAcknowledged] = useState(false)
  const [keepingCount, setKeepingCount] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [forbiddenSave, setForbiddenSave] = useState(false)
  const { confirm, confirmDialog } = useConfirm()

  const registeredId = useId()
  const rateId = useId()
  const codeId = useId()
  const dateId = useId()
  const acknowledgeId = useId()

  // Tri-state: `undefined` while the session resolves keeps the buttons disabled.
  const canEdit = useFullAdminEditAccess()

  // Hoisted and rendered first in every branch, as in `ClubFormatPanel`, so the live region exists from first paint.
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
      Every finance admin can see how the club is taxed, but changing it needs
      Full Admin — it decides the GST on every new Xero document and journal
      entry. Ask a Full Admin if it looks wrong.
    </AdminViewOnlySectionBanner>
  )

  function load() {
    setLoadFailed(false)
    void fetch(API_PATH)
      .then(async (response) => {
        if (!response.ok) throw new Error("load failed")
        const payload = (await response.json()) as { state: ClubTaxStateView }
        setState(payload.state)
      })
      .catch(() => setLoadFailed(true))
  }

  useEffect(() => {
    load()
  }, [])

  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)
  // How many bookings a change from the chosen date leaves on the old treatment, read outside any transaction.
  useEffect(() => {
    if (!editing || !validDate) {
      setKeepingCount(null)
      return
    }
    let cancelled = false
    void fetch(`${API_PATH}?from=${encodeURIComponent(effectiveFrom)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("count failed")
        const payload = (await response.json()) as { keepingOldTreatment: number | null }
        if (!cancelled) setKeepingCount(payload.keepingOldTreatment)
      })
      .catch(() => {
        if (!cancelled) setKeepingCount(null)
      })
    return () => {
      cancelled = true
    }
  }, [editing, validDate, effectiveFrom])

  const header = (
    <CardHeader>
      <CardTitle>GST / tax treatment</CardTitle>
      <CardDescription>
        How the club&apos;s prices are taxed on Xero documents and in the member-money journal. Prices
        members pay never change; only how much of each price is GST does.
      </CardDescription>
    </CardHeader>
  )

  if (loadFailed || !state) {
    return (
      <div>
        {viewOnlyBanner}
        <Card className="mb-6">
          {header}
          <CardContent className="space-y-3">
            {loadFailed ? (
              <>
                <p className="text-sm text-danger">Could not load the club&apos;s tax treatment.</p>
                <Button variant="outline" onClick={load}>
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

  const rateBasisPoints = registered ? Number(rateText) : 0
  const rateValid = !registered || (rateText.trim() !== "" && Number.isInteger(rateBasisPoints) && rateBasisPoints >= 0)
  const codeOptions = state.xeroRevenueRates && rateValid ? usableXeroTaxRates(state.xeroRevenueRates, rateBasisPoints) : []
  const chosen = {
    gstRegistered: registered,
    taxRateBasisPoints: rateBasisPoints,
    xeroTaxType: registered ? taxType || null : null,
  }
  const before = validDate ? periodBefore(state.periods, effectiveFrom) : null
  const unchanged =
    before !== null &&
    before.gstRegistered === chosen.gstRegistered &&
    before.taxRateBasisPoints === chosen.taxRateBasisPoints &&
    before.xeroTaxType === chosen.xeroTaxType
  const tooEarly = validDate && effectiveFrom < state.earliestChangeDate
  const complete = validDate && !tooEarly && rateValid && (!registered || taxType !== "")
  const readyToSave = complete && acknowledged && !unchanged

  function startEditing() {
    // Start from the treatment the earliest change would follow, so an untouched form is the dirty gate's "unchanged".
    const inForce = state ? periodBefore(state.periods, state.earliestChangeDate) : null
    setRegistered(inForce?.gstRegistered ?? true)
    setRateText(String(inForce?.taxRateBasisPoints ?? ""))
    setTaxType(inForce?.xeroTaxType ?? "")
    setEffectiveFrom(state?.earliestChangeDate ?? "")
    setAcknowledged(false)
    setError(null)
    setForbiddenSave(false)
    setEditing(true)
  }

  function cancelEditing() {
    setEditing(false)
    setAcknowledged(false)
    setError(null)
    setForbiddenSave(false)
  }

  async function send(method: "PUT" | "DELETE", body: object): Promise<boolean> {
    setSaving(true)
    setError(null)
    setForbiddenSave(false)
    try {
      const response = await fetch(API_PATH, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, confirmed: true }),
      })
      const payload = (await response.json().catch(() => null)) as { state?: ClubTaxStateView; error?: string } | null
      if (response.status === 403) {
        setForbiddenSave(true)
        return false
      }
      if (!response.ok || !payload?.state) {
        setError(payload?.error ?? "Could not save the club's tax treatment.")
        return false
      }
      setState(payload.state)
      return true
    } catch {
      setError("Could not save the club's tax treatment.")
      return false
    } finally {
      setSaving(false)
    }
  }

  async function save() {
    if (canEdit !== true || !readyToSave) return
    if (await send("PUT", { ...chosen, effectiveFrom })) cancelEditing()
  }

  async function cancelScheduled(period: ClubTaxPeriodView) {
    if (canEdit !== true) return
    const ok = await confirm({
      title: "Cancel this scheduled change?",
      description: `The change from ${period.effectiveFrom} (${describeTreatment(period)}) will not happen.`,
      confirmLabel: "Cancel the change",
      cancelLabel: "Keep it",
      destructive: true,
    })
    if (ok) await send("DELETE", { effectiveFrom: period.effectiveFrom })
  }

  return (
    <div>
      {viewOnlyBanner}
      <Card className="mb-6" data-testid="club-tax-card">
        {header}
        <CardContent className="space-y-6">
          <ul className="space-y-2" aria-label="Tax treatment periods">
            {state.periods.map((period) => (
              <li
                key={period.effectiveFrom}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"
                data-testid={`club-tax-period-${period.status}`}
              >
                <span>
                  <span className="font-medium">{STATUS_LABEL[period.status]}</span>
                  {` from ${period.effectiveFrom}: ${describeTreatment(period)}`}
                </span>
                {period.status === "scheduled" && !editing ? (
                  <ViewOnlyActionButton
                    canEdit={canEdit}
                    describeReason={false}
                    readOnlyReason={ADMIN_FULL_ADMIN_ONLY_ACTION_REASON}
                    variant="outline"
                    size="sm"
                    onClick={() => void cancelScheduled(period)}
                    disabled={saving}
                  >
                    Cancel this change
                  </ViewOnlyActionButton>
                ) : null}
              </li>
            ))}
          </ul>

          {state.xeroRevenueRates === null ? (
            <p className="text-sm text-muted-foreground">
              Xero&apos;s tax rates could not be read, so a GST-registered change cannot be checked or saved
              until the Xero connection is working.
            </p>
          ) : null}

          {!editing ? (
            <>
              {error ? <p className="text-sm text-danger">{error}</p> : null}
              {forbiddenSave ? (
                <AdminForbiddenSaveNotice>
                  {`Nothing was saved. ${ADMIN_FULL_ADMIN_ONLY_ACTION_REASON} Refresh the page to see the latest permissions.`}
                </AdminForbiddenSaveNotice>
              ) : null}
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={false}
                readOnlyReason={ADMIN_FULL_ADMIN_ONLY_ACTION_REASON}
                onClick={startEditing}
              >
                Schedule a change
              </ViewOnlyActionButton>
            </>
          ) : (
            <div className="space-y-4 border-t pt-4">
              <div className="flex items-center gap-2">
                <Checkbox id={registeredId} checked={registered} onCheckedChange={(checked) => setRegistered(checked)} />
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
                        setRateText(event.target.value)
                        setTaxType("")
                      }}
                    />
                    <p className="text-xs text-muted-foreground">
                      Hundredths of a percent: 1500 is 15%.
                      {rateValid && rateText.trim() !== "" ? ` This is ${formatBasisPoints(rateBasisPoints)}.` : null}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={codeId}>Xero tax code</Label>
                    <Select value={taxType} onValueChange={setTaxType}>
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

              <div className="space-y-2">
                <Label htmlFor={dateId}>Takes effect from</Label>
                <Input
                  id={dateId}
                  type="date"
                  min={state.earliestChangeDate}
                  value={effectiveFrom}
                  onChange={(event) => setEffectiveFrom(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {`${state.earliestChangeDate} at the earliest. A date that has started cannot change.`}
                </p>
              </div>

              <div className="space-y-3 rounded-md border border-warning-6 bg-warning-2 p-4">
                <p className="text-sm font-semibold">What this changes, and what it does not</p>
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  <li>
                    Bookings, subscriptions and entrance fees made on or after the date go to Xero and the
                    journal as: {describeTreatment(chosen)}.
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
                    onCheckedChange={(checked) => setAcknowledged(checked)}
                  />
                  <Label htmlFor={acknowledgeId} className="text-sm font-normal">
                    I understand that this changes the GST on every new Xero document and journal entry from
                    this date, and that bookings already made keep their current treatment.
                  </Label>
                </div>
              </div>

              {unchanged ? (
                <p className="text-sm text-muted-foreground">
                  That is already the club&apos;s treatment on that date. Choose something different to save a change.
                </p>
              ) : null}
              {tooEarly ? (
                <p className="text-sm text-danger">{`A change can start on ${state.earliestChangeDate} at the earliest.`}</p>
              ) : null}
              {error ? <p className="text-sm text-danger">{error}</p> : null}
              {forbiddenSave ? (
                <AdminForbiddenSaveNotice>
                  {`Nothing was saved. ${ADMIN_FULL_ADMIN_ONLY_ACTION_REASON} Refresh the page to see the latest permissions.`}
                </AdminForbiddenSaveNotice>
              ) : null}

              <div className="flex gap-2">
                <ViewOnlyActionButton
                  canEdit={canEdit}
                  describeReason={false}
                  readOnlyReason={ADMIN_FULL_ADMIN_ONLY_ACTION_REASON}
                  onClick={() => void save()}
                  disabled={!readyToSave || saving}
                >
                  {saving ? "Saving…" : "Save tax change"}
                </ViewOnlyActionButton>
                <Button variant="outline" onClick={cancelEditing} disabled={saving}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      {confirmDialog}
    </div>
  )
}
