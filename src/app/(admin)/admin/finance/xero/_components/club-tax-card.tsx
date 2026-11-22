"use client"

import { useEffect, useState } from "react"

import { useConfirm } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  AdminForbiddenSaveNotice,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action"
import {
  ADMIN_FULL_ADMIN_ONLY_ACTION_REASON,
  useFullAdminEditAccess,
} from "@/hooks/use-admin-area-edit-access"
import { isCalendarDate } from "@/lib/club-time"
import { formatBasisPoints, usableXeroTaxRates, type XeroTaxRateOption } from "@/lib/xero-tax-rate-options"

import {
  ClubTaxCardHeader,
  ClubTaxCardLoading,
  ClubTaxChangeAcknowledgement,
  ClubTaxEffectiveDateField,
  ClubTaxTreatmentFields,
} from "./club-tax-card-fields"

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

  // A real calendar day, not just its shape (ALP-580).
  const validDate = isCalendarDate(effectiveFrom)
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

  if (loadFailed || !state) {
    return (
      <ClubTaxCardLoading
        viewOnlyBanner={viewOnlyBanner}
        confirmDialog={confirmDialog}
        loadFailed={loadFailed}
        onRetry={load}
      />
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
      <Card className="mb-6" id="club-tax-treatment" data-testid="club-tax-card">
        <ClubTaxCardHeader />
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
              <ClubTaxTreatmentFields
                registered={registered}
                onRegisteredChange={setRegistered}
                rateText={rateText}
                onRateTextChange={setRateText}
                rateValid={rateValid}
                rateBasisPoints={rateBasisPoints}
                taxType={taxType}
                onTaxTypeChange={setTaxType}
                codeOptions={codeOptions}
              />

              <ClubTaxEffectiveDateField
                earliestChangeDate={state.earliestChangeDate}
                effectiveFrom={effectiveFrom}
                onEffectiveFromChange={setEffectiveFrom}
              />

              <ClubTaxChangeAcknowledgement
                chosenTreatment={describeTreatment(chosen)}
                keepingCount={keepingCount}
                acknowledged={acknowledged}
                onAcknowledgedChange={setAcknowledged}
              />

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
