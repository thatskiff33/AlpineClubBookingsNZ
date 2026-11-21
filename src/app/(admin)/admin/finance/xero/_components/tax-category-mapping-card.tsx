"use client"

import Link from "next/link"
import { useEffect, useId, useState } from "react"

import { useConfirm } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
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
import { adminHref } from "@/lib/admin-hubs"
import {
  usableXeroTaxCategoryRates,
  type MappedXeroTaxCategory,
  type XeroTaxCategoryKey,
} from "@/lib/xero-tax-categories"
import type { XeroTaxRateOption } from "@/lib/xero-tax-rate-options"

/**
 * The "Tax categories" card (#5209; `INV-CONFIG-008`), shown once Xero is
 * connected on the Xero setup screen's account-mapping step and on the Xero
 * page, served by `/api/admin/xero/tax-categories`.
 *
 * Four club-side categories, each answered by a tax rate in the club's own
 * Xero organisation. Sales tax on income is read-only here: it is the GST / tax
 * treatment card's dated code, never stored twice. The other three are mapped
 * here, one at a time, through the canonical staged edit (Edit -> choose ->
 * Save/Cancel), dirty-gated against the saved code.
 *
 * EVERY FINANCE VIEWER SEES IT; ONLY A FULL ADMIN CHANGES IT, as the GST card:
 * `canEdit` comes from `useFullAdminEditAccess`, one `AdminViewOnlySectionBanner`
 * sits at the top, and every edit affordance is a `ViewOnlyActionButton` with
 * `describeReason={false}`. The server is the enforcement. Each picker offers
 * only what the writer accepts (`usableXeroTaxCategoryRates`).
 */

type CategoryView = {
  key: XeroTaxCategoryKey
  label: string
  description: string
  noSenderYet: string | null
  source: "tax-treatment" | "mapping"
  taxType: string | null
  otherOrganisation: boolean
  problem: string | null
}

type StateView = {
  connected: boolean
  registeredNowOrLater: boolean
  registeredToday: boolean
  categories: CategoryView[]
  rates: XeroTaxRateOption[] | null
}

const API_PATH = "/api/admin/xero/tax-categories"
const GST_CARD_HREF = `${adminHref("xero")}#club-tax-treatment`

function rateName(rates: readonly XeroTaxRateOption[] | null, taxType: string): string {
  const rate = rates?.find((candidate) => candidate.taxType === taxType)
  return rate ? `${taxType} — ${rate.name}` : taxType
}

function CategoryHeading({ category }: { category: CategoryView }) {
  return (
    <div className="space-y-1">
      <p className="font-medium">{category.label}</p>
      <p className="text-muted-foreground">{category.description}</p>
      {category.noSenderYet ? <p className="text-xs text-muted-foreground">{category.noSenderYet}</p> : null}
    </div>
  )
}

function IncomeRow({ category, registeredToday }: { category: CategoryView; registeredToday: boolean }) {
  return (
    <li className="space-y-2 rounded-md border p-3 text-sm" data-testid={`tax-category-${category.key}`}>
      <CategoryHeading category={category} />
      <p>
        {registeredToday && category.taxType
          ? `In use today: Xero code ${category.taxType}. `
          : "Not GST-registered today, so income lines carry no tax. "}
        <Link href={GST_CARD_HREF} className="font-medium underline">
          Change it on the GST / tax treatment card
        </Link>
      </p>
    </li>
  )
}

function CodePicker({
  category,
  options,
  value,
  onChange,
}: {
  category: CategoryView
  options: readonly XeroTaxRateOption[]
  value: string
  onChange: (taxType: string) => void
}) {
  const id = useId()
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{`Xero tax rate for ${category.label}`}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id}>
          <SelectValue placeholder="Choose a tax rate" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.taxType} value={option.taxType}>
              {`${option.taxType} — ${option.name}`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {options.length === 0 ? (
        <p className="text-xs text-muted-foreground">Xero has no active tax rate that suits this category.</p>
      ) : null}
    </div>
  )
}

function MappedRow({
  category,
  rates,
  canEdit,
  editing,
  draft,
  saving,
  anotherRowEditing,
  onEdit,
  onDraftChange,
  onSave,
  onCancel,
  onClear,
}: {
  category: CategoryView & { key: MappedXeroTaxCategory }
  rates: XeroTaxRateOption[] | null
  canEdit: boolean | undefined
  editing: boolean
  draft: string
  saving: boolean
  anotherRowEditing: boolean
  onEdit: () => void
  onDraftChange: (taxType: string) => void
  onSave: () => void
  onCancel: () => void
  onClear: () => void
}) {
  const dirty = draft !== "" && draft !== category.taxType
  return (
    <li className="space-y-2 rounded-md border p-3 text-sm" data-testid={`tax-category-${category.key}`}>
      <CategoryHeading category={category} />
      <p>{category.taxType ? `Mapped to ${rateName(rates, category.taxType)}` : "Not mapped"}</p>
      {category.otherOrganisation ? (
        <p className="text-danger">Mapped in a different Xero organisation from the one connected now. Map it again.</p>
      ) : null}
      {category.problem ? <p className="text-danger">{category.problem}</p> : null}
      {editing ? (
        <div className="space-y-3 border-t pt-3">
          <CodePicker
            category={category}
            options={rates ? usableXeroTaxCategoryRates(rates, category.key) : []}
            value={draft}
            onChange={onDraftChange}
          />
          <div className="flex gap-2">
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              readOnlyReason={ADMIN_FULL_ADMIN_ONLY_ACTION_REASON}
              onClick={onSave}
              disabled={!dirty || saving}
            >
              {saving ? "Saving…" : `Save ${category.label}`}
            </ViewOnlyActionButton>
            <Button variant="outline" onClick={onCancel} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <ViewOnlyActionButton
            canEdit={canEdit}
            describeReason={false}
            readOnlyReason={ADMIN_FULL_ADMIN_ONLY_ACTION_REASON}
            variant="outline"
            size="sm"
            onClick={onEdit}
            disabled={rates === null || anotherRowEditing || saving}
          >
            {`Map ${category.label}`}
          </ViewOnlyActionButton>
          {category.taxType || category.otherOrganisation ? (
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              readOnlyReason={ADMIN_FULL_ADMIN_ONLY_ACTION_REASON}
              variant="outline"
              size="sm"
              onClick={onClear}
              disabled={anotherRowEditing || saving}
            >
              {`Clear ${category.label}`}
            </ViewOnlyActionButton>
          ) : null}
        </div>
      )}
    </li>
  )
}

export function TaxCategoryMappingCard() {
  const [state, setState] = useState<StateView | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [editing, setEditing] = useState<MappedXeroTaxCategory | null>(null)
  const [draft, setDraft] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [forbiddenSave, setForbiddenSave] = useState(false)
  const { confirm, confirmDialog } = useConfirm()
  // Tri-state: `undefined` while the session resolves keeps the buttons disabled.
  const canEdit = useFullAdminEditAccess()

  function load() {
    setLoadFailed(false)
    void fetch(API_PATH)
      .then(async (response) => {
        if (!response.ok) throw new Error("load failed")
        const payload = (await response.json()) as { state: StateView }
        setState(payload.state)
      })
      .catch(() => setLoadFailed(true))
  }

  useEffect(() => {
    load()
  }, [])

  async function send(method: "PUT" | "DELETE", body: object): Promise<boolean> {
    setSaving(true)
    setError(null)
    setForbiddenSave(false)
    try {
      const response = await fetch(API_PATH, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      const payload = (await response.json().catch(() => null)) as { state?: StateView; error?: string } | null
      if (response.status === 403) {
        setForbiddenSave(true)
        return false
      }
      if (!response.ok || !payload?.state) {
        setError(payload?.error ?? "Could not save the tax category.")
        return false
      }
      setState(payload.state)
      return true
    } catch {
      setError("Could not save the tax category.")
      return false
    } finally {
      setSaving(false)
    }
  }

  function startEditing(category: CategoryView) {
    setEditing(category.key as MappedXeroTaxCategory)
    setDraft(category.taxType ?? "")
    setError(null)
    setForbiddenSave(false)
  }

  function cancelEditing() {
    setEditing(null)
    setDraft("")
    setError(null)
  }

  async function save(category: CategoryView) {
    if (canEdit !== true || draft === "" || draft === category.taxType) return
    if (await send("PUT", { category: category.key, taxType: draft })) cancelEditing()
  }

  async function clearMapping(category: CategoryView) {
    if (canEdit !== true) return
    const ok = await confirm({
      title: `Clear the ${category.label} mapping?`,
      description: "While the club is GST-registered, a line in this category will not be sent to Xero until it is mapped again.",
      confirmLabel: "Clear the mapping",
      cancelLabel: "Keep it",
      destructive: true,
    })
    if (ok) await send("DELETE", { category: category.key })
  }

  return (
    <div>
      <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
        Every finance admin can see how the club&apos;s tax categories map to Xero, but changing them needs Full
        Admin — they decide the tax code on lines sent to Xero. Ask a Full Admin if one looks wrong.
      </AdminViewOnlySectionBanner>
      <Card className="mb-6" data-testid="tax-category-mapping-card">
        <CardHeader>
          <CardTitle headingLevel={2}>Tax categories</CardTitle>
          <CardDescription>
            Which of your Xero organisation&apos;s tax rates each of the club&apos;s tax categories uses. A
            GST-registered club&apos;s line in a category that is not mapped is held back, not sent with a guessed code.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loadFailed ? (
            <>
              <p className="text-sm text-danger">Could not load the tax categories.</p>
              <Button variant="outline" onClick={load}>
                Retry
              </Button>
            </>
          ) : !state ? (
            <p className="text-sm text-muted-foreground">Loading the tax categories…</p>
          ) : (
            <>
              {!state.registeredNowOrLater ? (
                <p className="text-sm text-muted-foreground">
                  The club is not GST-registered and has no registration scheduled, so Xero documents carry no tax and no
                  category needs mapping. Mapping one now is kept for if that changes.
                </p>
              ) : null}
              {state.rates === null ? (
                <p className="text-sm text-muted-foreground">
                  Xero&apos;s tax rates could not be read, so a category cannot be mapped until the Xero connection is working.
                </p>
              ) : null}
              <ul className="space-y-2" aria-label="Tax categories">
                {state.categories.map((category) =>
                  category.source === "tax-treatment" ? (
                    <IncomeRow key={category.key} category={category} registeredToday={state.registeredToday} />
                  ) : (
                    <MappedRow
                      key={category.key}
                      category={category as CategoryView & { key: MappedXeroTaxCategory }}
                      rates={state.rates}
                      canEdit={canEdit}
                      editing={editing === category.key}
                      draft={draft}
                      saving={saving}
                      anotherRowEditing={editing !== null && editing !== category.key}
                      onEdit={() => startEditing(category)}
                      onDraftChange={setDraft}
                      onSave={() => void save(category)}
                      onCancel={cancelEditing}
                      onClear={() => void clearMapping(category)}
                    />
                  ),
                )}
              </ul>
              {error ? <p className="text-sm text-danger">{error}</p> : null}
              {forbiddenSave ? (
                <AdminForbiddenSaveNotice>
                  {`Nothing was saved. ${ADMIN_FULL_ADMIN_ONLY_ACTION_REASON} Refresh the page to see the latest permissions.`}
                </AdminForbiddenSaveNotice>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
      {confirmDialog}
    </div>
  )
}
