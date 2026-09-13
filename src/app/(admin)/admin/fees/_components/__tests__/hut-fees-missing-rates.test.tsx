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
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
