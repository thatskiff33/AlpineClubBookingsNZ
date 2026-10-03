"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useClubFormat } from "@/components/club-format-provider";
import type { PromoResult } from "@/components/promo-code-input";
import {
  promoCodeListEntries,
  type PromoCodeListEntry,
  type PromoListValidation,
} from "@/components/promo-code-list-client";
import { formatSignedCents } from "@/lib/utils";

/** A chip the booker can opt into: the code and one line saying what it gives. */
export type PromoChipOption = { code: string; detail: string | null };

/** One guest's chips, drawn under that guest's name ("applies to Sam only"). */
export type GuestPromoChipGroup = { guestName: string; codes: PromoChipOption[] };

/**
 * The promo codes on one booking, in the booker's order (#3492, epic #3813 C4).
 *
 * - **Opt-in.** Nothing is applied until the booker presses a chip or types a
 *   code (D-3492-2). The booker's own codes and each guest member's codes are
 *   offered as chips, the guest ones grouped under that guest's name, because a
 *   guest's code covers only that guest's nights.
 * - **Several codes, in the booker's order** (D-3813-1/2) while the club's
 *   `multiPromoCodes` switch is on. Off, the list holds one code and offers
 *   nothing more once it does — exactly the single-code entry it replaces.
 * - **The order is the booker's to set**, with a Move earlier / Move later pair
 *   on each code: real buttons, so they work from the keyboard, and every move
 *   is announced through a polite live region and keeps focus on the code that
 *   moved. A move the server refuses (a later code left covering nothing) is
 *   reverted and the refusal read out.
 * - **The whole list is priced at once** by `validate`, so every amount shown
 *   is the amount in this order; a change the server refuses leaves the list as
 *   it was.
 */
export function PromoCodeList({
  applied,
  onChange,
  validate,
  multiPromoCodes,
  ownCodes,
  guestGroups,
  guestLabel,
  showAmounts = true,
  disabled = false,
  disabledReason,
}: {
  applied: PromoResult[];
  onChange: (next: PromoResult[]) => void;
  validate: (
    entries: PromoCodeListEntry[],
    appliesTo: ReadonlyMap<string, string>,
  ) => Promise<PromoListValidation>;
  multiPromoCodes: boolean;
  ownCodes: PromoChipOption[];
  guestGroups: GuestPromoChipGroup[];
  /** The name a guest-selection checkbox shows for a party position. */
  guestLabel: (index: number) => string;
  /** Per-code amounts; off where another quote is the authority (an edit). */
  showAmounts?: boolean;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const format = useClubFormat();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [selection, setSelection] = useState<{
    code: string;
    appliesTo?: string;
    selectable: number[];
    chosen: number[];
  } | null>(null);
  const [focusAfterMove, setFocusAfterMove] = useState<{ code: string; direction: "up" | "down" } | null>(null);
  const moveButtons = useRef(new Map<string, HTMLButtonElement | null>());

  const codes = applied.filter((promo) => promo.code && !promo.workPartyEvent);
  const appliedSet = new Set(codes.map((promo) => promo.code!));
  const canAddMore = !disabled && (multiPromoCodes || codes.length === 0);
  const reorderable = multiPromoCodes && codes.length > 1;

  useEffect(() => {
    if (!focusAfterMove) return;
    const index = codes.findIndex((promo) => promo.code === focusAfterMove.code);
    const preferred = focusAfterMove.direction === "up" ? index > 0 : index < codes.length - 1;
    const direction = preferred ? focusAfterMove.direction : focusAfterMove.direction === "up" ? "down" : "up";
    moveButtons.current.get(`${focusAfterMove.code}:${direction}`)?.focus();
    setFocusAfterMove(null);
  }, [focusAfterMove, codes]);

  function appliesToMap(extra?: { code: string; appliesTo?: string }) {
    const map = new Map<string, string>();
    for (const promo of codes) if (promo.appliesTo) map.set(promo.code!, promo.appliesTo);
    if (extra?.appliesTo) map.set(extra.code, extra.appliesTo);
    return map;
  }

  async function run(entries: PromoCodeListEntry[], extra?: { code: string; appliesTo?: string }) {
    setBusy(true);
    setError("");
    try {
      return await validate(entries, appliesToMap(extra));
    } finally {
      setBusy(false);
    }
  }

  async function addCode(rawCode: string, appliesTo?: string, promoGuestIndexes?: number[]) {
    const next = rawCode.toUpperCase().trim();
    if (!next) {
      setError("Please enter a promo code");
      return;
    }
    if (appliedSet.has(next)) {
      setError(`${next} is already on this booking.`);
      return;
    }
    const outcome = await run(
      [...promoCodeListEntries(codes), { code: next, ...(promoGuestIndexes ? { promoGuestIndexes } : {}) }],
      { code: next, appliesTo },
    );
    if (!outcome.ok) {
      if (outcome.guestSelection) {
        setSelection({
          code: outcome.guestSelection.code,
          appliesTo,
          selectable: outcome.guestSelection.selectableGuestIndexes,
          chosen: [],
        });
      }
      setError(outcome.error);
      setAnnouncement(outcome.error);
      return;
    }
    setSelection(null);
    setCode("");
    onChange(outcome.applied);
    setAnnouncement(
      codes.length === 0
        ? `${next} applied.`
        : `${next} applied, position ${outcome.applied.length} of ${outcome.applied.length}.`,
    );
  }

  async function removeCode(target: string) {
    const remaining = codes.filter((promo) => promo.code !== target);
    if (remaining.length === 0) {
      onChange([]);
      setAnnouncement(`${target} removed.`);
      return;
    }
    const outcome = await run(promoCodeListEntries(remaining));
    if (!outcome.ok) {
      // The remaining codes no longer price as they did; ask for them again
      // rather than show amounts the save would not give.
      onChange([]);
      setError(`${target} was removed. Please apply your other codes again: ${outcome.error}`);
      setAnnouncement(`${target} removed. Your other codes need applying again.`);
      return;
    }
    onChange(outcome.applied);
    setAnnouncement(`${target} removed.`);
  }

  async function moveCode(index: number, direction: "up" | "down") {
    const swapWith = direction === "up" ? index - 1 : index + 1;
    if (swapWith < 0 || swapWith >= codes.length) return;
    const reordered = [...codes];
    [reordered[index], reordered[swapWith]] = [reordered[swapWith]!, reordered[index]!];
    const moved = codes[index]!.code!;
    const outcome = await run(promoCodeListEntries(reordered));
    if (!outcome.ok) {
      setError(outcome.error);
      setAnnouncement(`${moved} was not moved. ${outcome.error}`);
      setFocusAfterMove({ code: moved, direction });
      return;
    }
    onChange(outcome.applied);
    setAnnouncement(`${moved} moved to position ${swapWith + 1} of ${codes.length}.`);
    setFocusAfterMove({ code: moved, direction });
  }

  const ownChips = ownCodes.filter((chip) => !appliedSet.has(chip.code));
  const guestChips = guestGroups
    .map((group) => ({ ...group, codes: group.codes.filter((chip) => !appliedSet.has(chip.code)) }))
    .filter((group) => group.codes.length > 0);

  return (
    <div className="space-y-3">
      <Label htmlFor="promoCode">Promo Code (optional)</Label>

      {codes.length > 0 && (
        <div className="space-y-2">
          {reorderable && (
            <p id="promo-code-order-hint" className="text-sm text-muted-foreground">
              Codes apply in this order. Where two codes could cover the same
              night, the earlier one does.
            </p>
          )}
          <ol
            aria-label="Promo codes on this booking, in the order they apply"
            aria-describedby={reorderable ? "promo-code-order-hint" : undefined}
            className="space-y-2"
          >
            {codes.map((promo, index) => (
              <li
                key={promo.code}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-success-3 p-3 text-sm"
              >
                <div className="text-success-11">
                  {reorderable && <span className="sr-only">{`${index + 1} of ${codes.length}: `}</span>}
                  <span className="font-mono font-medium">{promo.code}</span>
                  {promo.description && <span className="ml-2">- {promo.description}</span>}
                  {promo.appliesTo && (
                    <span className="ml-2 text-xs">(applies to {promo.appliesTo} only)</span>
                  )}
                  {showAmounts && (
                    <span className="ml-2">({formatSignedCents(promo.promoAdjustmentCents, format)})</span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {reorderable && (
                    <>
                      <Button
                        ref={(node) => {
                          moveButtons.current.set(`${promo.code}:up`, node);
                        }}
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Move ${promo.code} earlier`}
                        disabled={busy || index === 0}
                        onClick={() => moveCode(index, "up")}
                      >
                        <ArrowUp className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      <Button
                        ref={(node) => {
                          moveButtons.current.set(`${promo.code}:down`, node);
                        }}
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Move ${promo.code} later`}
                        disabled={busy || index === codes.length - 1}
                        onClick={() => moveCode(index, "down")}
                      >
                        <ArrowDown className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove ${promo.code}`}
                    disabled={busy}
                    onClick={() => removeCode(promo.code!)}
                    className="text-success-11 hover:text-success-11"
                  >
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      {canAddMore && ownChips.length > 0 && (
        <div className="app-callout-brand p-4">
          <p className="mb-2 text-sm font-medium text-foreground">You have promo codes available:</p>
          <div className="flex flex-wrap gap-2">
            {ownChips.map((chip) => (
              <button
                key={chip.code}
                type="button"
                disabled={busy}
                onClick={() => addCode(chip.code)}
                aria-label={`Apply ${chip.code}${chip.detail ? ` — ${chip.detail}` : ""}`}
                className="app-chip-brand font-mono"
              >
                {chip.code}
                {chip.detail && (
                  <span className="font-sans font-normal text-brand-charcoal">— {chip.detail}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {canAddMore && guestChips.length > 0 && (
        <div className="app-callout-brand space-y-3 p-4">
          <p className="text-sm font-medium text-foreground">
            Your guests have promo codes. Each one covers only that guest&apos;s nights:
          </p>
          {guestChips.map((group) => (
            <div key={group.guestName} role="group" aria-label={`${group.guestName}'s promo codes`}>
              <p className="mb-1 text-sm text-foreground">{group.guestName}</p>
              <div className="flex flex-wrap gap-2">
                {group.codes.map((chip) => (
                  <button
                    key={chip.code}
                    type="button"
                    disabled={busy}
                    onClick={() => addCode(chip.code, group.guestName)}
                    aria-label={`Apply ${chip.code}${chip.detail ? ` — ${chip.detail}` : ""}, applies to ${group.guestName} only`}
                    className="app-chip-brand font-mono"
                  >
                    {chip.code}
                    <span className="font-sans font-normal text-brand-charcoal">
                      {chip.detail ? ` — ${chip.detail}` : ""} (applies to {group.guestName} only)
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {(canAddMore || (disabled && codes.length === 0)) && (
        <div className="flex gap-2">
          <Input
            id="promoCode"
            value={code}
            onChange={(event) => {
              setCode(event.target.value.toUpperCase());
              setError("");
              setSelection(null);
            }}
            placeholder={codes.length > 0 ? "Add another promo code" : "Enter promo code"}
            className="flex-1"
            disabled={disabled}
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => addCode(code)}
            disabled={disabled || busy || !code.trim()}
          >
            {busy ? "Checking..." : "Apply"}
          </Button>
        </div>
      )}
      {disabled && disabledReason && <p className="text-sm text-muted-foreground">{disabledReason}</p>}

      {selection && (
        <fieldset className="rounded-md border p-3">
          <legend className="px-1 text-sm font-medium">Choose promo guests for {selection.code}</legend>
          <div className="space-y-2">
            {selection.selectable.map((index) => (
              <label key={index} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selection.chosen.includes(index)}
                  onChange={(event) =>
                    setSelection((current) =>
                      current && {
                        ...current,
                        chosen: event.target.checked
                          ? [...new Set([...current.chosen, index])].sort((a, b) => a - b)
                          : current.chosen.filter((value) => value !== index),
                      },
                    )
                  }
                  className="rounded border-input"
                />
                <span>{guestLabel(index)}</span>
              </label>
            ))}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            disabled={busy || selection.chosen.length === 0}
            onClick={() => addCode(selection.code, selection.appliesTo, selection.chosen)}
          >
            Apply Selected
          </Button>
        </fieldset>
      )}

      {error && <p className="text-sm text-danger-11">{error}</p>}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
