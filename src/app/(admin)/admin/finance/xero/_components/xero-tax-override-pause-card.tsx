"use client"

import { useEffect, useId, useState } from "react"

import { useClubFormat } from "@/components/club-format-provider"
import {
  AdminForbiddenSaveNotice,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access"
import { formatBookingReference } from "@/lib/booking-reference"
import { formatCents } from "@/lib/utils"
import type { XeroLineTaxMismatch } from "@/lib/xero-line-tax-mismatches"

/**
 * The "GST overrides" card on the Xero page (#5208), served by
 * `/api/admin/xero/tax-override-pause`.
 *
 * New primary invoices carry the club's own GST figure on each line (the
 * journal's, owner decision 18 Nov 2026). When Xero hands back other GST than
 * was sent, the app pauses that and lists the invoices here; until a finance
 * officer checks them in Xero and resumes, Xero works the GST out itself.
 *
 * EVERY FINANCE VIEWER SEES IT; A FINANCE EDITOR RESUMES. `canEdit` is
 * `useAdminAreaEditAccess("finance")`, one `AdminViewOnlySectionBanner` sits at
 * the top, and the resume button is a `ViewOnlyActionButton` with
 * `describeReason={false}`. The route enforces the permission, the tick and the
 * note; this only decides what the screen offers.
 */

type FlaggedInvoice = {
  id: string
  createdAt: string
  bookingId: string
  providerInvoiceId: string
  invoiceNumber: string | null
  documentKind: "CREATE" | "UPDATE"
  lines: XeroLineTaxMismatch[]
}

type PauseView = { invoices: FlaggedInvoice[]; problem: string | null }

const API_PATH = "/api/admin/xero/tax-override-pause"

export function XeroTaxOverridePauseCard() {
  const clubFormat = useClubFormat()
  const [view, setView] = useState<PauseView | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [checked, setChecked] = useState(false)
  const [note, setNote] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [forbiddenSave, setForbiddenSave] = useState(false)
  const checkedId = useId()
  const noteId = useId()

  // Tri-state: `undefined` while the session resolves keeps the button disabled.
  const canEdit = useAdminAreaEditAccess("finance")

  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
      Every finance admin can see which invoices paused the club&apos;s GST figures, but resuming them
      needs finance edit access.
    </AdminViewOnlySectionBanner>
  )

  function load() {
    setLoadFailed(false)
    void fetch(API_PATH)
      .then(async (response) => {
        if (!response.ok) throw new Error("load failed")
        setView((await response.json()) as PauseView)
      })
      .catch(() => setLoadFailed(true))
  }

  useEffect(() => {
    load()
  }, [])

  const money = (cents: number | null) => (cents === null ? "none" : formatCents(cents, clubFormat))
  const paused = (view?.invoices.length ?? 0) > 0
  const readyToResume = paused && checked && note.trim() !== ""

  async function resume() {
    if (canEdit !== true || !view || !readyToResume) return
    setSaving(true)
    setError(null)
    setForbiddenSave(false)
    try {
      const response = await fetch(`${API_PATH}/clear`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: view.invoices.map((invoice) => invoice.id), note: note.trim(), confirmed: true }),
      })
      const payload = (await response.json().catch(() => null)) as (PauseView & { error?: string }) | null
      if (response.status === 403) {
        setForbiddenSave(true)
        return
      }
      if (!response.ok || !payload?.invoices) {
        setError(payload?.error ?? "Could not resume the GST figures.")
        return
      }
      setView({ invoices: payload.invoices, problem: payload.problem })
      setChecked(false)
      setNote("")
    } catch {
      setError("Could not resume the GST figures.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      {viewOnlyBanner}
      <Card className="mb-6" data-testid="xero-tax-override-pause-card">
        <CardHeader>
          <CardTitle headingLevel={2}>GST overrides</CardTitle>
          <CardDescription>
            New invoices send the club&apos;s own GST figure on each line, so Xero&apos;s GST matches the
            club&apos;s records to the cent. If Xero changes it, sending is paused here until finance checks.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loadFailed ? (
            <p className="text-sm text-danger">
              Could not load the GST override status.{" "}
              <Button variant="link" size="sm" className="h-auto p-0" onClick={load}>
                Try again
              </Button>
            </p>
          ) : !view ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : !paused ? (
            <p className="text-sm" data-testid="xero-tax-overrides-on">
              No invoice is flagged. While the club is GST-registered, new booking invoices carry its own GST
              figure on each line.
            </p>
          ) : (
            <>
              <p className="rounded-md border border-danger-6 bg-danger-3 p-3 text-sm text-danger-11" role="alert">
                {view.problem}
              </p>
              <ul className="space-y-3" aria-label="Invoices where Xero changed the GST">
                {view.invoices.map((invoice) => (
                  <li key={invoice.id} className="rounded-md border p-3 text-sm" data-testid="xero-tax-override-invoice">
                    <p className="font-medium">
                      {`Invoice ${invoice.invoiceNumber ?? invoice.providerInvoiceId} (booking ${formatBookingReference(invoice.bookingId)}), `}
                      {invoice.documentKind === "CREATE" ? "when it was raised" : "when it was updated"}
                    </p>
                    <ul className="mt-1 list-disc pl-5">
                      {invoice.lines.map((line) => (
                        <li key={line.index}>
                          {`Line ${line.index + 1}: the app sent ${money(line.sentCents)} GST, Xero holds ${money(line.xeroCents)}`}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
              <div className="space-y-3 rounded-md border border-warning-6 bg-warning-2 p-4">
                <p className="text-sm">
                  Check each invoice in Xero. Resuming does not change or re-send them; it only lets the next new
                  invoices carry the club&apos;s own GST figures again.
                </p>
                <div className="flex items-start gap-2">
                  <Checkbox
                    id={checkedId}
                    checked={checked}
                    disabled={canEdit !== true}
                    onCheckedChange={(value) => setChecked(value === true)}
                  />
                  <Label htmlFor={checkedId} className="text-sm font-normal">
                    I&apos;ve checked these invoices in Xero
                  </Label>
                </div>
                <div className="space-y-1">
                  <Label htmlFor={noteId}>What you found</Label>
                  <Textarea
                    id={noteId}
                    value={note}
                    maxLength={1000}
                    readOnly={canEdit !== true}
                    onChange={(event) => setNote(event.target.value)}
                  />
                </div>
                {error ? <p className="text-sm text-danger">{error}</p> : null}
                {forbiddenSave ? (
                  <AdminForbiddenSaveNotice>
                    Nothing was changed. Resuming needs finance edit access. Refresh the page to see the latest
                    permissions.
                  </AdminForbiddenSaveNotice>
                ) : null}
                <ViewOnlyActionButton
                  canEdit={canEdit}
                  describeReason={false}
                  onClick={() => void resume()}
                  disabled={!readyToResume || saving}
                >
                  {saving ? "Resuming…" : "I've checked these, resume"}
                </ViewOnlyActionButton>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
