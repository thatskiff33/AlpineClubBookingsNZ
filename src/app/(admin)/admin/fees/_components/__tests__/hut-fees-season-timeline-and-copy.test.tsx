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

import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import "@testing-library/jest-dom/vitest";
import { useEffect } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FROZEN_TEST_CLOCK_BASE_ISO } from "@/lib/__tests__/helpers/clock";
import {
  expectRecoveryAlertToHoldFocus,
  expectRevealed,
  installScrollIntoViewSpy,
  removeScrollIntoViewSpy,
} from "@/lib/__tests__/helpers/focus";

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

import { ClubFormatProvider } from "@/components/club-format-provider";
import { ClubTimeProvider } from "@/components/club-time-provider";
import {
  CLUB_CURRENCY_FALLBACK,
  CLUB_LOCALE_FALLBACK,
} from "@/lib/club-format";
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
    // #3564: the club's currency reaches the nightly-rate labels through a
    // provider, so the stack this suite builds by hand mounts both. The
    // shipped defaults, so every `(NZD)` pin below means what it meant before.
    <ClubFormatProvider
      currencyCode={CLUB_CURRENCY_FALLBACK}
      locale={CLUB_LOCALE_FALLBACK}
    >
      <ClubTimeProvider zone="Pacific/Auckland" locale={CLUB_FORMAT_TEST.locale}>
        <HutFeesSection canEdit={true} />
      </ClubTimeProvider>
    </ClubFormatProvider>,
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

    await screen.findByRole("heading", { name: "Winter 2026" });
    // Enumerating the heading list IS the order question, now that each card
    // title claims a level (#2938 review) — and it is the same list a screen
    // reader offers, so this asserts what such a user is actually handed.
    expect(
      screen
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(["Winter 2026", "Summer 2026-27"]);
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

/**
 * A season with one priced type, one deliberate hole, and an odd-cent rate.
 *
 * 45.05 is not a round dollar on purpose: an amount that round-tripped through
 * the box's displayed text would be at risk here, and a round number would
 * survive the trip and prove nothing.
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
  fireEvent.click(
    screen.getByRole("button", { name: "New season from this: Winter 2026" }),
  );
  await screen.findByRole("heading", { name: "New Season" });
}

/** Open the edit form for the one seeded season. */
async function openTheEdit() {
  await screen.findByText("Winter 2026");
  fireEvent.click(screen.getByRole("button", { name: "Edit Winter 2026" }));
  await screen.findByRole("heading", { name: "Edit Season" });
}

describe("Hut Fees copies a season exactly (#2938)", () => {
  it("opens a NEW season, not an edit of the one clicked", async () => {
    mockApi([sourceSeason()]);
    renderSection();
    await openTheCopy();

    expect(
      screen.queryByRole("heading", { name: "Edit Season" }),
    ).not.toBeInTheDocument();
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

describe("Hut Fees is navigable without seeing it (#2938)", () => {
  const SUMMER = season({
    id: "summer",
    name: "Summer 2026-27",
    startDate: "2026-10-01T00:00:00.000Z",
    endDate: "2027-04-30T00:00:00.000Z",
  });

  it("gives the section, and every season card, a level in the page outline", async () => {
    // The page's <h1> is "Fees". Without these levels the schedule is a
    // headingless run of cards with gap notices interleaved, and a screen
    // reader's heading list — one of the two main ways such a user moves around
    // a page — is empty below the page title.
    mockApi([sourceSeason(), SUMMER]);
    renderSection();

    await screen.findByRole("heading", { name: "Winter 2026" });
    expect(
      screen.getByRole("heading", { level: 2, name: "Hut fees" }),
    ).toBeInTheDocument();
    expect(
      screen
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(["Winter 2026", "Summer 2026-27"]);
  });

  it("names all four of a card's buttons after its season", async () => {
    // Two seasons used to give EIGHT buttons carrying four labels between them.
    // A screen-reader user picking "New season from this" out of a control list
    // had nothing to tell the two apart — and the copy deliberately carries no
    // name or dates, so choosing wrongly produced a season with the other one's
    // rates and no confirmation either way.
    mockApi([sourceSeason(), { ...SUMMER, active: false }]);
    renderSection();

    await screen.findByText("Winter 2026");
    for (const name of [
      "Deactivate Winter 2026",
      "Edit Winter 2026",
      "New season from this: Winter 2026",
      "Delete Winter 2026",
      "Activate Summer 2026-27",
      "Edit Summer 2026-27",
      "New season from this: Summer 2026-27",
      "Delete Summer 2026-27",
    ]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("keeps each visible label at the start of its accessible name", async () => {
    // WCAG 2.5.3: a voice-control user says what they can see, so the
    // accessible name has to EXTEND the visible text, never replace it.
    mockApi([sourceSeason()]);
    renderSection();

    const copy = await screen.findByRole("button", {
      name: "New season from this: Winter 2026",
    });
    expect(copy).toHaveTextContent("New season from this");
  });
});

describe("Hut Fees says what a copy carried, and takes the officer to it (#2938)", () => {
  it("names the season it was pre-filled from, and what did and did not cross", async () => {
    mockApi([sourceSeason()]);
    renderSection();
    await openTheCopy();

    const text = (
      screen.getByText(/Pre-filled from/).textContent ?? ""
    ).replace(/\s+/g, " ");
    // The three facts the guide and the code comment both state carefully and
    // the screen never showed: that it is pre-filled, from WHAT, and what did
    // and did not come across with it.
    expect(text).toContain("Pre-filled from Winter 2026");
    expect(text).toContain("Its name and dates did not");
    expect(text).toContain("arrives blank here rather than as 0.00");
    expect(text).toContain("does not change Winter 2026");
  });

  it("moves focus into the form, so the next Tab reaches the name field", async () => {
    // Opening the form only SCROLLED a container, which moves no focus and
    // speaks no message: a keyboard user stayed on the button at the bottom of
    // the list, and tabbing forward landed on the next season's card rather
    // than in the form that had just opened.
    mockApi([sourceSeason()]);
    renderSection();
    await openTheCopy();

    await expectRecoveryAlertToHoldFocus(screen.getByText(/Pre-filled from/));
  });

  it("says nothing of the sort for an ordinary Edit", async () => {
    // The notice is a statement about a COPY. An edit is not one, and claiming
    // an edit was pre-filled from the season it IS would be false.
    mockApi([sourceSeason()]);
    renderSection();
    await openTheEdit();

    expect(screen.queryByText(/Pre-filled from/)).not.toBeInTheDocument();
  });

  it("drops the notice when the form is cancelled and reopened as a new season", async () => {
    mockApi([sourceSeason()]);
    renderSection();
    await openTheCopy();
    expect(screen.getByText(/Pre-filled from/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByText(/Pre-filled from/)).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Add season" }));
    await screen.findByRole("heading", { name: "New Season" });
    expect(screen.queryByText(/Pre-filled from/)).not.toBeInTheDocument();
  });
});

describe("Hut Fees draws the whole-lodge box from its one home (#2938)", () => {
  /*
    The flat whole-lodge amount is the one that prices the entire building, and
    the box that seeds it hand-rolled both halves of the absence-versus-zero
    display rule twenty lines below the rate boxes that take it from the shared
    helper. These pin the behaviour that substitution had to preserve, so the
    field cannot drift back to its own copy of the rule unnoticed.
  */
  it("leaves the box EMPTY when the season sets no whole-lodge rate", async () => {
    mockApi([season({ flatWholeLodgeNightCents: null })]);
    renderSection();
    await openTheEdit();

    expect(screen.getByLabelText(/Flat whole-lodge night rate/)).toHaveValue("");
  });

  it("shows a deliberate zero as 0.00, which is not the same box as empty", async () => {
    // Absence means "whole-lodge bookings are priced per guest"; zero means
    // "the whole building costs nothing a night". Rendering both as an empty
    // box is exactly the confusion #2933 removed from the rate grid.
    mockApi([season({ flatWholeLodgeNightCents: 0 })]);
    renderSection();
    await openTheEdit();

    expect(screen.getByLabelText(/Flat whole-lodge night rate/)).toHaveValue(
      "0.00",
    );
  });

  it("shows an odd-cent amount without rounding it", async () => {
    mockApi([season({ flatWholeLodgeNightCents: 60005 })]);
    renderSection();
    await openTheEdit();

    expect(screen.getByLabelText(/Flat whole-lodge night rate/)).toHaveValue(
      "600.05",
    );
  });
});

describe("Hut Fees takes the officer to the form it opens (#2934)", () => {
  // Edit and Copy sit at the BOTTOM of the seasons list; the form they open
  // renders at the top of this card. They used to call the SUCCESS primitive to
  // do it, which positions at the top of the target's scroll container — the
  // same mis-routing this issue fixed in `family-groups`, and one that looked
  // correct here only because Hut Fees happens to sit at the top of the Fees
  // page. Opening a form is a REVEAL.
  it("reveals the named Hut fees region on Edit", async () => {
    const scrollIntoView = installScrollIntoViewSpy();
    try {
      mockApi([sourceSeason()]);
      renderSection();
      await screen.findByText("Winter 2026");
      // Loading the list reveals nothing: only an explicit action moves anyone.
      expect(scrollIntoView).not.toHaveBeenCalled();

      await openTheEdit();

      expectRevealed(
        scrollIntoView,
        screen.getByRole("region", { name: "Hut fees" }),
      );
    } finally {
      removeScrollIntoViewSpy();
    }
  });

  it("reveals it again on Copy, where the copy notice then takes focus", async () => {
    const scrollIntoView = installScrollIntoViewSpy();
    try {
      mockApi([sourceSeason()]);
      renderSection();
      await screen.findByText("Winter 2026");

      await openTheCopy();

      // Not `expectRevealed`: the copy announces WHAT was copied and from what,
      // in a paragraph that has to exist before it can be focused, so its
      // effect runs after the reveal and legitimately wins the focus. The
      // viewport move is still this issue's, and is what is asserted.
      const region = screen.getByRole("region", { name: "Hut fees" });
      expect(scrollIntoView.mock.instances).toEqual([region]);
      expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: "smooth",
        block: "start",
      });
    } finally {
      removeScrollIntoViewSpy();
    }
  });
});
