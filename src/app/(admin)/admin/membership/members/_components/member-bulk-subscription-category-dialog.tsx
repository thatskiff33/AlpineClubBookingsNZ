"use client"

import { useEffect, useMemo, useState } from "react"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FieldHint, useFieldHint } from "@/components/ui/field-hint"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useClubTime } from "@/components/club-time-provider"
import type { SubscriptionCategoryOption } from "@/hooks/use-subscription-category-options"
import { calendarDateParts } from "@/lib/club-time"
import {
  LinkedGuestBookingList,
  type LinkedGuestBookings,
} from "./member-bulk-membership-dialog"

// Keep in lockstep with the route schema (`ids.max(100)`).
const BULK_CATEGORY_MAX = 100

// The Select needs a non-empty value for "Individual"; the request sends null.
const INDIVIDUAL_VALUE = "__individual__"

type SkipReason =
  | "archived"
  | "not_found"
  | "no_membership_type"
  | "membership_type_archived"

const SKIP_REASON_LABELS: Record<SkipReason, string> = {
  archived: "archived member",
  not_found: "member not found",
  no_membership_type:
    "no membership type for this season — assign one from their profile first",
  membership_type_archived:
    "on an archived membership type — change their type from their profile first",
}

interface CategorySummary {
  id: string
  name: string
}

interface PreviewMember {
  memberId: string
  name: string
  previewToken: string
  currentCategory: CategorySummary | null
  newCategory: CategorySummary | null
  changed: boolean
  categoryChanged: boolean
  currentAgeTier: string
  resultingAgeTier: string
  ageTierChanged: boolean
  linkedGuestBlocked: boolean
  linkedGuestBookings: LinkedGuestBookings
  currentSeasonSubscription: {
    status: string
    hasInvoice: boolean
  }
}

interface PreviewResponse {
  seasonYear: number
  summary: {
    requested: number
    previewed: number
    changed: number
    unchanged: number
    skipped: number
    ageTierChanges: number
    linkedGuestBlocks: number
    alreadyBilled: number
  }
  members: PreviewMember[]
  skipped: Array<{ memberId: string; name: string; reason: SkipReason }>
}

type MemberOutcome =
  | "changed"
  | "unchanged"
  | "skipped"
  | "stale"
  | "blocked_linked_guests"
  | "error"

interface SaveResultRow {
  memberId: string
  name?: string
  outcome: MemberOutcome
  error?: string
  skipReason?: SkipReason
  linkedGuestBookings?: LinkedGuestBookings
}

interface SaveResponse {
  outcomeCounts: Record<MemberOutcome, number>
  results: SaveResultRow[]
}

const OUTCOME_LABELS: Record<MemberOutcome, string> = {
  changed: "Changed",
  unchanged: "No change",
  skipped: "Skipped",
  stale: "Stale — preview again",
  blocked_linked_guests: "Blocked (linked guest)",
  error: "Error",
}

const ATTENTION_OUTCOMES: ReadonlySet<MemberOutcome> = new Set([
  "skipped",
  "stale",
  "blocked_linked_guests",
  "error",
])

function categoryLabel(category: CategorySummary | null): string {
  return category?.name ?? "Individual"
}

/** Paid or invoiced for the season: the billing run will not re-bill them. */
function isAlreadyBilled(member: PreviewMember): boolean {
  return (
    member.currentSeasonSubscription.status === "PAID" ||
    member.currentSeasonSubscription.hasInvoice
  )
}

type NameFor = (memberId: string, name?: string) => string

/** The preview step: who moves from what to what, who is skipped and why. */
function BulkCategoryPreview({
  preview,
  currentSeasonYear,
  nameFor,
}: {
  preview: PreviewResponse
  currentSeasonYear: number
  nameFor: NameFor
}) {
  const changingMembers = preview.members.filter((member) => member.changed)
  return (
    <div className="space-y-3 text-sm">
      <div className="rounded-md border p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Season {preview.seasonYear}
        </p>
        <p className="mt-1 font-medium">
          {preview.summary.changed} of {preview.summary.previewed} will change
          {preview.summary.unchanged > 0
            ? ` (${preview.summary.unchanged} already in this category)`
            : ""}
          .
        </p>
        {preview.seasonYear !== currentSeasonYear && (
          <p className="mt-1 text-xs text-warning-11">
            Heads up: this is not the current season ({currentSeasonYear}).
          </p>
        )}
        <ul className="mt-2 space-y-1 text-muted-foreground">
          {preview.summary.ageTierChanges > 0 && (
            <li>Age tier corrections: {preview.summary.ageTierChanges}</li>
          )}
          {preview.summary.linkedGuestBlocks > 0 && (
            <li className="text-destructive">
              Blocked by linked-guest bookings: {preview.summary.linkedGuestBlocks}
            </li>
          )}
          {preview.summary.skipped > 0 && (
            <li>Skipped: {preview.summary.skipped}</li>
          )}
        </ul>
      </div>
      {preview.summary.alreadyBilled > 0 && (
        <Alert variant="info">
          {preview.summary.alreadyBilled} member(s) are already paid or invoiced
          for season {preview.seasonYear}. The billing run skips them, so the new
          category does not change this season&apos;s invoice.
        </Alert>
      )}
      {(changingMembers.length > 0 || preview.skipped.length > 0) && (
        <div
          className="max-h-48 overflow-y-auto rounded-md border p-2 text-xs"
          role="region"
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scroll container with no focusable content is the exception the rule's own docs name (axe scrollable-region-focusable)
          tabIndex={0}
          aria-label="Members in this change"
        >
          {changingMembers.map((member) => (
            <div key={member.memberId} className="py-0.5">
              <div>
                <span className="font-medium">{member.name}</span>
                <span className="ml-2 text-muted-foreground">
                  {member.categoryChanged
                    ? `${categoryLabel(member.currentCategory)} → ${categoryLabel(member.newCategory)}`
                    : `stays ${categoryLabel(member.currentCategory)}`}
                </span>
                {member.ageTierChanged && (
                  <span className="ml-2 text-muted-foreground">
                    age tier {member.currentAgeTier} → {member.resultingAgeTier}
                  </span>
                )}
                {member.categoryChanged && isAlreadyBilled(member) && (
                  <span className="ml-2 text-muted-foreground">
                    (already billed this season)
                  </span>
                )}
                {member.linkedGuestBlocked && (
                  <span className="ml-2 text-destructive">
                    blocked: linked guest on {member.linkedGuestBookings.count}{" "}
                    future booking(s)
                  </span>
                )}
              </div>
              {member.linkedGuestBlocked && (
                <LinkedGuestBookingList bookings={member.linkedGuestBookings} />
              )}
            </div>
          ))}
          {preview.skipped.map((skip) => (
            <div key={skip.memberId} className="py-0.5">
              <span className="font-medium">{nameFor(skip.memberId, skip.name)}</span>
              <span className="ml-2 text-muted-foreground">
                skipped: {SKIP_REASON_LABELS[skip.reason]}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** The results step: the outcome counts and every member that needs attention. */
function BulkCategoryResults({
  saveResult,
  nameFor,
}: {
  saveResult: SaveResponse
  nameFor: NameFor
}) {
  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-1">
        {(Object.keys(OUTCOME_LABELS) as MemberOutcome[]).map((outcome) =>
          (saveResult.outcomeCounts[outcome] ?? 0) > 0 ? (
            <div key={outcome} className="flex justify-between rounded border px-2 py-1">
              <span>{OUTCOME_LABELS[outcome]}</span>
              <span className="font-medium">{saveResult.outcomeCounts[outcome]}</span>
            </div>
          ) : null,
        )}
      </div>
      {saveResult.results.some((result) => ATTENTION_OUTCOMES.has(result.outcome)) && (
        <div
          className="max-h-40 overflow-y-auto rounded-md border p-2 text-xs"
          role="region"
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scroll container with no focusable content is the exception the rule's own docs name (axe scrollable-region-focusable)
          tabIndex={0}
          aria-label="Members needing attention"
        >
          {saveResult.results
            .filter((result) => ATTENTION_OUTCOMES.has(result.outcome))
            .map((result) => (
              <div key={result.memberId} className="py-0.5">
                <div>
                  <span className="font-medium">
                    {nameFor(result.memberId, result.name)}
                  </span>
                  <span className="ml-2 text-muted-foreground">
                    {OUTCOME_LABELS[result.outcome]}
                    {result.skipReason
                      ? ` — ${SKIP_REASON_LABELS[result.skipReason]}`
                      : result.error
                        ? ` — ${result.error}`
                        : ""}
                  </span>
                </div>
                {result.outcome === "blocked_linked_guests" && (
                  <LinkedGuestBookingList bookings={result.linkedGuestBookings} />
                )}
              </div>
            ))}
        </div>
      )}
    </div>
  )
}

interface MemberBulkSubscriptionCategoryDialogProps {
  open: boolean
  selectedIds: Set<string>
  memberNames: Map<string, string>
  /** The club's categories, built-in Individual excluded; only active ones are offered. */
  subscriptionCategories: SubscriptionCategoryOption[]
  onOpenChange: (open: boolean) => void
  onComplete: (changed: number) => void
  onError: (message: string) => void
}

type Step = "configure" | "preview" | "reason" | "results"

/**
 * #5248: set or clear the subscription category of the selected members for
 * one season — configure, preview who changes, give a reason, see each
 * member's outcome. Only the category moves; each member keeps their own
 * membership type.
 */
export function MemberBulkSubscriptionCategoryDialog({
  open,
  selectedIds,
  memberNames,
  subscriptionCategories,
  onOpenChange,
  onComplete,
  onError,
}: MemberBulkSubscriptionCategoryDialogProps) {
  // The club's calendar year until the server's season year arrives
  // (INV-CONFIG-002), as in the bulk membership-type dialog.
  const clubTime = useClubTime()
  const currentYear = calendarDateParts(clubTime.today()).year
  const [categoryValue, setCategoryValue] = useState<string>("")
  const [currentSeasonYear, setCurrentSeasonYear] = useState<number>(currentYear)
  const [seasonYear, setSeasonYear] = useState<number>(currentYear)
  const [step, setStep] = useState<Step>("configure")
  const [preview, setPreview] = useState<PreviewResponse | null>(null)
  const [reason, setReason] = useState("")
  const [saveResult, setSaveResult] = useState<SaveResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const reasonHint = useFieldHint()

  const ids = useMemo(() => [...selectedIds], [selectedIds])
  const overCap = ids.length > BULK_CATEGORY_MAX
  const activeCategories = subscriptionCategories.filter((category) => category.isActive)
  const subscriptionCategoryId =
    categoryValue === INDIVIDUAL_VALUE ? null : categoryValue || null
  const targetName =
    categoryValue === INDIVIDUAL_VALUE
      ? "Individual (no category)"
      : (activeCategories.find((category) => category.id === categoryValue)?.name ?? "")

  useEffect(() => {
    if (!open) return
    setStep("configure")
    setCategoryValue("")
    setSeasonYear(currentYear)
    setCurrentSeasonYear(currentYear)
    setPreview(null)
    setReason("")
    setSaveResult(null)
    let cancelled = false
    // The server's current season (config-driven year-end) comes with the
    // membership-types list, the same source the membership-type dialog reads.
    void (async () => {
      try {
        const res = await fetch("/api/admin/membership-types")
        if (!res.ok) return
        const data = (await res.json()) as { currentSeasonYear?: number }
        if (!cancelled && typeof data.currentSeasonYear === "number") {
          setCurrentSeasonYear(data.currentSeasonYear)
          setSeasonYear(data.currentSeasonYear)
        }
      } catch {
        // The club calendar year stays as the default.
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const yearOptions = [
    currentSeasonYear - 1,
    currentSeasonYear,
    currentSeasonYear + 1,
    currentSeasonYear + 2,
  ]

  const runPreview = async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/admin/members/bulk-subscription-category/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, seasonYear, subscriptionCategoryId }),
      })
      const data = (await res.json().catch(() => ({}))) as PreviewResponse & {
        error?: string
      }
      if (!res.ok) throw new Error(data.error || "Preview failed")
      setPreview(data)
      setStep("preview")
    } catch (err) {
      onError(err instanceof Error ? err.message : "Preview failed")
    } finally {
      setLoading(false)
    }
  }

  const runSave = async () => {
    if (!preview) return
    setLoading(true)
    try {
      const previewTokens = Object.fromEntries(
        preview.members.map((member) => [member.memberId, member.previewToken]),
      )
      const res = await fetch("/api/admin/members/bulk-subscription-category", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: preview.members.map((member) => member.memberId),
          seasonYear,
          subscriptionCategoryId,
          reason,
          previewTokens,
        }),
      })
      const data = (await res.json().catch(() => ({}))) as SaveResponse & {
        error?: string
      }
      if (!res.ok) throw new Error(data.error || "Bulk category change failed")
      setSaveResult(data)
      setStep("results")
    } catch (err) {
      onError(err instanceof Error ? err.message : "Bulk category change failed")
    } finally {
      setLoading(false)
    }
  }

  const nameFor = (memberId: string, name?: string) =>
    name ?? memberNames.get(memberId) ?? memberId

  return (
    <Dialog
      open={open}
      // Never drop a run mid-save, as in the membership-type dialog.
      onOpenChange={(next) => {
        if (!next && loading) return
        onOpenChange(next)
      }}
    >
      <DialogContent
        className="sm:max-w-lg"
        onEscapeKeyDown={(event) => {
          if (loading) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (loading) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>Set Subscription Category</DialogTitle>
          <DialogDescription>
            Set or clear the subscription category of {ids.length} selected member
            {ids.length === 1 ? "" : "s"}. Their membership type does not change.
          </DialogDescription>
        </DialogHeader>

        {step === "configure" && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="bulk-subscription-category">Subscription category</Label>
              <Select value={categoryValue} onValueChange={setCategoryValue}>
                <SelectTrigger id="bulk-subscription-category">
                  <SelectValue placeholder="Select a category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={INDIVIDUAL_VALUE}>Individual (no category)</SelectItem>
                  {activeCategories.map((category) => (
                    <SelectItem key={category.id} value={category.id}>
                      {category.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="bulk-subscription-category-season">Season year</Label>
              <Select
                value={String(seasonYear)}
                onValueChange={(value) => setSeasonYear(Number(value))}
              >
                <SelectTrigger id="bulk-subscription-category-season">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {yearOptions.map((year) => (
                    <SelectItem key={year} value={String(year)}>
                      {year}
                      {year === currentSeasonYear ? " (current season)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {overCap && (
              <Alert variant="warning">
                Bulk category changes are limited to {BULK_CATEGORY_MAX} members at a
                time — refine your selection.
              </Alert>
            )}
          </div>
        )}

        {step === "preview" && preview && (
          <BulkCategoryPreview
            preview={preview}
            currentSeasonYear={currentSeasonYear}
            nameFor={nameFor}
          />
        )}

        {step === "reason" && (
          <div className="space-y-2">
            <Label htmlFor="bulk-subscription-category-reason">
              Reason (recorded on each member&apos;s audit trail)
            </Label>
            <Textarea
              id="bulk-subscription-category-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              maxLength={1000}
              {...reasonHint.fieldProps}
            />
            <FieldHint {...reasonHint.hintProps}>
              {`Example: Moving ${preview?.summary.changed ?? 0} member(s) to ${targetName}`}
            </FieldHint>
          </div>
        )}

        {step === "results" && saveResult && (
          <BulkCategoryResults saveResult={saveResult} nameFor={nameFor} />
        )}

        <DialogFooter>
          {step === "configure" && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
                Cancel
              </Button>
              <Button onClick={runPreview} disabled={loading || !categoryValue || overCap}>
                {loading ? "Previewing..." : "Preview"}
              </Button>
            </>
          )}
          {step === "preview" && (
            <>
              <Button variant="outline" onClick={() => setStep("configure")} disabled={loading}>
                Back
              </Button>
              <Button
                onClick={() => setStep("reason")}
                disabled={loading || (preview?.summary.changed ?? 0) === 0}
              >
                Continue
              </Button>
            </>
          )}
          {step === "reason" && (
            <>
              <Button variant="outline" onClick={() => setStep("preview")} disabled={loading}>
                Back
              </Button>
              <Button onClick={runSave} disabled={loading || reason.trim().length === 0}>
                {loading ? "Saving..." : "Confirm change"}
              </Button>
            </>
          )}
          {step === "results" && (
            <>
              <Button variant="outline" onClick={runPreview} disabled={loading}>
                Preview again
              </Button>
              <Button
                onClick={() => {
                  onComplete(saveResult?.outcomeCounts.changed ?? 0)
                  onOpenChange(false)
                }}
                disabled={loading}
              >
                Done
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
