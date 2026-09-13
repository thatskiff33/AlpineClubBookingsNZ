"use client";

/**
 * The warning an officer sees where their season schedule has a hole (#2938).
 *
 * Two admin screens list seasons — Fees → Hut Fees, which creates them, and
 * Seasons, which adjusts their windows — and both are places the hole can be
 * closed, so both show this. One component rather than two renderings of the
 * same sentence: the wording of a money-adjacent warning is exactly the kind of
 * thing that drifts when it is typed twice (`INV-SSOT-001`).
 *
 * ## It warns; it never prices
 *
 * Nothing here extends a window, fills a hole, or suggests an amount. A booking
 * landing in the gap is still refused by the pricing engine, and that refusal
 * stays the safety property — the issue's contract is explicit that gaps warn
 * and must not invent coverage. What the panel buys is the officer finding out
 * in September, on the screen that can fix it, rather than in July when a
 * member's booking fails to price.
 *
 * ## Accessibility
 *
 * A gap is a standing fact about data already on screen, not the outcome of
 * something the officer just did, so this is ordinary prose — NOT a live
 * region. A `role="alert"` here would be announced on arrival, ahead of the
 * page's own heading, once per hole, and would interrupt whatever the user was
 * reading whenever the list reloads. `FocusedActionError` next door is the
 * right shape for the other case: a refusal the officer's own Save produced.
 *
 * `role="note"` rather than a named `<section>`, which was the first shape
 * here. A named section is a `region` LANDMARK, and a club with three holes in
 * its schedule would put three of them in the landmark list, ahead of and
 * competing with the page's real ones. `note` marks the block as the aside it
 * is without that cost, and the prose carries its own name — the second
 * sentence names both seasons — so nothing is lost by not labelling it.
 *
 * The dates are read out in the club's own medium format, and the night count
 * is spelled out beside them, because "1 Oct 2026 — 30 Nov 2026" alone leaves a
 * one-night boundary error looking exactly like a correct boundary.
 */

import { formatClubDate } from "@/lib/club-time";
import type { SeasonCoverageGap } from "@/lib/season-timeline";

/** How a single hole reads in a sentence. */
function describeGap(gap: SeasonCoverageGap): string {
  const nights = gap.nights === 1 ? "1 night" : `${gap.nights} nights`;
  const window =
    gap.nights === 1
      ? formatClubDate(gap.firstUncoveredNight)
      : `${formatClubDate(gap.firstUncoveredNight)} to ${formatClubDate(gap.lastUncoveredNight)}`;
  return `${window} — ${nights}`;
}

/**
 * The hole between two seasons, rendered where it falls in the timeline.
 *
 * Named after the seasons on either side of it, because "after Winter 2026,
 * before Summer 2026-27" is how an officer holds the schedule in their head,
 * and it is also what tells them which of the two windows to move.
 */
export function SeasonCoverageGapNotice({ gap }: { gap: SeasonCoverageGap }) {
  return (
    <div
      role="note"
      className="rounded-md border border-dashed border-destructive/50 bg-destructive/5 p-3 text-sm"
    >
      <p className="font-semibold text-destructive">
        No season covers {describeGap(gap)}
      </p>
      <p className="mt-1 text-muted-foreground">
        {gap.afterSeasonName} ends the day before, and {gap.beforeSeasonName}{" "}
        starts the day after. A booking for one of these nights is refused
        because nothing prices it — nothing is charged at zero and no
        neighbouring season&apos;s rates are used instead. Extend one of the two
        windows, or add a season to cover the nights.
      </p>
    </div>
  );
}

/**
 * The count, before the officer scrolls — the same shape the missing-rates
 * summary above it uses, so the two read as one pair of answers to "is this
 * schedule ready?" rather than as two unrelated panels.
 */
export function SeasonCoverageGapSummary({
  gaps,
}: {
  gaps: readonly SeasonCoverageGap[];
}) {
  if (gaps.length === 0) return null;
  const totalNights = gaps.reduce((sum, gap) => sum + gap.nights, 0);
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
      <span className="font-semibold text-destructive">
        {gaps.length === 1
          ? "There is a gap in the season schedule."
          : `There are ${gaps.length} gaps in the season schedule.`}
      </span>{" "}
      {/*
        #2938 review — the singular is a WHOLE clause, not a swapped noun
        phrase. Reading the count alone out of the sentence left "One night is
        not covered …, and a booking for one of THEM is refused" — a plural
        pronoun under a singular count. It is not a stray nit: a one-night hole
        is exactly the boundary slip this count exists to make visible, so the
        singular branch is a likely real rendering rather than a theoretical
        one, and this repository has shipped an ungrammatical string pinned by a
        test before.
      */}
      {totalNights === 1
        ? "One night is not covered by any active season, and a booking that includes it is refused."
        : `${totalNights} nights are not covered by any active season, and a booking that includes one of them is refused.`}{" "}
      {gaps.length === 1
        ? "The gap is marked in the list below, between the seasons on either side of it."
        : "Each gap is marked in the list below, between the seasons on either side of it."}
    </div>
  );
}
