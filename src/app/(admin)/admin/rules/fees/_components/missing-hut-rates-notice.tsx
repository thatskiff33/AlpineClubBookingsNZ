"use client";

/**
 * "This season cannot price every guest yet" — the pricing-screen half of
 * `INV-MOD-007` (#2933).
 *
 * The Hut Fees grid already showed "Not set" in a rate cell, which is true and
 * says nothing about what it costs: an officer reading it has no way to tell a
 * deliberately blank cell from one that will refuse a member's booking, and
 * nothing on the screen adds the cells up. The only place the club was told was
 * the setup-readiness page, which is visited once at installation — so a
 * membership type added in March, after the season was created, was first
 * noticed when somebody tried to book.
 *
 * This is a WARNING, never a price. It invents nothing, substitutes nothing,
 * and changes no amount: pricing still refuses at runtime when a required rate
 * is absent, and that refusal stays the safety property. The gaps themselves are
 * computed by the one shared rule in `@/lib/membership-type-rate-coverage`, and
 * so is the season scope, so this screen and the readiness report ask one
 * question of one rule: the same types owe rows, the same seasons are in scope,
 * and the same club day bounds them. The screen asks it of the lodge on screen,
 * which is the only difference between the two.
 *
 * One caveat the officer copy deliberately does not carry, because the outcome
 * it promises is right either way: pricing only ever loads ACTIVE seasons, so a
 * booking landing in an INACTIVE future season is refused for want of a season
 * rather than for want of this rate. The rate is what refuses it the moment the
 * season is switched on, which is what the officer is being warned to fix.
 */

import type { MembershipTypeRateGap } from "@/lib/membership-type-rate-coverage";

/** What one gap reads as in a sentence, with the club's own tier labels. */
function describeMissing(
  gap: MembershipTypeRateGap,
  tierLabel: (tier: string) => string,
): string {
  return gap.missing.kind === "flat"
    ? "no flat all-ages rate"
    : `no rate for ${gap.missing.tiers.map(tierLabel).join(", ")}`;
}

export function MissingHutRatesNotice({
  gaps,
  tierLabel,
}: {
  gaps: readonly MembershipTypeRateGap[];
  /** The club's label for an age tier — a club may name or run its own set. */
  tierLabel: (tier: string) => string;
}) {
  if (gaps.length === 0) return null;
  return (
    /*
      No live region. This renders with the page rather than in response to
      anything the officer just did, and an assertive region that fires on load
      interrupts a screen-reader user reading the heading they arrived at. It is
      an ordinary part of the document, found by its heading like the rest of it.
    */
    <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3">
      <h4 className="text-sm font-semibold text-destructive">
        Missing nightly rates
      </h4>
      <p className="mt-1 text-sm text-muted-foreground">
        A booking that needs one of these rates is refused until you set it. No
        rate is assumed, nothing is charged at zero, and no other membership
        type&apos;s rate is used instead.
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
        {gaps.map((gap) => (
          <li key={`${gap.seasonId}::${gap.membershipTypeId}`}>
            <span className="font-medium">{gap.membershipTypeName}</span>
            {" — "}
            {describeMissing(gap, tierLabel)}
          </li>
        ))}
      </ul>
    </div>
  );
}
