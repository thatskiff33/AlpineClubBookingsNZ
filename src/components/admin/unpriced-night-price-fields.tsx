"use client";

import { FieldHint, useFieldHint } from "@/components/ui/field-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  MONEY_INPUT_PROPS,
  parseDecimalDollarsToCents,
} from "@/lib/money-input";
import { formatCents } from "@/lib/utils";
import { formatClubDate, type CalendarDate } from "@/lib/club-time";
import {
  unpricedNightsExplanation,
  type StoredNightPriceRepairCheck,
  type UnpricedNightsSummary,
} from "@/lib/stored-night-price-repair";

/**
 * #3191: the part of the settle screen that asks what a booking's unpriced
 * nights sold for.
 *
 * ## Why it is here and not in the queue component
 *
 * `manual-refund-task-queue.tsx` is already the largest file on this surface and
 * carries two cards, a dialog and the whole settlement conversation. The seam is
 * a real one rather than a line-count dodge: this is one question with one rule,
 * and everything it needs arrives as props - it holds no state, decides nothing,
 * and makes no request.
 *
 * ## What it deliberately does NOT do
 *
 * IT NEVER FILLS A BOX IN. Not on open, not from the remaining balance, not from
 * the last night typed. `INV-MOD-028` prohibits deriving a historical amount, and
 * the cheapest way to honour that on a screen is to have nothing that could do
 * it: there is no "split evenly" control, no default, and no placeholder that
 * reads as a value. The running total below the boxes is a CHECK on what the
 * officer typed, not a source for it - it says what the figures come to and what
 * they need to come to, and the officer closes the gap themselves.
 *
 * The one thing it will not do even when asked is fill in some boxes and leave
 * others: the check it renders refuses a partial answer rather than completing
 * it, which is the same rule the server applies to the same input.
 */
export function UnpricedNightPriceFields({
  summary,
  values,
  onChange,
  targetKnown,
  check,
  disabled,
}: {
  summary: UnpricedNightsSummary;
  /** The raw text in each night's box, keyed by lodge night. */
  values: Readonly<Record<string, string>>;
  onChange: (date: CalendarDate, value: string) => void;
  /**
   * Whether the amount these nights have to come to can be worked out yet. On a
   * review completion it depends on the direction and the settlement figure, so
   * it is false until the officer has given both - and saying so is better than
   * showing a target computed from half an answer.
   */
  targetKnown: boolean;
  /** The shared verdict, or null while nothing has been typed. */
  check: StoredNightPriceRepairCheck | null;
  disabled: boolean;
}) {
  const hint = useFieldHint();
  const enteredCents = summary.dates.reduce((sum, date) => {
    const parsed = parseNightInput(values[date] ?? "");
    return parsed === null ? sum : sum + parsed;
  }, 0);

  return (
    <fieldset className="space-y-3" data-testid="unpriced-night-price-fields">
      <legend className="text-sm font-medium">
        What did these nights sell for?
      </legend>
      <p className="text-xs text-muted-foreground">
        {unpricedNightsExplanation(summary)}
      </p>
      <div className="space-y-2">
        {summary.dates.map((date) => (
          <div key={date} className="flex items-center gap-2">
            <Label
              htmlFor={`unpriced-night-${date}`}
              className="w-40 shrink-0 text-sm font-normal"
            >
              {formatClubDate(date)}
            </Label>
            <span className="text-sm">$</span>
            <Input
              id={`unpriced-night-${date}`}
              {...MONEY_INPUT_PROPS}
              className="w-28"
              value={values[date] ?? ""}
              disabled={disabled}
              onChange={(event) => onChange(date, event.target.value)}
              {...(date === summary.dates[0] ? hint.fieldProps : {})}
            />
          </div>
        ))}
      </div>
      <FieldHint {...hint.hintProps}>
        Example: 45.00 — a free night is 0.00, which is a real price and not the
        same as leaving it blank.
      </FieldHint>
      {/*
        The running total. Two figures, always both: what has been typed and what
        it has to come to. Showing only the remainder would hand the officer the
        last night's price, which is the derivation this screen exists to avoid.
      */}
      {targetKnown && check ? (
        <p
          className={
            check.ok
              ? "text-xs text-muted-foreground"
              : "text-xs text-warning-11"
          }
          data-testid="unpriced-night-price-reconciliation"
        >
          {check.ok
            ? `These nights come to ${formatCents(enteredCents)}, which is what this guest's stay works out to. Recording them stops this booking coming back here.`
            : check.message}
        </p>
      ) : null}
      {!targetKnown ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="unpriced-night-price-target-unknown"
        >
          Say which way the money goes and how much first — what these nights
          have to add up to depends on both.
        </p>
      ) : null}
    </fieldset>
  );
}

/**
 * One box, in cents, or null when it holds nothing usable.
 *
 * The parent builds the entries it posts from these same boxes, so it calls THIS
 * rather than the parser directly: two parses of one string is how a screen ends
 * up showing a total it did not submit. Everything about the money grammar is
 * still the canonical parser's (`INV-MONEY-003`); this adds only the "blank
 * means not typed" distinction, which that parser deliberately does not make -
 * it answers null for a malformed amount too, and the caller tells them apart by
 * whether the box is empty.
 */
export function parseNightInput(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return parseDecimalDollarsToCents(trimmed);
}
