"use client"

import Link from "next/link"
import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { useScrollToFeedback } from "@/hooks/use-scroll-to-feedback"
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access"
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action"
import { fetchJson } from "./api"
import {
  allHutFeeCellKeys,
  filterHutFeeRateTypes,
  HUT_FEE_FLAT_KEY,
  HUT_FEE_SEASON_TYPES,
  hutFeeCellKey,
  hutFeeCellsForType,
  type HutFeeRateType,
} from "./hut-fee-grid"
import { useClubTime } from "@/components/club-time-provider"
import {
  ACCOUNT_MAPPING_KEYS,
  CREDIT_ITEM_MAPPING_KEYS,
  formatReferenceCacheLabel,
  MAPPING_DESCRIPTIONS,
  MAPPING_LABELS,
  MAPPING_TYPE_FILTER,
  SectionCard,
  type ToggleSection,
} from "./shared"
import type {
  AccountMappingKey,
  AccountMappings,
  CreditItemMappingKey,
  EntranceFeeMap,
  HutFeeMap,
  XeroAccount,
  XeroItem,
  XeroReferenceCacheMeta,
} from "./types"

type AccountsResponse = { accounts?: XeroAccount[]; cache?: XeroReferenceCacheMeta | null }
type ItemsResponse = { items?: XeroItem[]; cache?: XeroReferenceCacheMeta | null }
// The GET/PUT responses still carry the historical amountCents column on
// joining-fee rows; this panel is item-code-only since #1931 (amounts live in
// the JoiningFee schedule), so the amounts are stripped on load and never
// round-tripped in a PUT.
type ItemCodeResponse = {
  hutFees?: HutFeeMap
  entranceFees?: Record<string, { itemCode: string | null; amountCents?: number | null }>
}

function toItemCodeOnly(entranceFees: ItemCodeResponse["entranceFees"]): EntranceFeeMap {
  return Object.fromEntries(
    Object.entries(entranceFees ?? {}).map(([key, value]) => [key, { itemCode: value.itemCode ?? null }]),
  )
}
type MembershipTypesResponse = {
  membershipTypes?: Array<HutFeeRateType & { isActive: boolean }>
}
type AgeTierSettingsResponse = {
  settings?: Array<{ tier: string; label: string; sortOrder: number }>
}

// Bookable age tiers shown as grid columns when the age-tier settings fetch
// yields nothing (mirrors the /admin/seasons editor fallback).
const FALLBACK_AGE_TIERS = [
  { tier: "INFANT", label: "Infant" },
  { tier: "CHILD", label: "Child" },
  { tier: "YOUTH", label: "Youth" },
  { tier: "ADULT", label: "Adult" },
]

export function MappingsPanel({
  connected,
  open,
  onToggle,
  clubName,
}: {
  connected: boolean
  open: boolean
  onToggle: ToggleSection
  clubName: string
}) {
  // The reference-cache freshness stamps are real INSTANTS, read in the club's
  // persisted zone (CT-4, #2870; INV-CONFIG-002).
  const clubTime = useClubTime()
  const [accountMappings, setAccountMappings] = useState<AccountMappings | null>(null)
  const [savedMappings, setSavedMappings] = useState<AccountMappings | null>(null)
  const [chartOfAccounts, setChartOfAccounts] = useState<XeroAccount[]>([])
  const [xeroItems, setXeroItems] = useState<XeroItem[]>([])
  const [accountCacheMeta, setAccountCacheMeta] = useState<XeroReferenceCacheMeta | null>(null)
  const [itemCacheMeta, setItemCacheMeta] = useState<XeroReferenceCacheMeta | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshingReferenceData, setRefreshingReferenceData] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [saved, setSaved] = useState(false)
  const [isEditingMappings, setEditing] = useState(false)
  const [hutFeeItemCodes, setHutFeeItemCodes] = useState<HutFeeMap>({})
  const [savedHutFeeItemCodes, setSavedHutFeeItemCodes] = useState<HutFeeMap>({})
  const [entranceFeeItemCodes, setEntranceFeeItemCodes] = useState<EntranceFeeMap>({})
  const [savedEntranceFeeItemCodes, setSavedEntranceFeeItemCodes] = useState<EntranceFeeMap>({})
  // Grid dimensions (#1930, E4): rows = rate-bearing membership types, columns
  // = age tiers (single FLAT cell for ageGroupsApply=false types).
  const [rateTypes, setRateTypes] = useState<HutFeeRateType[]>([])
  const [ageTiers, setAgeTiers] = useState<Array<{ tier: string; label: string }>>(FALLBACK_AGE_TIERS)
  const panelRef = useRef<HTMLDivElement>(null)
  const errorRef = useRef<HTMLParagraphElement>(null)
  const { scrollToError, scrollToTop } = useScrollToFeedback()
  // Xero account mappings gate on the finance area (write routes enforce
  // finance:edit); a finance:view admin sees them read-only (#1940).
  const canEdit = useAdminAreaEditAccess("finance")

  const fetchMappings = useCallback(async (options?: { forceRefresh?: boolean }) => {
    setLoading(true)
    setError("")
    try {
      const refreshSuffix = options?.forceRefresh ? "?refresh=1" : ""
      const [mappings, accounts, items, itemCodes, membershipTypes, ageTierSettings] = await Promise.all([
        fetchJson<AccountMappings>("/api/admin/xero/account-mappings", undefined, "Failed to load account mappings"),
        fetchJson<AccountsResponse>(`/api/admin/xero/chart-of-accounts${refreshSuffix}`, undefined, "Failed to load Xero accounts"),
        fetchJson<ItemsResponse>(`/api/admin/xero/items${refreshSuffix}`, undefined, "Failed to load Xero items"),
        fetchJson<ItemCodeResponse>("/api/admin/xero/item-code-mappings", undefined, "Failed to load item code mappings"),
        fetchJson<MembershipTypesResponse>("/api/admin/membership-types", undefined, "Failed to load membership types"),
        fetchJson<AgeTierSettingsResponse>("/api/admin/age-tier-settings", undefined, "Failed to load age tiers"),
      ])
      setAccountMappings(mappings)
      setSavedMappings(mappings)
      setChartOfAccounts(accounts.accounts ?? [])
      setAccountCacheMeta(accounts.cache ?? null)
      setXeroItems(items.items ?? [])
      setItemCacheMeta(items.cache ?? null)
      setHutFeeItemCodes(itemCodes.hutFees ?? {})
      setSavedHutFeeItemCodes(itemCodes.hutFees ?? {})
      setEntranceFeeItemCodes(toItemCodeOnly(itemCodes.entranceFees))
      setSavedEntranceFeeItemCodes(toItemCodeOnly(itemCodes.entranceFees))
      setRateTypes(filterHutFeeRateTypes(membershipTypes.membershipTypes ?? []))
      const bookableTierSettings = (ageTierSettings.settings ?? []).filter(
        // NOT_APPLICABLE is the organisation/school classification — never a
        // hut-fee item-code column (#1440).
        (setting) => setting.tier !== "NOT_APPLICABLE",
      )
      if (bookableTierSettings.length > 0) {
        setAgeTiers(
          [...bookableTierSettings]
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map(({ tier, label }) => ({ tier, label })),
        )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load account mappings")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (connected && open && !accountMappings && !loading) void fetchMappings()
  }, [accountMappings, connected, fetchMappings, loading, open])

  useEffect(() => {
    if (error) scrollToError(errorRef)
  }, [error, scrollToError])

  useEffect(() => {
    if (saved) scrollToTop(panelRef)
  }, [saved, scrollToTop])

  const refreshReferenceData = async () => {
    setRefreshingReferenceData(true)
    try {
      await fetchMappings({ forceRefresh: true })
    } finally {
      setRefreshingReferenceData(false)
    }
  }

  const saveMappings = async () => {
    if (!accountMappings) return
    setSaving(true)
    setError("")
    setSaved(false)
    try {
      const savedAccounts = await fetchJson<AccountMappings>(
        "/api/admin/xero/account-mappings",
        { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(accountMappings) },
        "Failed to save mappings"
      )
      const savedItemCodes = await fetchJson<ItemCodeResponse>(
        "/api/admin/xero/item-code-mappings",
        { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hutFees: hutFeeItemCodes, entranceFees: entranceFeeItemCodes }) },
        "Failed to save item code mappings"
      )
      setAccountMappings(savedAccounts)
      setSavedMappings(savedAccounts)
      setHutFeeItemCodes(savedItemCodes.hutFees ?? {})
      setSavedHutFeeItemCodes(savedItemCodes.hutFees ?? {})
      setEntranceFeeItemCodes(toItemCodeOnly(savedItemCodes.entranceFees))
      setSavedEntranceFeeItemCodes(toItemCodeOnly(savedItemCodes.entranceFees))
      setEditing(false)
      setSaved(true)
      window.setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      if (err instanceof Error && /\b403\b|forbidden/i.test(err.message)) {
        setError(ADMIN_FORBIDDEN_SAVE_REASON)
        return
      }
      setError(err instanceof Error ? err.message : "Failed to save mappings")
    } finally {
      setSaving(false)
    }
  }

  const cancelEditing = () => {
    setAccountMappings(savedMappings)
    setHutFeeItemCodes(savedHutFeeItemCodes)
    setEntranceFeeItemCodes(savedEntranceFeeItemCodes)
    setEditing(false)
    setError("")
  }

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It sits OUTSIDE the `SectionCard` — and
    so outside both the `space-y-*` stack and the card's collapsed/expanded
    gate — because `SectionCard` renders its children only while it is open,
    which would otherwise mount the region already-populated.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view the Xero account mappings but cannot change
      them. Finance edit access is required.
    </AdminViewOnlySectionBanner>
  )

  return (
    <div>
      {viewOnlyBanner}
    <SectionCard
      id="xero-section-mappings"
      title="Account Mappings"
      description={`Map ${clubName} booking transactions to Xero accounts and items.`}
      open={open}
      onToggle={(nextOpen) => onToggle("mappings", nextOpen)}
    >
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading accounts...</p>
      ) : (
        <div ref={panelRef} className="space-y-4">
          {error ? (
            <p
              ref={errorRef}
              role="alert"
              tabIndex={-1}
              className="scroll-mt-20 text-sm text-danger focus:outline-none"
            >
              {error}
            </p>
          ) : null}
          {saved ? <p className="text-sm text-success">Account mappings saved.</p> : null}
          <div className="flex flex-col gap-2 rounded-md border border-border bg-muted p-3 text-xs text-muted-foreground md:flex-row md:items-center md:justify-between">
            <div className="space-y-1">
              <p>{formatReferenceCacheLabel(clubTime, "Accounts", accountCacheMeta)}</p>
              <p>{formatReferenceCacheLabel(clubTime, "Items", itemCacheMeta)}</p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => void refreshReferenceData()} disabled={loading || refreshingReferenceData}>
              {refreshingReferenceData ? "Refreshing..." : "Refresh Xero reference data"}
            </Button>
          </div>
          <h4 className="text-sm font-semibold text-foreground">Account Code Mappings</h4>
          {accountMappings ? ACCOUNT_MAPPING_KEYS.map((key) => (
            <AccountMappingRow
              key={key}
              mappingKey={key}
              mappings={accountMappings}
              setMappings={setAccountMappings}
              accounts={chartOfAccounts}
              isEditingMappings={isEditingMappings}
            />
          )) : null}
          <Separator />
          <h4 className="text-sm font-semibold text-foreground">Credit Note Item Codes</h4>
          <p className="text-xs text-muted-foreground">Xero Items for credit note line items. When set, Xero can apply the item configuration while the mapped account remains available for reporting.</p>
          {accountMappings ? CREDIT_ITEM_MAPPING_KEYS.map((key) => (
            <CreditItemRow key={key} mappingKey={key} mappings={accountMappings} setMappings={setAccountMappings} items={xeroItems} isEditingMappings={isEditingMappings} />
          )) : null}
          <Separator />
          <HutFeeTable
            isEditingMappings={isEditingMappings}
            items={xeroItems}
            codes={hutFeeItemCodes}
            setCodes={setHutFeeItemCodes}
            rateTypes={rateTypes}
            ageTiers={ageTiers}
          />
          <Separator />
          <EntranceFeeTable isEditingMappings={isEditingMappings} items={xeroItems} codes={entranceFeeItemCodes} setCodes={setEntranceFeeItemCodes} />
          <div className="flex gap-2 pt-2">
            {isEditingMappings ? (
              <>
                <Button onClick={() => void saveMappings()} disabled={saving || !accountMappings}>{saving ? "Saving..." : "Save Changes"}</Button>
                <Button variant="outline" onClick={cancelEditing} disabled={saving}>Cancel</Button>
              </>
            ) : (
              <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="outline" onClick={() => setEditing(true)}>Edit Mappings</ViewOnlyActionButton>
            )}
          </div>
        </div>
      )}
    </SectionCard>
    </div>
  )
}

function AccountMappingRow({
  mappingKey,
  mappings,
  setMappings,
  accounts,
  isEditingMappings,
}: {
  mappingKey: AccountMappingKey
  mappings: AccountMappings
  setMappings: (value: AccountMappings | null | ((prev: AccountMappings | null) => AccountMappings | null)) => void
  accounts: XeroAccount[]
  isEditingMappings: boolean
}) {
  const typeFilter = MAPPING_TYPE_FILTER[mappingKey]
  const filtered = accounts.filter((account) => account.type === typeFilter)
  const currentCode = mappings[mappingKey]?.code
  const matchedAccount = filtered.find((account) => account.code === currentCode)
  return (
    <div className="grid grid-cols-3 items-start gap-4">
      <div>
        <p className="text-sm font-medium">{MAPPING_LABELS[mappingKey]}</p>
        <p className="text-xs text-muted-foreground">{MAPPING_DESCRIPTIONS[mappingKey]}</p>
      </div>
      <div className="col-span-2">
        {isEditingMappings ? (
          <Select value={currentCode ?? "__none__"} onValueChange={(value) => setMappings((prev) => prev ? { ...prev, [mappingKey]: { ...prev[mappingKey], code: value === "__none__" ? null : value } } : prev)}>
            <SelectTrigger><SelectValue placeholder="Select account..." /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__"><span className="text-muted-foreground">Not configured (use default)</span></SelectItem>
              {filtered.map((account) => <SelectItem key={account.code} value={account.code}>{account.code} - {account.name}</SelectItem>)}
              {filtered.length === 0 ? <SelectItem value="__empty__" disabled>No {typeFilter.toLowerCase()} accounts found</SelectItem> : null}
            </SelectContent>
          </Select>
        ) : (
          <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm">{matchedAccount ? `${matchedAccount.code} - ${matchedAccount.name}` : currentCode || <span className="text-muted-foreground">Not configured (using default)</span>}</p>
        )}
      </div>
    </div>
  )
}

function CreditItemRow({
  mappingKey,
  mappings,
  setMappings,
  items,
  isEditingMappings,
}: {
  mappingKey: CreditItemMappingKey
  mappings: AccountMappings
  setMappings: (value: AccountMappings | null | ((prev: AccountMappings | null) => AccountMappings | null)) => void
  items: XeroItem[]
  isEditingMappings: boolean
}) {
  const currentItemCode = mappings[mappingKey]?.itemCode
  const matchedItem = items.find((item) => item.code === currentItemCode)
  return (
    <div className="grid grid-cols-3 items-start gap-4">
      <div>
        <p className="text-sm font-medium">{MAPPING_LABELS[mappingKey]}</p>
        <p className="text-xs text-muted-foreground">{MAPPING_DESCRIPTIONS[mappingKey]}</p>
      </div>
      <div className="col-span-2">
        {isEditingMappings ? (
          <Select value={currentItemCode ?? "__none__"} onValueChange={(value) => setMappings((prev) => prev ? { ...prev, [mappingKey]: { ...prev[mappingKey], itemCode: value === "__none__" ? null : value } } : prev)}>
            <SelectTrigger><SelectValue placeholder="Select item..." /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__"><span className="text-muted-foreground">Not configured</span></SelectItem>
              {items.map((item) => <SelectItem key={item.code} value={item.code}>{item.code} - {item.name}</SelectItem>)}
            </SelectContent>
          </Select>
        ) : (
          <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm">{matchedItem ? `${matchedItem.code} - ${matchedItem.name}` : currentItemCode || <span className="text-muted-foreground">Not configured</span>}</p>
        )}
      </div>
    </div>
  )
}

function HutFeeTable({
  isEditingMappings,
  items,
  codes,
  setCodes,
  rateTypes,
  ageTiers,
}: {
  isEditingMappings: boolean
  items: XeroItem[]
  codes: HutFeeMap
  setCodes: (value: HutFeeMap | ((prev: HutFeeMap) => HutFeeMap)) => void
  rateTypes: HutFeeRateType[]
  ageTiers: Array<{ tier: string; label: string }>
}) {
  const tierValues = ageTiers.map((t) => t.tier)
  const renderCell = (mapKey: string) => {
    const currentCode = codes[mapKey]?.itemCode ?? null
    const matchedItem = items.find((item) => item.code === currentCode)
    return isEditingMappings ? (
      <ItemSelect currentCode={currentCode} items={items} onChange={(value) => setCodes((prev) => updateHutFeeMap(prev, mapKey, value))} />
    ) : (
      <span className={currentCode ? "text-foreground" : "text-muted-foreground"}>{matchedItem?.code ?? currentCode ?? "Not set"}</span>
    )
  }
  return (
    <>
      <h4 className="text-sm font-semibold text-foreground">Hut Fee Item Codes</h4>
      <p className="text-xs text-muted-foreground">
        Map each membership type, season, and age group to a Xero Item. Types
        without age groups have a single flat (all ages) cell. Only rate-bearing
        membership types are listed — types that price from the non-member rate
        follow the Non-Member row.
      </p>
      {isEditingMappings ? (
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => {
            if (items.length === 0) return
            const filled: HutFeeMap = {}
            for (const key of allHutFeeCellKeys(rateTypes, tierValues)) filled[key] = { itemCode: items[0].code }
            setCodes(filled)
          }}>Copy first item to all</Button>
          <Button variant="outline" size="sm" onClick={() => setCodes({})}>Clear all</Button>
        </div>
      ) : null}
      {rateTypes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No rate-bearing membership types found. Configure membership types first.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                {["Membership Type", "Season", ...ageTiers.map((t) => t.label)].map((heading) => (
                  <th key={heading} className="border-b p-2 text-left font-medium text-muted-foreground">{heading}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rateTypes.flatMap((type) =>
                HUT_FEE_SEASON_TYPES.map((season, seasonIndex) => (
                  <tr key={`${type.id}_${season}`} className="border-b last:border-0">
                    {seasonIndex === 0 ? (
                      <td className="p-2 align-top font-medium text-foreground" rowSpan={HUT_FEE_SEASON_TYPES.length}>
                        {type.name}
                        {!type.ageGroupsApply ? <span className="block text-xs font-normal text-muted-foreground">Flat rate (all ages)</span> : null}
                      </td>
                    ) : null}
                    <td className="p-2 text-muted-foreground">{season === "WINTER" ? "Winter" : "Summer"}</td>
                    {hutFeeCellsForType(type, tierValues).map((cell) => (
                      <td
                        key={cell}
                        className="p-2"
                        colSpan={cell === HUT_FEE_FLAT_KEY ? ageTiers.length : 1}
                      >
                        {renderCell(hutFeeCellKey(type.id, season, cell))}
                      </td>
                    ))}
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

// Item-code-only since #1931 (E5): joining-fee AMOUNTS live in the JoiningFee
// schedule (fee configuration page) — the amountCents column on these mapping
// rows is no longer read at runtime, so an editable amount here would accept a
// change that silently has no effect (the wrong-fee trap).
function EntranceFeeTable({ isEditingMappings, items, codes, setCodes }: { isEditingMappings: boolean; items: XeroItem[]; codes: EntranceFeeMap; setCodes: (value: EntranceFeeMap | ((prev: EntranceFeeMap) => EntranceFeeMap)) => void }) {
  return (
    <>
      <h4 className="text-sm font-semibold text-foreground">Joining Fee Categories</h4>
      <p className="text-xs text-muted-foreground">
        Map each joining fee category to a Xero Item. Joining fee <strong>amounts</strong> are
        not configured here — they are managed per membership type on the{" "}
        <Link href="/admin/fee-configuration" className="underline underline-offset-2">fee configuration</Link> page.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead><tr>{["Category", "Xero Item"].map((heading) => <th key={heading} className="border-b p-2 text-left font-medium text-muted-foreground">{heading}</th>)}</tr></thead>
          <tbody>
            {([{ key: "ADULT", label: "Adult" }, { key: "YOUTH", label: "Youth" }, { key: "CHILD", label: "Child" }, { key: "FAMILY", label: "Family" }] as const).map(({ key, label }) => {
              const currentCode = codes[key]?.itemCode ?? null
              const matchedItem = items.find((item) => item.code === currentCode)
              return (
                <tr key={key} className="border-b last:border-0">
                  <td className="p-2 font-medium text-foreground">{label}</td>
                  <td className="p-2">{isEditingMappings ? <ItemSelect currentCode={currentCode} items={items} onChange={(value) => setCodes((prev) => updateEntranceItem(prev, key, value))} /> : <span className={currentCode ? "text-foreground" : "text-muted-foreground"}>{matchedItem ? matchedItem.code : currentCode || "Not set"}</span>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}

function ItemSelect({ currentCode, items, onChange }: { currentCode: string | null; items: XeroItem[]; onChange: (value: string) => void }) {
  return (
    <Select value={currentCode ?? "__none__"} onValueChange={onChange}>
      <SelectTrigger className="w-full min-w-[140px]"><SelectValue placeholder="Not set" /></SelectTrigger>
      <SelectContent>
        <SelectItem value="__none__"><span className="text-muted-foreground">Not set</span></SelectItem>
        {items.map((item) => <SelectItem key={item.code} value={item.code}>{item.code} - {item.name}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}

function updateHutFeeMap(prev: HutFeeMap, mapKey: string, value: string): HutFeeMap {
  const next = { ...prev }
  if (value === "__none__") delete next[mapKey]
  else next[mapKey] = { itemCode: value }
  return next
}

function updateEntranceItem(prev: EntranceFeeMap, key: string, value: string): EntranceFeeMap {
  const next = { ...prev }
  if (value === "__none__") {
    if (next[key]) next[key] = { itemCode: null }
  } else {
    next[key] = { itemCode: value }
  }
  return next
}
