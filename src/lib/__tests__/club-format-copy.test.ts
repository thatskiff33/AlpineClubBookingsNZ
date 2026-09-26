import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CLUB_FORMAT_CARD_PAYMENTS,
  CLUB_FORMAT_PROVIDER_CURRENCIES,
  CLUB_FORMAT_REACH,
  CLUB_FORMAT_SERVER_SETTINGS,
  clubFormatCurrencyChangeAcknowledgement,
} from "@/lib/club-format-copy";
import { stripComments } from "./support/strip-comments";

/**
 * The three in-app surfaces that tell an operator what the Club Currency &
 * Locale setting reaches render ONE copy (#3566 review, `INV-SSOT`). All three
 * went on saying dates followed the server's `LOCALE` after #3566 made that
 * false, because each carried its own sentence. Disk-scanning: run by name.
 */
const SURFACES = [
  "src/app/(admin)/admin/club-format/page.tsx",
  "src/components/admin/club-format-panel.tsx",
  "src/lib/contextual-help/admin/setup-and-configuration.ts",
];

/** Phrases the pre-#3566 copy used, each of which is now false. */
const STALE = [
  /do not move yet/i,
  /Do not remove them yet/i,
  /keep them (?:matching|the same|in step)/i,
  /still follow(?:s|ing)? the server/i,
  /amounts do not yet/i,
];

describe("Club Currency & Locale copy has one home (#3566)", () => {
  it("renders the shared reach and server-settings copy on every surface", () => {
    for (const relative of SURFACES) {
      const code = stripComments(
        readFileSync(path.join(process.cwd(), relative), "utf8"),
      );
      expect(code, relative).toContain("CLUB_FORMAT_REACH");
      expect(code, relative).toContain("CLUB_FORMAT_SERVER_SETTINGS");
      for (const phrase of STALE) {
        expect(code, `${relative} still says ${phrase}`).not.toMatch(phrase);
      }
    }
  });

  it("says what is true: dates and emails follow, chart labels do not", () => {
    expect(CLUB_FORMAT_REACH).toMatch(/every date and time/);
    expect(CLUB_FORMAT_REACH).toMatch(/Emails follow/);
    expect(CLUB_FORMAT_REACH).toMatch(/report charts/);
    // #3567 D1: the server's CURRENCY no longer decides card payments either.
    expect(CLUB_FORMAT_SERVER_SETTINGS).toMatch(/not what cards are charged in/);
    expect(CLUB_FORMAT_SERVER_SETTINGS).not.toMatch(/still taken from the server/);
  });

  it("says card payments follow the setting, and Stripe and Xero must match (#3567 D1, D2, D8)", () => {
    expect(CLUB_FORMAT_CARD_PAYMENTS).toMatch(/charged in this currency/);
    expect(CLUB_FORMAT_CARD_PAYMENTS).toMatch(/already started stays/);
    // #3567 review: the retry window and the refund divergence are disclosed.
    expect(CLUB_FORMAT_CARD_PAYMENTS).toMatch(/first 24 hours/);
    expect(CLUB_FORMAT_CARD_PAYMENTS).toMatch(/refund of a payment taken before the change/);
    expect(CLUB_FORMAT_CARD_PAYMENTS).toMatch(/saved card charged later/);
    expect(CLUB_FORMAT_CARD_PAYMENTS).toMatch(/two decimal places/);
    expect(CLUB_FORMAT_CARD_PAYMENTS).not.toMatch(/configured with|conversation with/);
    expect(CLUB_FORMAT_PROVIDER_CURRENCIES).toMatch(/Stripe account/);
    expect(CLUB_FORMAT_PROVIDER_CURRENCIES).toMatch(/Xero organisation's base currency/);
    expect(clubFormatCurrencyChangeAcknowledgement("CHF")).toMatch(/Xero base currency are both CHF/);
  });

  // Round 2 of the #3628 review (B5): the copy called the chart labels "the
  // one exception" while the guide listed three. It must not count them at
  // all, and must point at the guide, which is the list.
  it("never claims a single exception, and defers to the guide's list", () => {
    const counted =
      /\b(?:one|only|single|sole|two|three|four|five)\s+(?:exception|thing|place|label|limitation)s?\b|\bthe only\b|\bexcept(?:ion)? for\b/i;
    expect(CLUB_FORMAT_REACH).not.toMatch(counted);
    expect(CLUB_FORMAT_REACH).toMatch(/\bguide\b/);
  });

  it("the guide's list names every known English-only label", () => {
    const guide = readFileSync(path.join(process.cwd(), "docs/guides/club-format.md"), "utf8");
    const start = guide.indexOf("**What does not follow it.**");
    expect(start).toBeGreaterThan(-1);
    const section = guide.slice(start, guide.indexOf("\n\n**", start + 1));
    for (const item of [
      /report charts/,
      /chore schedule/,
      /minimum-stay setup/,
      /subscription lockout/i,
      /public booking-policy page/i,
      /relative times/,
    ]) {
      expect(section, String(item)).toMatch(item);
    }
    expect(section, "the guide must not put a number on the list either").not.toMatch(
      /\b(?:Two|Three|Four|Five|Six) things\b/,
    );
  });
});
