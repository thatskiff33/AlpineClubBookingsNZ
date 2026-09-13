// @vitest-environment jsdom

/**
 * The pricing screen as a SCHEDULE: seasons in order, holes warned about, and
 * one season copied onto a new one exactly (#2938).
 *
 * `season-timeline.test.ts` and `season-rate-grid.test.ts` pin the rules. These
 * cases exist because the rules being right is not the same as the screen being
 * right, and two of the three things this issue asks for can only fail in the
 * wiring:
 *
 * - the copy has to reach the API as a **POST of a new season**, not a PUT over
 *   the season the officer clicked. Nothing in the pure module can prove that;
 *   the proof is that no write addresses the source's id.
 * - the amounts have to arrive as the **integer cents the API returned**. The
 *   form draws its boxes from those cents and parses what it reads back out of
 *   them, so a copy that seeded the boxes as text instead of as cents would
 *   round-trip every amount through a decimal string — which is what #2932
 *   removed from this screen, and what an odd-cent rate below would catch.
 *
 * The frozen clock puts "today" at 2026-07-01; every season edge is written
 * against that instant rather than against the real calendar.
 */

import "@testing-library/jest-dom/vitest";
import { useEffect } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const AGE_TIERS = [
  { tier: "ADULT", minAge: 18, maxAge: null, label: "Adult (18+)", sortOrder: 0 },
];

type SeasonPayload = {
  id: string;
  name: string;
  type: string;
  startDate: string;
  endDate: string;
  active: boolean;
  flatWholeLodgeNightCents: number | null;
  membershipTypeRates: Array<{
    membershipTypeId: string;
    ageTier: string | null;
    pricePerNightCents: number;
  }>;
};

function season(overrides: Partial<SeasonPayload> = {}): SeasonPayload {
  return {
    id: "season-winter",
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

function mockApi(seasons: SeasonPayload[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/admin/age-tier-settings")) {
        return Response.json({ settings: AGE_TIERS });
      }
      if (url.startsWith("/api/admin/membership-types")) {
        return Response.json({ membershipTypes: [FULL, NON_MEMBER] });
      }
      if (url.startsWith("/api/admin/seasons")) {
        return Response.json(seasons);
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

/** Every write this form made, with the URL it addressed. */
function writes(): Array<{ url: string; method: string; body: Record<string, unknown> }> {
  const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock
    .calls as Array<[string, RequestInit | undefined]>;
  return calls
    .filter(([, init]) => init?.method === "PUT" || init?.method === "POST")
    .map(([url, init]) => ({
      url: String(url),
      method: String(init?.method),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    }));
}

function ratesOf(body: Record<string, unknown>) {
  return body.membershipTypeRates as Array<{
    membershipTypeId: string;
    ageTier: string | null;
    pricePerNightCents: number;
  }>;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.setSystemTime(new Date(FROZEN_TEST_CLOCK_BASE_ISO));
});

describe("Hut Fees lists the seasons in order and warns about holes (#2938)", () => {
  it("orders the seasons chronologically, whatever order the API returned", async () => {
    mockApi([
      season({ id: "summer", name: "Summer 2026-27", startDate: "2026-10-01T00:00:00.000Z", endDate: "2027-04-30T00:00:00.000Z" }),
      season({ id: "winter", name: "Winter 2026" }),
    ]);
    renderSection();

    await screen.findByText("Winter 2026");
    // Read the DOM order directly rather than a list of names: the card title
    // is a styled `div`, so there is no heading role to enumerate, and the
    // question is only ever "does summer come after winter on the page".
    expect(
      screen
        .getByText("Winter 2026")
        .compareDocumentPosition(screen.getByText("Summer 2026-27")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("names the nights nothing prices, and counts them", async () => {
    mockApi([
      season({ id: "winter", name: "Winter 2026" }),
      season({ id: "summer", name: "Summer 2026-27", startDate: "2026-12-01T00:00:00.000Z", endDate: "2027-04-30T00:00:00.000Z" }),
    ]);
    renderSection();

    // October (31) + November (30) — the count is what makes a one-night
    // boundary slip visible rather than plausible.
    await screen.findByText(/No season covers 1 Oct 2026 to 30 Nov 2026 — 61 nights/);
    expect(
      screen.getByText(/There is a gap in the season schedule\./),
    ).toBeInTheDocument();
    // It warns; it never prices.
    expect(screen.queryByText(/\$0\.00/)).not.toBeInTheDocument();
  });

  it("says nothing about two seasons that abut", async () => {
    // 30 September is winter's last night; 1 October is summer's first. A
    // comparison asking only `next.start > previous.end` warns here, on every
    // correctly configured club.
    mockApi([
      season({ id: "winter", name: "Winter 2026" }),
      season({ id: "summer", name: "Summer 2026-27", startDate: "2026-10-01T00:00:00.000Z", endDate: "2027-04-30T00:00:00.000Z" }),
    ]);
    renderSection();

    await screen.findByText("Winter 2026");
    expect(screen.queryByText(/No season covers/)).not.toBeInTheDocument();
    expect(screen.queryByText(/gap in the season schedule/)).not.toBeInTheDocument();
  });

  it("does not let a DEACTIVATED window in the hole close it", async () => {
    // Every pricing path loads `active: true`, so a booking for October is
    // refused. The window is still listed — it is usually the explanation.
    mockApi([
      season({ id: "winter", name: "Winter 2026" }),
      season({ id: "retired", name: "Shoulder 2026", startDate: "2026-10-01T00:00:00.000Z", endDate: "2026-11-30T00:00:00.000Z", active: false }),
      season({ id: "summer", name: "Summer 2026-27", startDate: "2026-12-01T00:00:00.000Z", endDate: "2027-04-30T00:00:00.000Z" }),
    ]);
    renderSection();

    await screen.findByText(/No season covers 1 Oct 2026 to 30 Nov 2026/);
    expect(screen.getByText("Shoulder 2026")).toBeInTheDocument();
  });
});

describe("Hut Fees copies a season exactly (#2938)", () => {
  /**
   * A season with one priced type, one deliberate hole, and an odd-cent rate.
   *
   * 45.05 is not a round dollar on purpose: an amount that round-tripped
   * through the box's displayed text would be at risk here, and a round number
   * would survive the trip and prove nothing.
   */
  function sourceSeason() {
    return season({
      flatWholeLodgeNightCents: 60050,
      membershipTypeRates: [
        { membershipTypeId: FULL.id, ageTier: null, pricePerNightCents: 4505 },
      ],
    });
  }

  async function openTheCopy() {
    await screen.findByText("Winter 2026");
    fireEvent.click(screen.getByRole("button", { name: "New season from this" }));
    await screen.findByText("New Season");
  }

  it("opens a NEW season, not an edit of the one clicked", async () => {
    mockApi([sourceSeason()]);
    renderSection();
    await openTheCopy();

    expect(screen.queryByText("Edit Season")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create Season" }),
    ).toBeInTheDocument();
  });

  it("requires the officer to give it its own name and window", async () => {
    // The copy carries configuration, never identity. Inheriting the source's
    // name and dates would produce a season overlapping the one it came from,
    // under the same name, on one click.
    mockApi([sourceSeason()]);
    renderSection();
    await openTheCopy();

    expect(screen.getByLabelText("Season Name")).toHaveValue("");
    expect(screen.getByLabelText("Start Date")).toHaveValue("");
    expect(screen.getByLabelText("End Date")).toHaveValue("");
    for (const field of ["Season Name", "Start Date", "End Date"]) {
      expect(screen.getByLabelText(field)).toBeRequired();
    }
  });

  it("pre-loads the source's rates, its type and its whole-lodge rate", async () => {
    mockApi([sourceSeason()]);
    renderSection();
    await openTheCopy();

    expect(document.getElementById(`rate-${FULL.id}::FLAT`)).toHaveValue("45.05");
    // The hole stays a hole: an empty box, not "0.00".
    expect(document.getElementById(`rate-${NON_MEMBER.id}::FLAT`)).toHaveValue("");
    expect(screen.getByLabelText(/Flat whole-lodge night rate/)).toHaveValue("600.50");
  });

  it("POSTs a new season with the exact cents, and never writes to the source", async () => {
    mockApi([sourceSeason()]);
    renderSection();
    await openTheCopy();

    fireEvent.change(screen.getByLabelText("Season Name"), {
      target: { value: "Winter 2027" },
    });
    fireEvent.change(screen.getByLabelText("Start Date"), {
      target: { value: "2027-06-01" },
    });
    fireEvent.change(screen.getByLabelText("End Date"), {
      target: { value: "2027-09-30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Season" }));

    await waitFor(() => expect(writes()).toHaveLength(1));
    const write = writes()[0]!;

    // A POST to the collection. The source season is never mutated, and the
    // mechanism is that the form holds no id to address it by.
    expect(write.method).toBe("POST");
    expect(write.url).toBe("/api/admin/seasons");
    expect(write.url).not.toContain("season-winter");
    expect(write.body).toMatchObject({
      name: "Winter 2027",
      startDate: "2027-06-01",
      endDate: "2027-09-30",
      type: "WINTER",
      active: true,
      flatWholeLodgeNightCents: 60050,
    });
    expect(write.body).not.toHaveProperty("id");

    // Exact integer cents, and NO row for the cell the source had no rate for.
    // A zero row here would price every non-member guest of the new season at
    // nothing and silence the missing-rates warning that should follow it.
    expect(ratesOf(write.body)).toEqual([
      { membershipTypeId: FULL.id, ageTier: null, pricePerNightCents: 4505 },
    ]);
  });

  it("carries a deliberate $0.00 rate across as a zero", async () => {
    // The other half of the same rule: absence is withheld, a typed zero is
    // real configuration and the club that means it keeps it.
    mockApi([
      season({
        membershipTypeRates: [
          { membershipTypeId: FULL.id, ageTier: null, pricePerNightCents: 4500 },
          { membershipTypeId: NON_MEMBER.id, ageTier: null, pricePerNightCents: 0 },
        ],
      }),
    ]);
    renderSection();
    await openTheCopy();

    expect(document.getElementById(`rate-${NON_MEMBER.id}::FLAT`)).toHaveValue("0.00");

    fireEvent.change(screen.getByLabelText("Season Name"), {
      target: { value: "Winter 2027" },
    });
    fireEvent.change(screen.getByLabelText("Start Date"), {
      target: { value: "2027-06-01" },
    });
    fireEvent.change(screen.getByLabelText("End Date"), {
      target: { value: "2027-09-30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Season" }));

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(ratesOf(writes()[0]!.body)).toContainEqual({
      membershipTypeId: NON_MEMBER.id,
      ageTier: null,
      pricePerNightCents: 0,
    });
  });
});
