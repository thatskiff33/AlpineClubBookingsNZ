"use client";

import { useId } from "react";

/**
 * #3536 (`INV-PAY-114`, owner decision 3 Oct 2026): HOW A HAND-SETTLED REFUND
 * WENT BACK, in the officer's own words.
 *
 * Shown on a financial review the club would pay back by hand. "Marked paid by
 * hand" covers cash and bank transfers recorded outside Xero alike, so the app
 * cannot tell them apart and never guesses: the officer says. Leaving it
 * unanswered keeps the bank-transfer wording the note has always had.
 *
 * Words only. The answer changes what the Xero credit note says, never the
 * settlement, the booking's ledger line or the refund method underneath.
 */
const HAND_BACK_CHOICES: ReadonlyArray<{ inCash: boolean; label: string }> = [
  { inCash: false, label: "By bank transfer" },
  { inCash: true, label: "In cash" },
];

export function HandBackMethodChoice({
  handedBackInCash,
  onChange,
}: {
  handedBackInCash: boolean | null;
  onChange: (inCash: boolean) => void;
}) {
  const helpId = useId();
  return (
    <fieldset className="space-y-2" aria-describedby={helpId}>
      <legend className="text-sm font-medium">
        How did the club pay the member back?
      </legend>
      <p id={helpId} className="text-xs text-muted-foreground">
        This only changes the wording on the Xero credit note. If you leave it
        blank, the note says it was refunded by bank transfer.
      </p>
      {HAND_BACK_CHOICES.map((choice) => {
        const id = `manual-refund-task-hand-back-${choice.inCash ? "cash" : "bank"}`;
        return (
          <label
            key={id}
            htmlFor={id}
            className="flex gap-2 rounded-md border border-border p-2 text-sm"
          >
            <input
              type="radio"
              id={id}
              name="manual-refund-task-hand-back"
              className="mt-1"
              checked={handedBackInCash === choice.inCash}
              onChange={() => onChange(choice.inCash)}
            />
            <span className="font-medium">{choice.label}</span>
          </label>
        );
      })}
    </fieldset>
  );
}
