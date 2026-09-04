"use client";

import { useId, useState } from "react";

import { describedByFieldHint, FieldHint } from "@/components/ui/field-hint";
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
 * and everything it needs arrives as props - it decides nothing and makes no
 * request. The one thing it holds is which boxes the officer has LEFT, which is
 * a fact about this fieldset's own focus and about nothing else on the screen;
 * the answer itself still lives entirely in `values`.
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
  explanation,
  legend = "What did these nights sell for?",
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
  /**
   * The paragraph above the boxes, when this fieldset is asked for by an act
   * other than settling a review (#3214).
   *
   * A STRING RATHER THAN A FLAG, and the copy itself still lives in the rule
   * module beside the refusals it belongs with (`INV-SSOT`): this component is
   * the one thing on the screen that knows nothing about which act it serves,
   * and a caller passing a mode name would put that knowledge back in.
   *
   * Defaults to the settle screen's own paragraph, so #3191's call site is
   * unchanged byte for byte.
   */
  explanation?: string;
  /**
   * The fieldset's heading. The default is the settle screen's, whose "these
   * nights" means the review's blanks; the reconcile path asks about every night
   * a guest holds and says so.
   */
  legend?: string;
  disabled: boolean;
}) {
  /*
    #3191 fix round. Deterministic ids rather than `useFieldHint()`, because
    EVERY box is described by the same two paragraphs and a hook cannot be
    called per row - the `.map()` case `field-hint.tsx` names, with
    `describedByFieldHint` as its helper.

    Two problems this fixes, both of which land hardest on a screen-reader user:

     1. the verdict was announced to nobody. The confirm button is DISABLED
        behind this paragraph, so a reader who cannot see it is left with a
        control that will not press and no reason given - which is the bare
        refusal the owner's 31 Aug 2026 decision rejected on the sibling $0.00
        control, in the same dialog. It is listed FIRST in every box's
        `aria-describedby` and carries `aria-live`, because "this is wrong, and
        here is why" is heard before "here is an example" and because the figure
        changes as the officer types.
     2. the hint was on the FIRST box only. "A free night is 0.00, which is a
        real price and not the same as leaving it blank" is the single sentence
        that keeps this feature honest, and a night in the middle of the list is
        exactly where somebody wonders it.
  */
  const statusId = useId();
  const hintId = useId();
  /*
    Which boxes the officer has moved away from. The verdict is SAID at every
    keystroke and only said LOUDLY once they have finished, and "filled in" is
    not the same as "finished": on a single-blank strand - the ordinary shape -
    the box holds text from the very first digit, so typing the `4` of `45.00`
    turned the paragraph red mid-number. That is the exact effect this rule
    exists to remove, and an earlier draft of it claimed to have removed it while
    measurably leaving it in place.

    Leaving the box is the cheapest honest signal that an answer is finished. It
    costs nothing to produce - moving to the next box, to the note, or to the
    confirm button all fire it - and it cannot be wrong in the direction that
    matters, because a refusal said quietly still says everything it said before.
    The SENTENCE never changes; only how loudly it is said.
  */
  const [boxesLeft, setBoxesLeft] = useState<Readonly<Record<string, boolean>>>(
    {},
  );
  const everyBoxAnswered = summary.dates.every(
    (date) => (values[date] ?? "").trim() !== "" && boxesLeft[date] === true,
  );

  return (
    <fieldset className="space-y-3" data-testid="unpriced-night-price-fields">
      <legend className="text-sm font-medium">{legend}</legend>
      <p className="text-xs text-muted-foreground">
        {explanation ?? unpricedNightsExplanation(summary)}
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
              onBlur={() =>
                setBoxesLeft((current) => ({ ...current, [date]: true }))
              }
              aria-describedby={describedByFieldHint(hintId, statusId)}
            />
          </div>
        ))}
      </div>
      {/*
        The running total, and the ONE live region on this fieldset. Two figures,
        always both: what has been typed and what it has to come to. Showing only
        the remainder would hand the officer the last night's price, which is the
        derivation this screen exists to avoid.

        PERMANENTLY MOUNTED, empty when it has nothing to say, for the reason
        `focused-action-error.tsx` records: a live region injected already
        populated is silently dropped by some screen-reader/browser pairings, so
        the first verdict an officer typed their way to would be the one nobody
        heard.
      */}
      <p
        id={statusId}
        aria-live="polite"
        className={
          !targetKnown || check === null || check.ok || !everyBoxAnswered
            ? "text-xs text-muted-foreground"
            : "text-xs text-warning-11"
        }
        data-testid={
          targetKnown
            ? "unpriced-night-price-reconciliation"
            : "unpriced-night-price-target-unknown"
        }
      >
        {!targetKnown
          ? "Say which way the money goes and how much first — what these nights have to add up to depends on both."
          : check === null
            ? ""
            : check.ok
              ? /*
                  #3191 fix round: the checker's OWN figure, not a second sum of
                  the same boxes taken here. On the ok branch `targetCents` is
                  equal to that sum by construction, and two derivations of one
                  number on money copy an officer reads as a receipt is how the
                  screen ends up printing a total it did not submit.
                */
                `These nights come to ${formatCents(check.targetCents)}, which is what this guest's stay works out to. Recording them stops this guest's nights sending the booking back here.`
              : check.message}
      </p>
      <FieldHint id={hintId}>
        Example: 45.00 — a free night is 0.00, which is a real price and not the
        same as leaving it blank.
      </FieldHint>
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
