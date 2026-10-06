"use client";

import type { GuestPromoChipGroup } from "@/components/promo-code-list-client";

/** A chip the booker can opt into: the code and one line saying what it gives. */
export type PromoChipOption = { code: string; detail: string | null };

/**
 * THE promo-code chips (#2266, #3492; `INV-SSOT-001`): the booker's own codes,
 * and each guest's codes grouped under every guest who holds them and marked
 * "applies to … only", because a guest's code covers only that guest's nights.
 * Pure presentation — what a press does is the caller's (`onPick`): the list
 * editor applies the code, the one-code edit card fills its input.
 *
 * Each chip is a real button whose accessible name says the code, what it
 * gives and, for a guest's code, whose nights it covers; each guest group is a
 * named group.
 */
export function PromoCodeChips({
  ownCodes,
  guestGroups,
  disabled = false,
  onPick,
}: {
  ownCodes: readonly PromoChipOption[];
  guestGroups: readonly GuestPromoChipGroup[];
  disabled?: boolean;
  onPick: (code: string, appliesTo?: string) => void;
}) {
  const detail = (chip: PromoChipOption) => (chip.detail ? ` — ${chip.detail}` : "");
  return (
    <>
      {ownCodes.length > 0 && (
        <div className="app-callout-brand p-4">
          <p className="mb-2 text-sm font-medium text-foreground">You have promo codes available:</p>
          <div className="flex flex-wrap gap-2">
            {ownCodes.map((chip) => (
              <button
                key={chip.code}
                type="button"
                disabled={disabled}
                onClick={() => onPick(chip.code)}
                aria-label={`Apply ${chip.code}${detail(chip)}`}
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

      {guestGroups.length > 0 && (
        <div className="app-callout-brand space-y-3 p-4">
          <p className="text-sm font-medium text-foreground">
            Your guests have promo codes. Each one covers only that guest&apos;s nights:
          </p>
          {guestGroups.map((group) => (
            <div key={group.key} role="group" aria-label={`Promo codes held by ${group.holders}`}>
              <p className="mb-1 text-sm text-foreground">{group.holders}</p>
              <div className="flex flex-wrap gap-2">
                {group.codes.map((chip) => (
                  <button
                    key={chip.code}
                    type="button"
                    disabled={disabled}
                    onClick={() => onPick(chip.code, group.holders)}
                    aria-label={`Apply ${chip.code}${detail(chip)}, applies to ${group.holders} only`}
                    className="app-chip-brand font-mono"
                  >
                    {chip.code}
                    <span className="font-sans font-normal text-brand-charcoal">
                      {detail(chip)} (applies to {group.holders} only)
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
