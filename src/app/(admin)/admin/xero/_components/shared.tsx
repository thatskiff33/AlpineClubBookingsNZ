"use client"

import { useState, type HTMLAttributes, type ReactNode } from "react"
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock,
  Loader2,
  MinusCircle,
  XCircle,
  type LucideIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { buildHrefWithReturnTo } from "@/lib/internal-return-path"
import { buildXeroContactUrl } from "@/lib/xero-links"
import { parseInstant, type BoundClubTime } from "@/lib/club-time"
import { formatRedactedJson } from "@/lib/redact-sensitive-json"
import { cn } from "@/lib/utils"
import { CHIP_TONE_CLASSES, type SemanticTone } from "@/lib/chip-tones"
import type {
  AccountMappingKey,
  CreditItemMappingKey,
  SectionKey,
  SyncReport,
  XeroOperation,
  XeroReferenceCacheMeta,
} from "./types"

export type ToggleSection = (section: SectionKey, nextOpen: boolean) => void

export function SectionCard({
  id,
  title,
  description,
  open,
  onToggle,
  actions,
  children,
}: {
  id: string
  title: string
  description: string
  open: boolean
  onToggle: (nextOpen: boolean) => void
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <Card id={id} className="mb-6 scroll-mt-24">
      <CardHeader className="gap-4 md:flex-row md:items-start md:justify-between">
        <button
          type="button"
          onClick={() => onToggle(!open)}
          aria-expanded={open}
          className="flex w-full items-start justify-between gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:flex-1"
        >
          <div className="space-y-1">
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          {open ? (
            <ChevronDown aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          )}
        </button>
        {actions ? (
          <div className="flex shrink-0 items-center gap-2" onClick={(event) => event.stopPropagation()}>
            {actions}
          </div>
        ) : null}
      </CardHeader>
      {open ? <CardContent>{children}</CardContent> : null}
    </Card>
  )
}

export function FilterSelect({
  label,
  value,
  values,
  labels,
  onValueChange,
}: {
  label: string
  value: string
  values: string[]
  labels?: Record<string, string>
  onValueChange: (value: string) => void
}) {
  return (
    <div className="w-full md:w-48">
      <Label className="mb-1 block text-xs text-muted-foreground">{label}</Label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {values.map((item) => (
            <SelectItem key={item} value={item}>
              {labels?.[item] ?? (item === "all" ? `All ${label.toLowerCase()}s` : item)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

export function HealthStatCard({
  label,
  value,
  subtitle,
  badge,
  href,
  onClick,
}: {
  label: string
  value: ReactNode
  subtitle: string
  badge?: ReactNode
  href?: string
  onClick?: () => void
}) {
  const className =
    "flex h-full flex-col rounded-xl border bg-card p-4 text-left shadow-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  const content = (
    <>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
          <div className="mt-2 break-words text-2xl font-semibold leading-tight">{value}</div>
        </div>
        {badge ? <div className="max-w-full shrink-0 [&>*]:whitespace-normal [&>*]:text-center">{badge}</div> : null}
      </div>
      <p className="mt-4 text-sm leading-5 text-muted-foreground">{subtitle}</p>
    </>
  )
  if (href) return <a href={href} className={className}>{content}</a>
  if (onClick) return <button type="button" onClick={onClick} className={`${className} w-full`}>{content}</button>
  return <div className={className}>{content}</div>
}

// Restrained Alpine (#1800/#1813): Xero operation & health statuses render as
// icon + label chips in one of five semantic, dark-adapting tones — never colour
// alone. StatusChip's typed `kind` API only covers domain enums
// (booking/payment/…), so per the epic these Xero-specific statuses reuse the
// SAME tone → token mapping rather than inventing a new StatusChip kind.
// Xero's non-domain statuses map onto the SAME five semantic tones as every
// other chip, so the tone -> chip-class map is the shared one from
// `@/lib/chip-tones` (#156) rather than a private copy that could drift.
export type XeroTone = SemanticTone

// Solid tone fills for meters / progress-bar fills (no text sits on these).
const XERO_TONE_SOLID_CLASSES: Record<XeroTone, string> = {
  neutral: "bg-muted-foreground",
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
}

export function toneFillClass(tone: XeroTone) {
  return XERO_TONE_SOLID_CLASSES[tone]
}

const TONE_ICON: Record<XeroTone, LucideIcon> = {
  neutral: MinusCircle,
  info: Circle,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: AlertTriangle,
}

/** Shared icon + label chip for every non-domain Xero status. */
export function ToneChip({
  tone,
  icon: Icon,
  children,
  className,
  ...props
}: {
  tone: XeroTone
  icon: LucideIcon
  children: ReactNode
} & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      data-slot="xero-status-chip"
      data-tone={tone}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        CHIP_TONE_CLASSES[tone],
        className,
      )}
      {...props}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span>{children}</span>
    </span>
  )
}

const OPERATION_STATUS_META: Record<string, { tone: XeroTone; icon: LucideIcon }> = {
  SUCCEEDED: { tone: "success", icon: CheckCircle2 },
  PROCESSED: { tone: "success", icon: CheckCircle2 },
  PARTIAL: { tone: "warning", icon: AlertTriangle },
  FAILED: { tone: "danger", icon: XCircle },
  RUNNING: { tone: "info", icon: Loader2 },
  PROCESSING: { tone: "info", icon: Loader2 },
  PENDING: { tone: "neutral", icon: Clock },
  WAITING_PAYMENT: { tone: "neutral", icon: Clock },
  RECEIVED: { tone: "neutral", icon: Clock },
}

/** Operation / inbound-event status chip. Keeps the raw status text as the label
 *  (so filters and the status legend stay in lockstep) and adds tone + icon. */
export function OperationStatusChip({ status, className }: { status: string; className?: string }) {
  const meta = OPERATION_STATUS_META[status] ?? { tone: "neutral" as const, icon: Circle }
  return (
    <ToneChip tone={meta.tone} icon={meta.icon} className={className}>
      {status}
    </ToneChip>
  )
}

const FAILURE_STATE_META: Record<
  NonNullable<XeroOperation["failureState"]>,
  { tone: XeroTone; icon: LucideIcon; label: string }
> = {
  ACTIVE: { tone: "danger", icon: AlertTriangle, label: "Active" },
  REPAIRED: { tone: "success", icon: CheckCircle2, label: "Repaired" },
  SUPERSEDED: { tone: "neutral", icon: Archive, label: "Superseded" },
}

export function FailureStateChip({
  state,
  className,
}: {
  state: XeroOperation["failureState"]
  className?: string
}) {
  if (!state) return null
  const meta = FAILURE_STATE_META[state]
  return (
    <ToneChip tone={meta.tone} icon={meta.icon} className={className}>
      {meta.label}
    </ToneChip>
  )
}

export type BudgetStatus = "healthy" | "warning" | "critical" | "exhausted" | "unknown"

const BUDGET_TONE: Record<BudgetStatus, XeroTone> = {
  healthy: "success",
  warning: "warning",
  critical: "danger",
  exhausted: "danger",
  unknown: "neutral",
}

export function budgetTone(status: BudgetStatus | undefined): XeroTone {
  return status ? BUDGET_TONE[status] : "success"
}

/** API-budget status chip, shared by the usage panel and the health snapshot. */
export function BudgetStatusChip({ status, className }: { status: BudgetStatus; className?: string }) {
  const tone = budgetTone(status)
  return (
    <ToneChip tone={tone} icon={TONE_ICON[tone]} className={className}>
      {status}
    </ToneChip>
  )
}

export function inboundEventActionLabel(status: string) {
  if (status === "FAILED") return "Retry"
  if (status === "RECEIVED") return "Process Now"
  return "Replay"
}

export function shortId(value: string | null | undefined) {
  return value ? (value.length > 12 ? `${value.slice(0, 12)}...` : value) : "-"
}

export function formatJson(value: unknown) {
  return formatRedactedJson(value)
}

// #2256: bare toLocaleString() rendered the cache stamps in the admin's own
// browser locale and zone ("4/16/2026, 11:30 AM"). Xero cache freshness is
// judged against the club's clock — which since CT-4 (#2870) means the
// PERSISTED `ClubTimeSettings.timeZone` the caller binds, not `APP_TIME_ZONE`
// and never the viewer's (INV-CONFIG-002). These stamps are real INSTANTS.
//
// The parse is still guarded, because this label renders inside the Xero
// settings panel and a bad stamp must not blank it. `parseInstant` is stricter
// than the `new Date()` it replaces: a string with no Z and no offset names a
// wall-clock reading in whichever zone happens to be reading it, so it is now
// "unknown" rather than silently read in the host's zone.
function formatCacheStamp(clubTime: BoundClubTime, value: string) {
  const parsed = parseInstant(value)
  if (parsed === null) return "unknown"
  return clubTime.instantDateTime(parsed)
}

export function formatReferenceCacheLabel(clubTime: BoundClubTime, label: string, cache: XeroReferenceCacheMeta | null) {
  if (!cache) return `${label}: no cache metadata yet`
  const sourceLabel = cache.source === "database" ? "shared cache" : cache.source === "memory" ? "memory cache" : "live Xero"
  return `${label}: ${sourceLabel}, refreshed ${formatCacheStamp(clubTime, cache.lastRefreshedAt)}, expires ${formatCacheStamp(clubTime, cache.expiresAt)}`
}

export const ACCOUNT_MAPPING_KEYS: AccountMappingKey[] = [
  "hutFeesIncome",
  "hutFeeRefunds",
  "stripeBankAccount",
  "stripeFees",
  "subscriptionIncome",
  "membershipCancellationCredit",
]

export const CREDIT_ITEM_MAPPING_KEYS: CreditItemMappingKey[] = ["hutFeeRefundItem", "membershipCancellationCredit"]

export const MAPPING_LABELS: Record<string, string> = {
  hutFeesIncome: "Hut Fees Income",
  hutFeeRefunds: "Hut Fee Refunds",
  stripeBankAccount: "Stripe Bank Account",
  stripeFees: "Stripe Fees",
  subscriptionIncome: "Subscription Income",
  membershipCancellationCredit: "Membership Cancellation Credits",
  hutFeeRefundItem: "Hut Fee Refund Item",
}

export const MAPPING_DESCRIPTIONS: Record<string, string> = {
  hutFeesIncome: "Sales account for booking income line items",
  hutFeeRefunds: "Account for refund credit notes",
  stripeBankAccount: "Bank account used to record Stripe payments",
  stripeFees: "Expense account for Stripe transaction fees (optional)",
  subscriptionIncome: "Account code used to detect Annual Membership Fee invoices",
  membershipCancellationCredit:
    "Credit note account and item used to reverse unpaid Annual Membership Fee invoices when membership cancellation is approved",
  hutFeeRefundItem: "Xero Item for refund credit note line items",
}

export const MAPPING_TYPE_FILTER: Record<AccountMappingKey, string> = {
  hutFeesIncome: "REVENUE",
  hutFeeRefunds: "REVENUE",
  stripeBankAccount: "BANK",
  stripeFees: "EXPENSE",
  subscriptionIncome: "REVENUE",
  membershipCancellationCredit: "REVENUE",
}

function SyncReportSection({
  title,
  count,
  defaultOpen,
  children,
}: {
  title: string
  count: number
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen ?? false)
  if (count === 0) return null
  return (
    <div className="rounded-md border">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span>
          {title} ({count})
        </span>
        {open ? (
          <ChevronDown aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        )}
      </button>
      {open ? <div className="space-y-1 border-t px-3 pb-3">{children}</div> : null}
    </div>
  )
}

export function SyncReportView({
  report,
  shortCode,
  returnTo,
}: {
  report: SyncReport
  /**
   * Organisation short code for the per-contact Xero links, or null when
   * unavailable — the links then degrade to the generic session-scoped Xero
   * URL, they are never hidden (#2283).
   */
  shortCode: string | null
  returnTo: string
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Scanned {report.total} Xero contacts</p>
      <SyncReportSection title="Updated Members" count={report.updated.length}>
        {report.updated.map((member, index) => (
          <div key={`${member.memberId}-${index}`} className="flex items-start justify-between border-b py-1 text-xs last:border-0">
            <div>
              <a href={buildHrefWithReturnTo(`/admin/members/${member.memberId}`, returnTo)} className="font-medium text-primary hover:underline">
                {member.name}
              </a>
              <ul className="mt-0.5 list-inside list-disc text-muted-foreground">
                {member.changes.map((change) => <li key={change}>{change}</li>)}
              </ul>
            </div>
            <a href={buildXeroContactUrl(member.xeroContactId, { shortCode })} target="_blank" rel="noopener noreferrer" className="ml-2 shrink-0 text-primary hover:underline">
              Xero
            </a>
          </div>
        ))}
      </SyncReportSection>
      <SyncReportSection title="Already Linked (No Changes)" count={report.skippedNoChanges}>
        <p className="pt-1 text-xs text-muted-foreground">{report.skippedNoChanges} contacts were already linked and had no data to update.</p>
      </SyncReportSection>
      <SyncReportSection title="Skipped - Name Mismatch" count={report.skippedNameMismatch.length} defaultOpen>
        {report.skippedNameMismatch.map((mismatch) => (
          <div key={`${mismatch.memberId}-${mismatch.xeroContactId}`} className="flex items-start justify-between gap-3 border-b py-1 text-xs last:border-0">
            <div>
              <a href={buildHrefWithReturnTo(`/admin/members/${mismatch.memberId}`, returnTo)} className="font-medium text-primary hover:underline">
                {mismatch.memberName}
              </a>
              <p className="text-muted-foreground">{mismatch.memberEmail}</p>
              <p className="text-muted-foreground">
                Xero contact: {mismatch.xeroContactName}
                {mismatch.xeroContactEmail ? ` (${mismatch.xeroContactEmail})` : ""}
              </p>
              <p className="text-warning">{mismatch.reasons.join(", ")}</p>
            </div>
            <a href={buildXeroContactUrl(mismatch.xeroContactId, { shortCode })} target="_blank" rel="noopener noreferrer" className="shrink-0 text-primary hover:underline">
              Xero
            </a>
          </div>
        ))}
      </SyncReportSection>
      <SyncReportSection title="Skipped - No Email" count={report.skippedNoEmail.length}>
        {report.skippedNoEmail.map((contact) => (
          <div key={contact.xeroContactId} className="flex items-center justify-between border-b py-1 text-xs last:border-0">
            <span>{contact.name}</span>
            <a href={buildXeroContactUrl(contact.xeroContactId, { shortCode })} target="_blank" rel="noopener noreferrer" className="ml-2 shrink-0 text-primary hover:underline">
              Open in Xero
            </a>
          </div>
        ))}
      </SyncReportSection>
      <SyncReportSection title="Skipped - Other Reasons" count={report.skippedOther.length}>
        {report.skippedOther.map((contact, index) => (
          <div key={`${contact.name}-${index}`} className="flex items-center justify-between border-b py-1 text-xs last:border-0">
            <div>
              <span className="font-medium">{contact.name}</span>
              <span className="ml-1 text-muted-foreground">- {contact.reason}</span>
            </div>
            {contact.xeroContactId ? (
              <a href={buildXeroContactUrl(contact.xeroContactId, { shortCode })} target="_blank" rel="noopener noreferrer" className="ml-2 shrink-0 text-primary hover:underline">
                Xero
              </a>
            ) : null}
          </div>
        ))}
      </SyncReportSection>
      <SyncReportSection title="Errors" count={report.errors.length} defaultOpen>
        {report.errors.map((error, index) => (
          <div key={`${error.name}-${index}`} className="flex items-center justify-between border-b py-1 text-xs text-danger last:border-0">
            <div>
              <span className="font-medium">{error.name}</span>
              <span className="ml-1">- {error.error}</span>
            </div>
            {error.xeroContactId ? (
              <a href={buildXeroContactUrl(error.xeroContactId, { shortCode })} target="_blank" rel="noopener noreferrer" className="ml-2 shrink-0 text-primary hover:underline">
                Xero
              </a>
            ) : null}
          </div>
        ))}
      </SyncReportSection>
      <SyncReportSection title="Newly Created Members" count={report.created.length}>
        {report.created.map((contact) => (
          <div key={contact.xeroContactId} className="flex items-center justify-between border-b py-1 text-xs last:border-0">
            <div>
              <span className="font-medium">{contact.name}</span>
              <span className="ml-1 text-muted-foreground">{contact.email}</span>
              {contact.group ? <Badge variant="secondary" className="ml-1 py-0 text-[10px]">{contact.group}</Badge> : null}
            </div>
            <a href={buildXeroContactUrl(contact.xeroContactId, { shortCode })} target="_blank" rel="noopener noreferrer" className="ml-2 shrink-0 text-primary hover:underline">
              Xero
            </a>
          </div>
        ))}
      </SyncReportSection>
    </div>
  )
}
