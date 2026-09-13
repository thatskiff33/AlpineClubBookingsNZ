// @vitest-environment jsdom

/**
 * The pricing screen says which required nightly rates are missing, before an
 * ordinary booking reaches them (#2933, `INV-MOD-007`).
 *
 * The Hut Fees grid has always printed "Not set" in an empty rate cell. That is
 * true and it is not a warning: it does not say a booking will be REFUSED, it
 * appears identically for a cell a club deliberately left blank, and nothing on
 * the screen adds the cells up. The only place the club was actually told was
 * the setup-readiness page, visited once at installation — so a membership type
 * added in March, after the seasons were created, was first noticed when a
 * member's booking failed to price.
 *
 * Every case below drives the real section over a fake API. The frozen clock
 * puts "today" at 2026-07-01, and every season edge is written against that
 * instant rather than against the real calendar.
 */

import "@testing-library/jest-dom/vitest";
import { useEffect } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FROZEN_TEST_CLOCK_BASE_ISO } from "@/lib/__tests__/helpers/clock";

vi.mock("@/components/lodge-select", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/components/lodge-select");
  return {
    ...actual,
    initialLodgeIdFromLocation: () => null,
    useLodgeOptions: () => ({
      lodges: [{ id: "lodge-a", name: "Lodge A" }],
      loading: false,
      failed: false,
      forbidden: false,
      reload: vi.fn(),
    }),
    LodgeSelect: ({
      lodges,
      value,
      onChange,
    }: {
      lodges: ReadonlyArray<{ id: string; name: string }>;
      value: string | null;
      onChange: (value: string | null) => void;
    }) => {
      // The real selector settles on the club's only lodge; the section does no
      // lodge-scoped work until one is chosen (#2701).
      useEffect(() => {
        if (!value && lodges[0]) onChange(lodges[0].id);
      }, [lodges, onChange, value]);
      return <div data-testid="lodge-select" />;
    },
  };
});

import { ClubTimeProvider } from "@/components/club-time-provider";
import { HutFeesSection } from "../hut-fees-section";

const FULL = {
  id: "type-full",
  key: "FULL",
  name: "Full",
  bookingBehavior: "MEMBER_RATE",
  ageGroupsApply: false,
  isActive: true,
};
const NON_MEMBER = {
  id: "type-non-member",
  key: "NON_MEMBER",
  name: "Non-Member",
  bookingBehavior: "NON_MEMBER_RATE",
  ageGroupsApply: false,
  isActive: true,
};
/** Prices from the Non-Member rows; owes no rows of its own. */
const ASSOCIATE = {
  id: "type-associate",
  key: "ASSOCIATE",
  name: "Associate",
  bookingBehavior: "NON_MEMBER_RATE",
  ageGroupsApply: false,
  isActive: true,
};

const AGE_TIERS = [
  { tier: "CHILD", minAge: 5, maxAge: 17, label: "Child (5-17)", sortOrder: 0 },
  { tier: "ADULT", minAge: 18, maxAge: null, label: "Adult (18+)", sortOrder: 1 },
];

function season(overrides: Record<string, unknown> = {}) {
  return {
    id: "season-1",
    name: "Winter 2026",
    type: "WINTER",
    startDate: "2026-06-01T00:00:00.000Z",
    endDate: "2026-09-30T00:00:00.000Z",
    active: true,
    flatWholeLodgeNightCents: null,
    membershipTypeRates: [],
    ...overrides,
  };
}

function mockApi(options: {
  seasons: ReturnType<typeof season>[];
  membershipTypes?: typeof FULL[];
  ageTiers?: typeof AGE_TIERS;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/admin/age-tier-settings")) {
        return Response.json({ settings: options.ageTiers ?? AGE_TIERS });
      }
      if (url.startsWith("/api/admin/membership-types")) {
        return Response.json({
          membershipTypes: options.membershipTypes ?? [FULL, NON_MEMBER, ASSOCIATE],
        });
      }
      if (url.startsWith("/api/admin/seasons")) {
        return Response.json(options.seasons);
      }
      throw new Error(`unexpected request: ${url}`);
    }),
  );
}

function renderSection() {
  return render(
    <ClubTimeProvider zone="Pacific/Auckland">
      <HutFeesSection canEdit={true} />
    </ClubTimeProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  // A case that pins its own instant is left alone by the root re-freeze, so it
  // would leak into every case after it. Put the default back by hand.
  vi.setSystemTime(new Date(FROZEN_TEST_CLOCK_BASE_ISO));
});

describe("Hut Fees warns about missing required rates (#2933)", () => {
  it("names the type and says a booking would be refused", async () => {
    // Full is priced. Non-Member — the type every non-member guest prices from
    // — is not, which before this issue showed as nothing but a "Not set" cell.
    mockApi({
      seasons: [
        season({
          membershipTypeRates: [
            { membershipTypeId: FULL.id, ageTier: null, pricePerNightCents: 4500 },
          ],
        }),
      ],
    });
    renderSection();

    const heading = await screen.findByText("Missing nightly rates");
    expect(
      screen.getByText("One season is missing required nightly rates."),
    ).toBeInTheDocument();
    expect(screen.getByText("Missing rates")).toBeInTheDocument();
    // Inside the warning panel, not merely somewhere on a page that also lists
    // every type as a grid heading.
    const notice = heading.parentElement as HTMLElement;
    expect(within(notice).getByText("Non-Member")).toBeInTheDocument();
    expect(
      within(notice).getByText(/no flat all-ages rate/),
    ).toBeInTheDocument();
    expect(
      within(notice).getByText(/refused until you set it/i),
    ).toBeInTheDocument();
    // The warning is an early warning and never a price: it must not offer,
    // imply or substitute an amount of its own.
    expect(screen.queryByText(/\$0\.00/)).not.toBeInTheDocument();
  });

  it("says nothing about a type that owes no rates of its own", async () => {
    mockApi({
      seasons: [
        season({
          membershipTypeRates: [
            { membershipTypeId: FULL.id, ageTier: null, pricePerNightCents: 4500 },
            {
              membershipTypeId: NON_MEMBER.id,
              ageTier: null,
              pricePerNightCents: 6500,
            },
          ],
        }),
      ],
    });
    renderSection();

    // Associate is active and unpriced, and prices from the Non-Member rows:
    // warning about it would send an officer to set a rate nothing would read.
    await screen.findByText("Winter 2026");
    await waitFor(() =>
      expect(screen.getByText("$45.00")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Missing nightly rates")).not.toBeInTheDocument();
    expect(screen.queryByText("Associate")).not.toBeInTheDocument();
  });

  it("names only the tiers a club actually runs", async () => {
    // An age-keyed type on a CHILD + ADULT club. The club never prices INFANT or
    // YOUTH, so a warning naming them would be a false alarm (#2009).
    mockApi({
      seasons: [
        season({
          membershipTypeRates: [
            {
              membershipTypeId: FULL.id,
              ageTier: "ADULT",
              pricePerNightCents: 4500,
            },
          ],
        }),
      ],
      membershipTypes: [{ ...FULL, ageGroupsApply: true }],
    });
    renderSection();

    await screen.findByText("Missing nightly rates");
    expect(screen.getByText(/no rate for Child \(5-17\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Infant/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Youth/)).not.toBeInTheDocument();
  });

  it("treats a type's flat rate as covering every tier, on screen and in the warning", async () => {
    // The engine prefers an exact tier row and falls back to the flat row, so a
    // type priced entirely by one flat rate is fully configured. The grid used
    // to print "Not set" against every tier of it.
    mockApi({
      seasons: [
        season({
          membershipTypeRates: [
            { membershipTypeId: FULL.id, ageTier: null, pricePerNightCents: 4500 },
          ],
        }),
      ],
      membershipTypes: [{ ...FULL, ageGroupsApply: true }],
    });
    renderSection();

    await screen.findByText("Winter 2026");
    await waitFor(() =>
      expect(screen.getAllByText("$45.00 (flat rate)")).toHaveLength(2),
    );
    expect(screen.queryByText("Not set")).not.toBeInTheDocument();
    expect(screen.queryByText("Missing nightly rates")).not.toBeInTheDocument();
  });

  it("asks what day it is at the CLUB, not in the browser's timezone", async () => {
    /*
      Nothing else in this suite can tell the two apart. The suite runs in one
      zone and the repository's frozen instant — midday NZ — is chosen so that
      zone and UTC name the same day, so swapping `useClubTime().today()` for
      `new Date()` passes every other case here.

      13:00 UTC on 1 July is already 2 July in Auckland. "Winter 2026" ended
      last night at the club and is switched off, so its gaps are not work; a
      browser or host reading of the same instant still calls it today and would
      raise a warning the officer cannot act on. "Summer 2026" ends tomorrow and
      is the control: exactly one season is flagged, and it is that one.
    */
    vi.setSystemTime(new Date("2026-07-01T13:00:00.000Z"));
    mockApi({
      seasons: [
        season({
          id: "season-ended",
          name: "Winter 2026",
          active: false,
          startDate: "2026-06-01T00:00:00.000Z",
          endDate: "2026-07-01T00:00:00.000Z",
        }),
        season({
          id: "season-open",
          name: "Summer 2026",
          active: false,
          startDate: "2026-07-02T00:00:00.000Z",
          endDate: "2026-07-03T00:00:00.000Z",
        }),
      ],
    });
    renderSection();

    await screen.findByText("Missing nightly rates");
    expect(
      screen.getByText("One season is missing required nightly rates."),
    ).toBeInTheDocument();
    const badges = screen.getAllByText("Missing rates");
    expect(badges).toHaveLength(1);
    // The badge sits beside its season's title, so the flagged one is named.
    expect(badges[0]?.parentElement?.textContent).toContain("Summer 2026");
  });

  it("still asks for rates on an archived Non-Member, which still prices", async () => {
    /*
      Archiving a membership type is one click and is offered for every type —
      the built-in guard on the membership-type route covers deletion only. The
      engine resolves the built-in NON_MEMBER by key with no active filter, so
      an archived one still prices every non-member guest the club takes.

      Before this it disappeared from the fee grid — which filters on the same
      rule — so the officer could not set a rate, a new season got no rows for
      it, nothing warned, and the first public booking in that season threw.
    */
    mockApi({
      seasons: [
        season({
          membershipTypeRates: [
            { membershipTypeId: FULL.id, ageTier: null, pricePerNightCents: 4500 },
          ],
        }),
      ],
      membershipTypes: [FULL, { ...NON_MEMBER, isActive: false }, ASSOCIATE],
    });
    renderSection();

    const heading = await screen.findByText("Missing nightly rates");
    expect(
      within(heading.parentElement as HTMLElement).getByText("Non-Member"),
    ).toBeInTheDocument();
  });

  it("leaves a closed past season alone, and still warns about an active one", async () => {
    // "Today" is frozen at 2026-07-01. A season that ended in May and is
    // switched off cannot take another booking, so its gaps are not work.
    mockApi({
      seasons: [
        season({
          id: "season-old",
          name: "Winter 2025",
          active: false,
          startDate: "2025-06-01T00:00:00.000Z",
          endDate: "2025-09-30T00:00:00.000Z",
        }),
        season({ id: "season-next", name: "Summer 2026" }),
      ],
    });
    renderSection();

    await screen.findByText("Missing nightly rates");
    expect(
      screen.getByText("One season is missing required nightly rates."),
    ).toBeInTheDocument();
    // Exactly one season carries the badge, and it is not the closed one.
    expect(screen.getAllByText("Missing rates")).toHaveLength(1);
  });
});

/**
 * The screen must not close the gap it just warned about by writing a zero.
 *
 * `membershipTypeRates` is a REPLACE-ALL payload, so whatever this form submits
 * becomes the season's entire rate table. Until #2933's fix round the form held
 * every cell as a number and seeded the unset ones to `0`, so an officer who
 * opened the warned-about season and pressed Save — to fix the gap, or to change
 * the dates, or for no reason at all — wrote a real $0.00 row for every blank
 * cell. The gap check reads row keys rather than amounts, so the badge, the
 * count and the panel all disappeared, and every guest of that type was then
 * charged NOTHING instead of being refused.
 *
 * The fix is to hold "no rate" apart from "zero", which is what the flat
 * whole-lodge field two handlers below has always done. These cases pin both
 * halves: a blank cell is not submitted, and a zero somebody typed is.
 */
describe("Hut Fees never invents a rate on save (#2933)", () => {
  /** Every season write this form made, newest last. */
  function savedPayloads(): Array<Record<string, unknown>> {
    const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls as Array<[string, RequestInit | undefined]>;
    return calls
      .filter(([, init]) => init?.method === "PUT" || init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
  }

  function ratesOf(payload: Record<string, unknown>) {
    return payload.membershipTypeRates as Array<{
      membershipTypeId: string;
      ageTier: string | null;
      pricePerNightCents: number;
    }>;
  }

  /**
   * One type's flat rate box in the open editor, by id rather than by label:
   * the label text repeats once per membership type, and the id carries the
   * `::` separator the form keys its cells with, which is not a valid CSS
   * selector.
   */
  function flatRateBox(membershipTypeId: string): HTMLInputElement {
    const box = document.getElementById(`rate-${membershipTypeId}::FLAT`);
    if (!(box instanceof HTMLInputElement)) {
      throw new Error(`no flat rate box for ${membershipTypeId}`);
    }
    return box;
  }

  async function openTheSeasonEditor() {
    await screen.findByText("Winter 2026");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByText("Edit Season");
  }

  it("leaves a cell the panel warned about unset when the officer saves", async () => {
    mockApi({
      seasons: [
        season({
          membershipTypeRates: [
            { membershipTypeId: FULL.id, ageTier: null, pricePerNightCents: 4500 },
          ],
        }),
      ],
    });
    renderSection();
    await screen.findByText("Missing nightly rates");

    await openTheSeasonEditor();
    fireEvent.click(screen.getByRole("button", { name: "Update Season" }));

    await waitFor(() => expect(savedPayloads()).toHaveLength(1));
    const rates = ratesOf(savedPayloads()[0]!);
    // The Non-Member cell was blank and stays absent. A zero-cent row here is
    // the defect: it prices every non-member guest at nothing and silences the
    // warning that said they would be refused.
    expect(rates).toEqual([
      { membershipTypeId: FULL.id, ageTier: null, pricePerNightCents: 4500 },
    ]);
  });

  it("keeps a $0.00 rate somebody deliberately typed", async () => {
    mockApi({
      seasons: [
        season({
          membershipTypeRates: [
            { membershipTypeId: FULL.id, ageTier: null, pricePerNightCents: 4500 },
            {
              membershipTypeId: NON_MEMBER.id,
              ageTier: null,
              pricePerNightCents: 0,
            },
          ],
        }),
      ],
    });
    renderSection();
    await openTheSeasonEditor();

    // A stored zero is configuration and the box must SHOW it — rendering it as
    // an empty box is what made "never had a row" and "typed 0.00" the same
    // state, and it is the reason omitting blanks would have deleted it.
    expect(
      flatRateBox(NON_MEMBER.id).value,
    ).toBe("0.00");

    fireEvent.click(screen.getByRole("button", { name: "Update Season" }));
    await waitFor(() => expect(savedPayloads()).toHaveLength(1));
    expect(ratesOf(savedPayloads()[0]!)).toContainEqual({
      membershipTypeId: NON_MEMBER.id,
      ageTier: null,
      pricePerNightCents: 0,
    });
  });

  it("clears a rate rather than zeroing it when the officer empties the box", async () => {
    mockApi({
      seasons: [
        season({
          membershipTypeRates: [
            { membershipTypeId: FULL.id, ageTier: null, pricePerNightCents: 4500 },
            {
              membershipTypeId: NON_MEMBER.id,
              ageTier: null,
              pricePerNightCents: 6500,
            },
          ],
        }),
      ],
    });
    renderSection();
    await openTheSeasonEditor();

    fireEvent.change(flatRateBox(NON_MEMBER.id), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Update Season" }));

    await waitFor(() => expect(savedPayloads()).toHaveLength(1));
    expect(ratesOf(savedPayloads()[0]!)).toEqual([
      { membershipTypeId: FULL.id, ageTier: null, pricePerNightCents: 4500 },
    ]);
  });

  it("disables Save while the season write is in flight", async () => {
    /*
      Not decoration. The rate payload is now assembled BEFORE the save starts,
      so that a refusal can return without arming the button — and moving that
      assembly is how `setSaving(true)` came to be dropped entirely in the first
      draft of this fix, leaving Save live for the whole round trip and a second
      press able to send the season twice.
    */
    let releaseWrite: (() => void) | undefined;
    mockApi({
      seasons: [
        season({
          membershipTypeRates: [
            { membershipTypeId: FULL.id, ageTier: null, pricePerNightCents: 4500 },
          ],
        }),
      ],
    });
    const passThrough = globalThis.fetch as typeof fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PUT") {
          await new Promise<void>((resolve) => {
            releaseWrite = resolve;
          });
          return Response.json({});
        }
        return passThrough(input, init);
      }),
    );
    renderSection();
    await openTheSeasonEditor();

    const save = screen.getByRole("button", { name: "Update Season" });
    fireEvent.click(save);

    const saving = await screen.findByRole("button", { name: "Saving..." });
    expect(saving).toBeDisabled();
    releaseWrite?.();
    await waitFor(() =>
      expect(screen.queryByText("Saving...")).not.toBeInTheDocument(),
    );
  });

  it("refuses a save that would leave the season with no rates at all", async () => {
    mockApi({
      seasons: [
        season({
          membershipTypeRates: [
            { membershipTypeId: FULL.id, ageTier: null, pricePerNightCents: 4500 },
          ],
        }),
      ],
    });
    renderSection();
    await openTheSeasonEditor();

    fireEvent.change(flatRateBox(FULL.id), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Update Season" }));

    // Said in this screen's own words rather than as the API's "Validation
    // failed", and nothing is sent.
    expect(
      await screen.findByText(/at least one nightly rate/i),
    ).toBeInTheDocument();
    expect(savedPayloads()).toEqual([]);
  });
});
