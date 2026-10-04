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
  type GuestPromoChipGroup,
  type PromoCodeListEntry,
  type PromoListValidation,
} from "@/components/promo-code-list-client";
import { PromoCodeChips, type PromoChipOption } from "@/components/promo-code-chips";
import { DUPLICATE_PROMO_CODE_MESSAGE, normalizePromoCodeInput } from "@/lib/promo-code-list-rules";
import { formatSignedCents } from "@/lib/utils";

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
 *   is the amount in this order; a change the server refuses — an add, a move
 *   or a removal — leaves the list as it was, and says why.
 * - **Focus is never dropped.** After a code is applied focus moves to its
 *   Remove button (the chip or the entry box it came from may be gone); after
 *   a removal, to the next code's Remove button, else the previous one, else
 *   the entry box, else the list itself.
 * - A working-bee discount on the list (D-3813-3) is not one of the booker's
 *   codes: it is never drawn here and always handed back with the codes.
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
  const [focusAfterChange, setFocusAfterChange] = useState<{ remove: string | null } | null>(null);
  const moveButtons = useRef(new Map<string, HTMLButtonElement | null>());
  const removeButtons = useRef(new Map<string, HTMLButtonElement | null>());
  const inputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const codes = applied.filter((promo) => promo.code && !promo.workPartyEvent);
  const otherDiscounts = applied.filter((promo) => !promo.code || promo.workPartyEvent);
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

  useEffect(() => {
    if (!focusAfterChange) return;
    const target =
      (focusAfterChange.remove ? removeButtons.current.get(focusAfterChange.remove) : null) ??
      inputRef.current ??
      containerRef.current;
    target?.focus();
    setFocusAfterChange(null);
  }, [focusAfterChange]);

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
    const next = normalizePromoCodeInput(rawCode);
    if (!next) {
      setError("Please enter a promo code");
      return;
    }
    if (appliedSet.has(next)) {
      setError(`${next}: ${DUPLICATE_PROMO_CODE_MESSAGE}`);
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
    setFocusAfterChange({ remove: next });
    setAnnouncement(
      codes.length === 0
        ? `${next} applied.`
        : `${next} applied, position ${outcome.applied.length} of ${outcome.applied.length}.`,
    );
  }

  async function removeCode(target: string) {
    const index = codes.findIndex((promo) => promo.code === target);
    const remaining = codes.filter((promo) => promo.code !== target);
    // Where focus goes once the button it was on is gone: the code that takes
    // this one's place, else the one before it, else the entry box.
    const neighbour = remaining[index]?.code ?? remaining[index - 1]?.code ?? null;
    if (remaining.length === 0) {
      onChange(otherDiscounts);
      setAnnouncement(`${target} removed.`);
      setFocusAfterChange({ remove: null });
      return;
    }
    const outcome = await run(promoCodeListEntries(remaining));
    if (!outcome.ok) {
      // The codes left would not price as they are: keep the list exactly as it
      // was — every code the booking holds stays held — and say why, as a
      // refused move does.
      setError(outcome.error);
      setAnnouncement(`${target} was not removed. ${outcome.error}`);
      return;
    }
    onChange(outcome.applied);
    setAnnouncement(`${target} removed.`);
    setFocusAfterChange({ remove: neighbour });
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
    <div
      ref={containerRef}
      tabIndex={-1}
      aria-label="Promo codes"
      className="space-y-3 focus:outline-none"
    >
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
                    ref={(node) => {
                      removeButtons.current.set(promo.code!, node);
                    }}
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

      {canAddMore && (
        <PromoCodeChips
          ownCodes={ownChips}
          guestGroups={guestChips}
          disabled={busy}
          onPick={(chip, appliesTo) => addCode(chip, appliesTo)}
        />
      )}

      {(canAddMore || (disabled && codes.length === 0)) && (
        <div className="flex gap-2">
          <Input
            ref={inputRef}
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
