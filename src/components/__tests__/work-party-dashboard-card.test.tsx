import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import type { MemberWorkPartyDTO } from "@/lib/work-party-member";
import { WorkPartyDashboardCard } from "../work-party-dashboard-card";

/**
 * #5148: the dashboard's Work Parties card — a level-2 heading, one link per
 * work party, and nothing at all when none is upcoming.
 */
const workParty = (
  overrides: Partial<MemberWorkPartyDTO> = {},
): MemberWorkPartyDTO => ({
  id: "wp-1",
  name: "Spring Working Bee",
  description: null,
  startDate: "2026-07-10",
  endDate: "2026-07-12",
  discountPercent: 50,
  lodgeId: "lodge-1",
  lodgeName: "Main Lodge",
  join: { checkIn: "2026-07-10", checkOut: "2026-07-13" },
  ...overrides,
});

function render(workParties: MemberWorkPartyDTO[]) {
  return renderToStaticMarkup(
    <WorkPartyDashboardCard workParties={workParties} format={CLUB_FORMAT_TEST} />,
  );
}

describe("WorkPartyDashboardCard", () => {
  it("renders nothing when no work party is upcoming (owner decision, 20 Nov 2026)", () => {
    expect(render([])).toBe("");
  });

  it("lists each upcoming work party as a link to its page under /dashboard", () => {
    const html = render([
      workParty(),
      workParty({ id: "wp-2", name: "Autumn", lodgeName: null, endDate: "2026-07-10", startDate: "2026-07-10" }),
    ]);
    expect(html).toContain('href="/dashboard/work-parties/wp-1"');
    expect(html).toContain('href="/dashboard/work-parties/wp-2"');
    expect(html).toContain("Spring Working Bee");
    expect(html).toContain("Main Lodge");
    expect(html).toContain("Autumn");
    expect(html).not.toContain('href="/work-parties/');
  });

  it("titles the card as a level-2 heading under the dashboard's h1 (#4951)", () => {
    expect(render([workParty()])).toMatch(
      /role="heading" aria-level="2"[^>]*>\s*Work Parties/,
    );
  });
});
