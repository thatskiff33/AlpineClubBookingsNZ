"use client";

import { useEffect, useMemo, useState } from "react";
import { BedDouble, CircleDashed, Lock, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { pluralHutLeaderLabel } from "@/config/hut-leader-label";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useClubIdentity } from "@/components/club-identity-provider";
import { ADMIN_VIEW_ONLY_ACTION_REASON } from "@/hooks/use-admin-area-edit-access";
// `bed-allocation-range-report.ts` carries the range endpoint's wire shapes and
// nothing else — no prisma, no logger, no audit writer — so this import cannot
// pull the server into the client bundle even before type erasure (#2688). Kept
// type-only regardless. See the note beside the re-export below.
import type {
  BedRangeRefusal,
  BedRangeRefusalCategory,
} from "@/lib/bed-allocation-range-report";
import {
  countNightsDateOnly,
  eachDateOnlyInRange,
  formatDateOnly,
  isDateOnlyString,
  parseDateOnly,
} from "@/lib/date-only";

/*
 * Range assignment dialog (#2251) — "put this guest in this bed from X to Y" for
 * a stay of any length.
 *
 * There is deliberately NO preview step (owner decision, 26 Jul 2026). Assign
 * attempts the whole range atomically; if anything blocks it, NOTHING is written
 * and the server's refusal report is rendered here, one block per category. Only
 * then does a second, explicit "Assign the N free nights" action appear — and it
 * sends the EXACT night list this dialog is showing, not a "free nights only"
 * flag for the server to re-interpret. What the admin sees is what is written:
 * if one of those nights was taken in the meantime, the server refuses the whole
 * thing with a fresh report instead of writing a set the admin never approved.
 *
 * GUEST_NOT_BOOKED nights get one more gate (#2251 residual R2). Those nights
 * are not a clash — they mean the range or the guest is wrong — so proceeding
 * past them must be a read-and-confirmed choice rather than a button sitting
 * next to a warning. When the report contains any, the second action asks first,
 * naming both counts ("M nights are not part of this guest's booking and will
 * NOT be assigned. Assign the N free nights anyway?"). The wording deliberately
 * does NOT say "outside this guest's stay": a GAP night of a non-contiguous stay
 * (#713) sits INSIDE the stay span and is still refused, so "outside" would be
 * false in the one sentence the admin is asked to read and accept. Nothing else
 * changes: the free set already excluded those nights, so this adds consent, not
 * behaviour. With no such nights in the report there is no extra step.
 *
 * Lives in src/components/admin (not the board's _components) because #2252
 * drives the same dialog from inside a booking — one component, two surfaces.
 */

// Mirrors the board's BedOptionGroup structurally without importing from the
// admin route tree, so the booking surface can build its own options.
export interface RangeBedOptionGroup {
  roomId: string;
  roomName: string;
  beds: {
    id: string;
    bedName: string;
    /*
     * Display-only annotation on the option label (#2286 wired by #2252's
     * panel): "held for a hut leader (dates)", supplied by a surface whose
     * payload carries the custodian holds, so a held bed is visibly
     * unavailable BEFORE the click. The bed is deliberately not removed or
     * disabled — a hold may cover only part of the requested range, and the
     * server's per-night CUSTODIAN_HOLD refusal report is the authority.
     */
    heldNote?: string;
  }[];
}

/*
 * The refusal shape is the SERVER's, imported at the top of this file rather
 * than re-declared here (#2286 review). A structural mirror drifted the moment
 * the server grew a fourth category: the dialog kept a three-member union,
 * `CATEGORY_ORDER` never listed the new one, and CUSTODIAN_HOLD nights vanished
 * from the report while the banner above still counted them — the admin was told
 * N nights were blocked and then shown fewer than N. Re-exported so the two
 * consumer surfaces (the board, and #2252's booking panel) keep importing the
 * refusal types from the component they render.
 */
export type { BedRangeRefusal, BedRangeRefusalCategory };

export interface BedRangeAssignResult {
  applied: boolean;
  // The admin chose a subset of the range (the second action), rather than
  // asking for all of it.
  partialByConsent: boolean;
  bookingId: string;
  bookingGuestId: string;
  guestName: string;
  bedId: string;
  bedName: string;
  roomName: string;
  fromDate: string;
  toDate: string;
  requestedNights: string[];
  freeNights: string[];
  writtenNights: string[];
  refusals: BedRangeRefusal[];
}

export interface BedRangeAssignTarget {
  bookingGuestId: string;
  bookingId: string;
  guestName: string;
  memberName?: string;
  bedId?: string;
  // First night / check-out (exclusive) to prefill, normally the guest's stay.
  fromDate: string;
  toDate: string;
}

interface BedRangeAssignDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: BedRangeAssignTarget | null;
  bedOptionGroups: RangeBedOptionGroup[];
  // Tri-state (#2065): `undefined` while the client session resolves; the
  // `!canEdit` idiom treats that as disabled, so no truthy default here.
  canEdit: boolean | undefined;
  onAssigned: (result: BedRangeAssignResult) => void;
}

// Mirrors MAX_BED_ALLOCATION_ASSIGN_RANGE_NIGHTS in
// src/lib/bed-allocation-range-report.ts. The client refuses too, so a mistyped year
// is caught before a pointless round trip — it never shortens the range.
export const MAX_RANGE_ASSIGN_NIGHTS = 366;

// DISPLAY order. CUSTODIAN_HOLD leads and sits ABOVE BED_TAKEN, matching the
// server's resolution precedence for those two (a held bed-night is classified
// CUSTODIAN_HOLD before BED_TAKEN is even considered) and reading in the order
// the admin must act: the fix is on another page entirely, so it must not be
// buried under a list of clashes on this one. The remaining two are deliberately
// NOT in server precedence order — a clash is the thing an admin can do
// something about here, so it comes next, and a whole-lodge hold is structural
// and blocks the entire range anyway, so it reads last.
const CATEGORY_ORDER: BedRangeRefusalCategory[] = [
  "CUSTODIAN_HOLD",
  "BED_TAKEN",
  "GUEST_NOT_BOOKED",
  "EXCLUSIVE_HOLD",
];

// Keyed by the SERVER's union, so a new category is a compile error here rather
// than a night that silently disappears from the report.
const CATEGORY_TITLE: Record<BedRangeRefusalCategory, (label: string) => string> =
  {
    CUSTODIAN_HOLD: (label) => `Held for a ${label.toLowerCase()}`,
    BED_TAKEN: () => "Bed already allocated",
    GUEST_NOT_BOOKED: () => "Guest is not booked that night",
    EXCLUSIVE_HOLD: () => "Whole-lodge hold",
  };

const CATEGORY_EXPLANATION: Record<
  BedRangeRefusalCategory,
  (label: string) => string
> = {
  CUSTODIAN_HOLD: (label) =>
    `This bed is held for a ${label.toLowerCase()} on these nights, with no booking behind it, so no guest can be placed on it. Change the dates or the bed on the ${label} Assignments page (Admin → ${pluralHutLeaderLabel(label)}), or pick a different bed here.`,
  BED_TAKEN: () =>
    "Someone else is in this bed on these nights. Nothing was overwritten.",
  GUEST_NOT_BOOKED: () =>
    "This is not a clash — it means the range or the guest is wrong. Check the dates before going further.",
  EXCLUSIVE_HOLD: () =>
    "This booking holds the whole lodge for these nights, so its guests take the lodge and are not placed on individual beds.",
};

// A category this bundle has never heard of. During a deploy drain a new server
// can answer an old browser bundle, and an unknown category must still be SHOWN
// — silently dropping it would print "12 of 14 nights are blocked" above a list
// of ten, which is worse than an unstyled row.
const UNKNOWN_CATEGORY_TITLE = "Blocked for another reason";
const UNKNOWN_CATEGORY_EXPLANATION =
  "This version of the page does not recognise the reason the server gave. The nights are listed so nothing is hidden; reload the page to get the full explanation.";

export function nightsBetween(fromDate: string, toDate: string): string[] {
  if (!isDateOnlyString(fromDate) || !isDateOnlyString(toDate)) return [];
  const from = parseDateOnly(fromDate);
  const to = parseDateOnly(toDate);
  if (to <= from) return [];
  return eachDateOnlyInRange(from, to).map(formatDateOnly);
}

// Refuse, never truncate (#2251 requirement 4). Returns the reason a range
// cannot be sent, or null when it is well-formed.
export function rangeAssignError(
  fromDate: string,
  toDate: string,
): string | null {
  if (!isDateOnlyString(fromDate) || !isDateOnlyString(toDate)) {
    return "Enter a first night and a date out.";
  }
  if (parseDateOnly(toDate) <= parseDateOnly(fromDate)) {
    return "Date out must be after date in.";
  }
  // Counted arithmetically, never enumerated: a mistyped year must not build a
  // Date per night before it can be refused (matching the server, #2251).
  const nights = countNightsDateOnly(parseDateOnly(fromDate), parseDateOnly(toDate));
  if (nights > MAX_RANGE_ASSIGN_NIGHTS) {
    return `A range assignment covers at most ${MAX_RANGE_ASSIGN_NIGHTS} nights; that range is ${nights}. Split it into shorter ranges.`;
  }
  return null;
}

export function BedRangeAssignDialog({
  open,
  onOpenChange,
  target,
  bedOptionGroups,
  canEdit,
  onAssigned,
}: BedRangeAssignDialogProps) {
  // Admin client copy uses the club's own word for the role (#2286 review M8):
  // only the lobby TV is pinned to the fixed word "Custodian". A club that calls
  // them "Wardens" must read "Held for a warden" here, and be sent to the page
  // that is actually in its sidebar.
  const { hutLeaderLabel } = useClubIdentity();
  const [bedId, setBedId] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [refusal, setRefusal] = useState<BedRangeAssignResult | null>(null);
  // The GUEST_NOT_BOOKED consent gate (#2251 residual R2): armed only by the
  // admin clicking the second action, and cleared whenever the report it belongs
  // to is replaced or dropped.
  const [confirmingSkip, setConfirmingSkip] = useState(false);

  // Re-seed from the target each time the dialog opens, so reopening from a
  // different guest or bed never inherits the previous attempt's state.
  useEffect(() => {
    if (!open || !target) return;
    setBedId(target.bedId ?? "");
    setFromDate(target.fromDate);
    setToDate(target.toDate);
    setRefusal(null);
    setConfirmingSkip(false);
    setSubmitting(false);
  }, [open, target]);

  const validationError = useMemo(
    () => rangeAssignError(fromDate, toDate),
    [fromDate, toDate],
  );
  // A refused range has no night list: enumerating a mistyped "3026" to count it
  // would build a Date per night while the error message is already on screen
  // saying the range is impossible.
  const nights = useMemo(
    () => (validationError ? [] : nightsBetween(fromDate, toDate)),
    [fromDate, toDate, validationError],
  );

  const refusalsByCategory = useMemo(() => {
    const map = new Map<BedRangeRefusalCategory, BedRangeRefusal[]>();
    for (const item of refusal?.refusals ?? []) {
      const existing = map.get(item.category);
      if (existing) {
        existing.push(item);
      } else {
        map.set(item.category, [item]);
      }
    }
    return map;
  }, [refusal]);

  // Every category the report actually contains, in display order, with anything
  // this bundle does not know about appended rather than dropped (deploy drain).
  const renderedCategories = useMemo(() => {
    const known = CATEGORY_ORDER.filter(
      (category) => (refusalsByCategory.get(category)?.length ?? 0) > 0,
    );
    const unknown = [...refusalsByCategory.keys()].filter(
      (category) => !CATEGORY_ORDER.includes(category),
    );
    return [...known, ...unknown];
  }, [refusalsByCategory]);

  if (!target) return null;

  // A report and the consent gate armed from it live and die together: editing
  // the bed or the dates makes both stale evidence.
  function dropRefusal() {
    setRefusal(null);
    setConfirmingSkip(false);
  }

  /**
   * `chosenNights` is the second action: the exact nights this dialog is
   * currently showing as free, sent back for the server to write as-is. Omit it
   * for the ordinary all-or-nothing attempt over the whole range.
   */
  async function submit(chosenNights?: string[]) {
    if (!canEdit || !target) return;
    if (!bedId) {
      toast.error("Select a bed first");
      return;
    }
    if (validationError) {
      toast.error(validationError);
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch(
        "/api/admin/bed-allocation/allocations/range",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bookingGuestId: target.bookingGuestId,
            bedId,
            from: fromDate,
            to: toDate,
            ...(chosenNights ? { nights: chosenNights } : {}),
          }),
        },
      );

      const body = (await response.json().catch(() => null)) as {
        error?: string;
        result?: BedRangeAssignResult;
      } | null;

      // A refused attempt is not an error to swallow: the server answers 400/409
      // and carries the report that tells the admin exactly what blocked it.
      if (body?.result && !body.result.applied) {
        // A FRESH report: the consent gate must be re-armed against it, never
        // inherited from the report it replaces.
        setRefusal(body.result);
        setConfirmingSkip(false);
        return;
      }

      if (!response.ok || !body?.result) {
        toast.error(body?.error ?? "Failed to assign the range");
        return;
      }

      onAssigned(body.result);
      onOpenChange(false);
    } catch {
      toast.error("Failed to assign the range");
    } finally {
      setSubmitting(false);
    }
  }

  // The nights the report says are free — the exact list the second action
  // sends, so the button's number and what gets written are the same thing.
  const offeredNights = refusal?.freeNights ?? [];
  const freeNightCount = offeredNights.length;
  // Nights the guest is not booked on are the one refusal category that means
  // the REQUEST is wrong rather than the bed being busy, so proceeding past them
  // is gated on an explicit confirmation (#2251 residual R2).
  const notBookedCount =
    refusalsByCategory.get("GUEST_NOT_BOOKED")?.length ?? 0;
  const needsSkipConsent = notBookedCount > 0;
  const freeNightsLabel = `${freeNightCount} free night${freeNightCount === 1 ? "" : "s"}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BedDouble className="h-4 w-4" aria-hidden />
            Assign a range of nights
          </DialogTitle>
          <DialogDescription>
            Put {target.guestName} in one bed for every night of the range. It is
            written all at once — if any night is blocked, nothing is written and
            you are shown exactly which nights and why.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Opaque muted token, never an alpha of it: the app-shell theme
              contract bans endpoint-crossing opacity variants on text
              surfaces (and scans this file's source, comments included). */}
          <div className="rounded-md border bg-muted p-3 text-sm">
            <div className="font-medium">{target.guestName}</div>
            {target.memberName ? (
              <div className="text-xs text-muted-foreground">
                {target.memberName}
              </div>
            ) : null}
            <div className="font-mono text-xs text-muted-foreground">
              {target.bookingId}
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="bed-range-bed">Bed</Label>
            <Select
              value={bedId}
              onValueChange={(value) => {
                setBedId(value);
                // The report describes the attempt that produced it. Editing the
                // bed or the dates makes it stale evidence, so drop it rather
                // than leave the admin reading a refusal for a different range.
                dropRefusal();
              }}
              disabled={!canEdit}
            >
              <SelectTrigger id="bed-range-bed">
                <SelectValue placeholder="Select bed" />
              </SelectTrigger>
              <SelectContent>
                {bedOptionGroups.map((room) => (
                  <SelectGroup key={room.roomId}>
                    <SelectLabel>{room.roomName}</SelectLabel>
                    {room.beds.map((bed) => (
                      <SelectItem key={bed.id} value={bed.id}>
                        {room.roomName} / {bed.bedName}
                        {bed.heldNote ? ` — ${bed.heldNote}` : ""}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="bed-range-from">Date In (first night)</Label>
              <Input
                id="bed-range-from"
                type="date"
                value={fromDate}
                disabled={!canEdit}
                onChange={(event) => {
                  setFromDate(event.target.value);
                  dropRefusal();
                }}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="bed-range-to">Date Out (checkout)</Label>
              <Input
                id="bed-range-to"
                type="date"
                value={toDate}
                disabled={!canEdit}
                onChange={(event) => {
                  setToDate(event.target.value);
                  dropRefusal();
                }}
              />
            </div>
          </div>

          <p className="text-xs text-muted-foreground" data-testid="range-summary">
            {nights.length > 0
              ? `${nights.length} night${nights.length === 1 ? "" : "s"} · first night ${nights[0]} · last night ${nights[nights.length - 1]}`
              : "No nights selected yet."}
          </p>

          {validationError ? (
            <Alert variant="error">{validationError}</Alert>
          ) : null}

          {/*
            Under the auto-approve decision the LOCK fires on the FIRST range
            assign, not on a later "Confirm" — isBookingBedAllocationLocked is
            "at least one approved row exists" (#776). Say so before the admin
            commits, not after.
          */}
          <Alert variant="warning" title="This confirms the beds straight away">
            Range assignments are approved as they are written. Approving beds
            locks this booking&apos;s member out of changing their requested room.
          </Alert>

          {refusal ? (
            <div className="space-y-3" data-testid="range-refusal-report">
              <Alert
                variant="error"
                title={`Nothing was written — ${refusal.refusals.length} of ${refusal.requestedNights.length} nights are blocked`}
              >
                {freeNightCount > 0
                  ? `${freeNightCount} night${freeNightCount === 1 ? " is" : "s are"} free. You can assign just those with the button below.`
                  : "No night in this range is free, so there is nothing to assign."}
              </Alert>

              {renderedCategories.map((category) => {
                const items = refusalsByCategory.get(category) ?? [];
                if (items.length === 0) return null;
                const title = CATEGORY_TITLE[category]
                  ? CATEGORY_TITLE[category](hutLeaderLabel)
                  : UNKNOWN_CATEGORY_TITLE;
                const explanation = CATEGORY_EXPLANATION[category]
                  ? CATEGORY_EXPLANATION[category](hutLeaderLabel)
                  : UNKNOWN_CATEGORY_EXPLANATION;
                return (
                  <div
                    key={category}
                    data-testid={`refusal-category-${category}`}
                    className="rounded-md border p-3"
                  >
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      <TriangleAlert
                        className="h-4 w-4 text-warning"
                        aria-hidden
                      />
                      {title} · {items.length} night
                      {items.length === 1 ? "" : "s"}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {explanation}
                    </p>
                    <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-xs">
                      {items.map((item) => (
                        <li
                          key={`${item.category}:${item.stayDate}`}
                          className="flex flex-wrap items-center gap-2"
                        >
                          <span className="font-mono">{item.stayDate}</span>
                          {item.occupiedBy ? (
                            <>
                              <span>{item.occupiedBy.guestName}</span>
                              <span className="text-muted-foreground">
                                ({item.occupiedBy.memberName})
                              </span>
                              <span
                                className={
                                  item.occupiedBy.holdsCapacity
                                    ? "inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium text-secondary-foreground"
                                    : "inline-flex items-center gap-1 rounded-full border border-dashed border-muted-foreground/80 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                                }
                                title={
                                  item.occupiedBy.holdsCapacity
                                    ? "Held — this booking holds the bed for the night."
                                    : "Provisional — this booking does not hold the night, but it is still a conflict: nothing is overwritten without you saying so."
                                }
                              >
                                {item.occupiedBy.holdsCapacity ? (
                                  <Lock className="h-2.5 w-2.5" aria-hidden />
                                ) : (
                                  <CircleDashed
                                    className="h-2.5 w-2.5"
                                    aria-hidden
                                  />
                                )}
                                {item.occupiedBy.holdsCapacity
                                  ? "Held"
                                  : "Provisional"}
                              </span>
                            </>
                          ) : null}
                          {item.hold ? (
                            <span className="text-muted-foreground">
                              {item.hold.ownBooking
                                ? "This booking holds the whole lodge"
                                : `Held by ${item.hold.memberName}`}{" "}
                              ({item.hold.bookingId})
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}

              {/*
                The consent step (#2251 residual R2). It appears only after the
                admin asks for the free nights AND the report contains nights the
                guest is not booked on — the category that means the request is
                wrong rather than the bed being busy. It names both counts, so
                going on is a read-and-confirmed choice.
              */}
              {confirmingSkip && needsSkipConsent && freeNightCount > 0 ? (
                <Alert
                  variant="warning"
                  data-testid="range-skip-confirmation"
                  title={`${notBookedCount} night${notBookedCount === 1 ? " is" : "s are"} not part of this guest's booking and will NOT be assigned`}
                >
                  Assign the {freeNightsLabel} anyway? If the dates are wrong,
                  change them above instead — nothing has been written yet.
                </Alert>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <div className="flex flex-wrap gap-2">
            {refusal && freeNightCount > 0 ? (
              needsSkipConsent && !confirmingSkip ? (
                // Arms the consent step rather than writing: the ellipsis says a
                // further step follows, and the count is still the exact set the
                // report offered.
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!canEdit || submitting}
                  title={
                    canEdit === false ? ADMIN_VIEW_ONLY_ACTION_REASON : undefined
                  }
                  onClick={() => setConfirmingSkip(true)}
                >
                  Assign the {freeNightsLabel}…
                </Button>
              ) : (
                <>
                  {confirmingSkip ? (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={submitting}
                      onClick={() => setConfirmingSkip(false)}
                    >
                      Go back
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={!canEdit || submitting}
                    title={
                      canEdit === false
                        ? ADMIN_VIEW_ONLY_ACTION_REASON
                        : undefined
                    }
                    onClick={() => void submit(offeredNights)}
                  >
                    {confirmingSkip
                      ? `Yes, assign the ${freeNightsLabel}`
                      : `Assign the ${freeNightsLabel}`}
                  </Button>
                </>
              )
            ) : null}
            <Button
              type="button"
              disabled={
                !canEdit || submitting || !bedId || Boolean(validationError)
              }
              title={canEdit === false ? ADMIN_VIEW_ONLY_ACTION_REASON : undefined}
              onClick={() => void submit()}
            >
              {refusal ? "Try all nights again" : "Assign"}
              {nights.length > 0 && !refusal
                ? ` ${nights.length} night${nights.length === 1 ? "" : "s"}`
                : ""}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
