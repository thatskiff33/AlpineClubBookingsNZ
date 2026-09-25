// @vitest-environment jsdom
/**
 * The club's STORED locale decides every date, on the server and in the
 * browser, and the server's `LOCALE` does not (#3566, stage 4 of programme
 * #3205; INV-CONFIG-006).
 *
 * Three properties, each with its premise asserted rather than assumed:
 *
 *  1. `clubTime()` binds the persisted locale: stored en-NZ beats `LOCALE=de-CH`,
 *     and stored de-CH beats `LOCALE=en-NZ`. The environment seed is read LIVE
 *     (`club-format-env.ts`), so the premise — with nothing stored, `LOCALE`
 *     really does answer — is checkable, which is what makes the two precedence
 *     cases discriminating.
 *  2. A client binding built from the same stored locale renders the same string
 *     as the server binding, so a server-rendered date and its hydrated twin
 *     cannot disagree. Before #3566 the server read `LOCALE` and the browser
 *     `NEXT_PUBLIC_LOCALE`, which could differ.
 *  3. The health dashboard's row stamp follows the binding's locale too (it used
 *     to take a separate locale argument, beside a "Last refresh" line that did
 *     not follow the club at all).
 */
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stored = vi.hoisted(() => ({
  row: null as null | { currencyCode: string; locale: string },
}));

vi.mock("@/lib/club-time-zone-settings", () => ({
  getClubTimeZone: async () => "Pacific/Auckland",
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    clubFormatSettings: {
      findUnique: async () =>
        stored.row
          ? { ...stored.row, updatedAt: new Date(0), updatedByMemberId: null }
          : null,
    },
  },
}));

import { formatDate as formatHealthStamp } from "@/app/(admin)/admin/health/_components/shared";
import { ClubTimeProvider, useClubTime } from "@/components/club-time-provider";
import { clubTime } from "@/lib/club-time/server";
import { ClubFormatTestProvider } from "@/lib/__tests__/support/club-time-render";

const AT = new Date("2026-03-16T02:30:00.000Z");

function inLocale(locale: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: "Pacific/Auckland",
    ...options,
  }).format(AT);
}
const MEDIUM_DATE_TIME: Intl.DateTimeFormatOptions = {
  dateStyle: "medium",
  timeStyle: "short",
};

const savedEnv = { LOCALE: process.env.LOCALE, NEXT: process.env.NEXT_PUBLIC_LOCALE };

beforeEach(() => {
  stored.row = null;
  delete process.env.NEXT_PUBLIC_LOCALE;
});

afterEach(() => {
  if (savedEnv.LOCALE === undefined) delete process.env.LOCALE;
  else process.env.LOCALE = savedEnv.LOCALE;
  if (savedEnv.NEXT === undefined) delete process.env.NEXT_PUBLIC_LOCALE;
  else process.env.NEXT_PUBLIC_LOCALE = savedEnv.NEXT;
});

describe("#3566: clubTime() binds the STORED locale", () => {
  it("premise: with nothing stored, the environment's LOCALE really answers", async () => {
    process.env.LOCALE = "de-CH";
    const club = await clubTime();
    expect(club.format).toEqual({ locale: "de-CH" });
  });

  it("stored en-NZ wins over LOCALE=de-CH", async () => {
    process.env.LOCALE = "de-CH";
    stored.row = { currencyCode: "NZD", locale: "en-NZ" };
    const club = await clubTime();
    expect(club.format).toEqual({ locale: "en-NZ" });
    expect(club.instantDateTime(AT)).toBe(inLocale("en-NZ", MEDIUM_DATE_TIME));
  });

  it("stored de-CH wins over LOCALE=en-NZ", async () => {
    process.env.LOCALE = "en-NZ";
    stored.row = { currencyCode: "CHF", locale: "de-CH" };
    const club = await clubTime();
    expect(club.instantDateTime(AT)).toBe(inLocale("de-CH", MEDIUM_DATE_TIME));
    expect(club.instantDateTime(AT)).not.toBe(inLocale("en-NZ", MEDIUM_DATE_TIME));
  });
});

function Stamp({ at }: { at: Date }) {
  return <span data-testid="stamp">{useClubTime().instantDateTime(at)}</span>;
}

describe("#3566: a server-rendered date and its hydrated twin agree", () => {
  it("renders the same de-CH string on both sides of the network", async () => {
    process.env.LOCALE = "en-NZ";
    process.env.NEXT_PUBLIC_LOCALE = "en-NZ";
    stored.row = { currencyCode: "CHF", locale: "de-CH" };
    const server = (await clubTime()).instantDateTime(AT);

    const { getByTestId } = render(
      <ClubFormatTestProvider>
        <ClubTimeProvider zone="Pacific/Auckland" locale="de-CH">
          <Stamp at={AT} />
        </ClubTimeProvider>
      </ClubFormatTestProvider>,
    );
    expect(getByTestId("stamp").textContent).toBe(server);
    expect(server).toBe(inLocale("de-CH", MEDIUM_DATE_TIME));
  });

  it("an unusable locale prop falls back to the default rather than blanking", () => {
    const { getByTestId } = render(
      <ClubFormatTestProvider>
        <ClubTimeProvider zone="Pacific/Auckland" locale="not a tag">
          <Stamp at={AT} />
        </ClubTimeProvider>
      </ClubFormatTestProvider>,
    );
    expect(getByTestId("stamp").textContent).toBe(
      inLocale("en-NZ", MEDIUM_DATE_TIME),
    );
  });
});

describe("#3566: the health dashboard stamps follow the binding's locale", () => {
  it("writes the compact stamp in de-CH for a de-CH club, and en-NZ otherwise", async () => {
    stored.row = { currencyCode: "CHF", locale: "de-CH" };
    const swiss = await clubTime();
    stored.row = { currencyCode: "NZD", locale: "en-NZ" };
    const kiwi = await clubTime();
    const compact: Intl.DateTimeFormatOptions = {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    };
    expect(formatHealthStamp(swiss, AT.toISOString())).toBe(inLocale("de-CH", compact));
    expect(formatHealthStamp(kiwi, AT.toISOString())).toBe(inLocale("en-NZ", compact));
    // The "Last refresh" line is the binding's `instantTime`, so it follows too.
    expect(swiss.instantTime(AT)).toBe("15:30");
    expect(kiwi.instantTime(AT)).toBe(inLocale("en-NZ", { timeStyle: "short" }));
  });
});
