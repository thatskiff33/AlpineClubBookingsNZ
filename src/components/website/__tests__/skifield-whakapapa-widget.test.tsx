// @vitest-environment jsdom

import {
  CLUB_TIME_TEST_ZONE,
  render,
  screen,
  waitFor,
  within,
} from "@/lib/__tests__/support/club-time-render";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkifieldWhakapapaWidget } from "@/components/website/skifield-whakapapa-widget";
import { ClubTimeProvider } from "@/components/club-time-provider";
import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";
import {
  emptyWhakapapaCurlData,
  type WhakapapaCurlData,
} from "@/lib/whakapapa-report";

// Covers the Trails section UI: the difficulty key (green circle Beginner,
// blue square Intermediate, black diamond Advanced, red diamond Expert) and the
// per-trail shape markers that replaced the plain difficulty wording.

function payloadWithTrails(): WhakapapaCurlData {
  const data = emptyWhakapapaCurlData();
  data.updated = "2026-07-30T00:00:00.000Z";
  data.trails = [
    {
      name: "Happy Valley Area",
      trails: [
        {
          name: "Happy Valley",
          status: "Open",
          groomed: true,
          difficulty: "Beginner",
          size: "",
        },
        {
          name: "Yankee Face",
          status: "Coming Soon",
          groomed: false,
          difficulty: "Expert",
          size: "",
        },
      ],
    },
  ];
  return data;
}

describe("SkifieldWhakapapaWidget trails", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => payloadWithTrails(),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the difficulty key in the Trails header", async () => {
    render(<SkifieldWhakapapaWidget />);

    const key = await screen.findByRole("list", {
      name: /trail difficulty key/i,
    });
    for (const label of ["Beginner", "Intermediate", "Advanced", "Expert"]) {
      expect(within(key).getByText(label)).toBeTruthy();
    }
  });

  it("shows each trail's difficulty as an accessible shape marker, not wording", async () => {
    render(<SkifieldWhakapapaWidget />);

    // The trail name renders, and its difficulty is conveyed by a labelled
    // shape marker (role=img) rather than the word inside the row.
    expect(await screen.findByText("Yankee Face")).toBeTruthy();
    expect(screen.getByLabelText("Difficulty: Expert")).toBeTruthy();
    expect(screen.getByLabelText("Difficulty: Beginner")).toBeTruthy();

    // Sub-area heading still renders.
    expect(screen.getByText("Happy Valley Area")).toBeTruthy();
  });

  it("hides the Trails section when visibility.trails is false", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => {
        const data = payloadWithTrails();
        data.visibility.trails = false;
        return data;
      },
    });
    render(<SkifieldWhakapapaWidget />);

    await waitFor(() =>
      expect(screen.getByText("Whakapapa Conditions")).toBeTruthy(),
    );
    // The difficulty key only exists inside the Trails section.
    expect(
      screen.queryByRole("list", { name: /trail difficulty key/i }),
    ).toBeNull();
    expect(screen.queryByText("Happy Valley Area")).toBeNull();
  });
});

describe("SkifieldWhakapapaWidget status styling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function payloadWithLiftStatus(status: string): WhakapapaCurlData {
    const data = emptyWhakapapaCurlData();
    data.updated = "2026-07-30T00:00:00.000Z";
    data.lifts = [{ name: "Sky Waka", status }];
    return data;
  }

  const CASES: [string, string, string][] = [
    // [status, expected text-color class, expected bg class]
    ["Open", "text-success-11", "bg-success-3"],
    ["Closed", "text-danger-11", "bg-danger-3"],
    ["Coming Soon", "text-muted-foreground", "bg-muted"],
    ["On Hold", "text-warning-11", "bg-warning-3"],
    ["Unknown", "text-muted-foreground", "bg-muted"],
  ];

  it.each(CASES)(
    "styles the %s status badge with its matching colour",
    async (status, textClass, bgClass) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => payloadWithLiftStatus(status),
        }),
      );
      render(<SkifieldWhakapapaWidget />);

      const badge = await screen.findByText(status);
      expect(badge.className).toContain(textClass);
      expect(badge.className).toContain(bgClass);
    },
  );
});

describe("SkifieldWhakapapaWidget trail sub-area layout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function trail(name: string) {
    return {
      name,
      status: "Open",
      groomed: true,
      difficulty: "Beginner",
      size: "",
    };
  }

  function payloadWithAreas(
    areas: { name: string; trailNames: string[] }[],
  ): WhakapapaCurlData {
    const data = emptyWhakapapaCurlData();
    data.updated = "2026-07-30T00:00:00.000Z";
    data.trails = areas.map((area) => ({
      name: area.name,
      trails: area.trailNames.map(trail),
    }));
    return data;
  }

  function mockPayload(payload: WhakapapaCurlData) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => payload }),
    );
  }

  it("puts two consecutive small sub-areas (<4 trails each) on one row", async () => {
    mockPayload(
      payloadWithAreas([
        { name: "Happy Valley Area", trailNames: ["Happy Valley"] },
        { name: "Rangatira Area", trailNames: ["Rockgarden", "Tennants Valley"] },
      ]),
    );
    render(<SkifieldWhakapapaWidget />);

    const areaA = await screen.findByText("Happy Valley Area");
    const areaB = screen.getByText("Rangatira Area");

    // Each area is a column stack with its name ON TOP of its trails, and both
    // area stacks share the SAME combined flex-wrap row (their grandparent).
    expect(areaA.parentElement?.className).toContain("flex-col");
    expect(areaB.parentElement?.className).toContain("flex-col");
    expect(areaA.parentElement?.parentElement).toBe(
      areaB.parentElement?.parentElement,
    );
    expect(areaA.parentElement?.parentElement?.className).toContain(
      "flex-wrap",
    );

    // No trails from either area are lost.
    for (const name of ["Happy Valley", "Rockgarden", "Tennants Valley"]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
  });

  it("keeps a 4+ trail sub-area as its own stacked block", async () => {
    mockPayload(
      payloadWithAreas([
        {
          name: "Sky Waka Area",
          trailNames: ["K Road", "Honeymoon", "Staircase", "Terraces"],
        },
        { name: "Happy Valley Area", trailNames: ["Happy Valley"] },
      ]),
    );
    render(<SkifieldWhakapapaWidget />);

    // The 4-trail area stacks its name ABOVE its trails (name parent is not a
    // flex-wrap row), so it is not merged onto a line with the small area.
    const bigArea = await screen.findByText("Sky Waka Area");
    expect(bigArea.parentElement?.className ?? "").not.toContain("flex-wrap");
  });

  it("keeps a lone small sub-area (no small neighbour) as its own block", async () => {
    mockPayload(
      payloadWithAreas([
        {
          name: "Sky Waka Area",
          trailNames: ["K Road", "Honeymoon", "Staircase", "Terraces"],
        },
        { name: "Happy Valley Area", trailNames: ["Happy Valley", "Rockgarden"] },
      ]),
    );
    render(<SkifieldWhakapapaWidget />);

    // The 2-trail area's only neighbour is large, so the pair rule does not fire
    // and it stays a stacked block.
    const loneSmall = await screen.findByText("Happy Valley Area");
    expect(loneSmall.parentElement?.className ?? "").not.toContain("flex-wrap");
  });
});


/**
 * THE PUBLIC SIDE OF THE SAME RULE (CT-4, #2870; epic #2988; INV-CONFIG-002).
 *
 * This is the only surface in this group reached through the OTHER mount point:
 * `website/website-chrome.tsx` wraps the two public route groups, and
 * `skifield-whakapapa-embed.tsx` wraps this widget on the one page outside them.
 * It is also the surface with the most obviously global audience — a visitor
 * reading the conditions from Sydney and one reading them at the lodge must be
 * told the report was updated at the same moment, in the club's words.
 *
 * Same fixture, two provider zones, two answers. Everything above renders through
 * the harness default and asserts trails and layout, which no zone can move; they
 * are correctly left as they are.
 */
describe("SkifieldWhakapapaWidget updated stamp (CT-4, #2870)", () => {
  /** Behind UTC, so it disagrees with the harness zone and with a UTC host. */
  const CLUB_ZONE_BEHIND_UTC = "America/Denver";

  /** The report's `updated` field, which the two zones read as different DAYS. */
  const UPDATED = "2026-07-30T00:00:00.000Z";

  function providerFor(zone: string) {
    return function PinnedClubTime({ children }: { children: ReactNode }) {
      return <ClubTimeProvider zone={zone}>{children}</ClubTimeProvider>;
    };
  }

  function spelledIn(zone: string): string {
    return bindClubTime(requireClubTimeZone(zone)).instantDateTime(
      new Date(UPDATED),
    );
  }

  beforeEach(() => {
    const data = emptyWhakapapaCurlData();
    data.updated = UPDATED;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => data }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("spells Updated in a Denver club's evening, not New Zealand's midday", async () => {
    // PREMISE, as an ANSWER rather than an identifier: the two zones really do
    // disagree about this instant, and by a whole day.
    expect(spelledIn(CLUB_ZONE_BEHIND_UTC)).toBe("29 Jul 2026, 6:00 pm");
    expect(spelledIn(CLUB_TIME_TEST_ZONE)).toBe("30 Jul 2026, 12:00 pm");

    const { container } = render(<SkifieldWhakapapaWidget />, {
      wrapper: providerFor(CLUB_ZONE_BEHIND_UTC),
    });

    await waitFor(() =>
      expect(container.textContent).toContain(
        spelledIn(CLUB_ZONE_BEHIND_UTC),
      ),
    );
    expect(container.textContent).not.toContain(
      spelledIn(CLUB_TIME_TEST_ZONE),
    );
  });

  it("follows a DIFFERENT club zone for the same report", async () => {
    // The mirror image, and it is what makes the case above about the PROVIDER
    // rather than about a hard-coded 29 July.
    const { container } = render(<SkifieldWhakapapaWidget />, {
      wrapper: providerFor(CLUB_TIME_TEST_ZONE),
    });

    await waitFor(() =>
      expect(container.textContent).toContain(spelledIn(CLUB_TIME_TEST_ZONE)),
    );
    expect(container.textContent).not.toContain(
      spelledIn(CLUB_ZONE_BEHIND_UTC),
    );
  });
});
