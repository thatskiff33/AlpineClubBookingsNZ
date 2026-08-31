// @vitest-environment jsdom
//
// #3040 (epic #2943) — what the kiosk Group Trip block puts on the screen.
//
// ENFORCES INV-HOST-045 (docs/invariants/adult-member-hosting.md): a stale,
// failed or unrecorded evaluation must never READ as cover either, not merely be
// absent from the payload.
//
// This is the smaller half of the guard on purpose. The privacy boundary is in
// the PAYLOAD — `src/lib/__tests__/kiosk-group-trip-privacy.test.ts` and
// `src/app/api/lodge/guests/[date]/__tests__/group-trip-tiers.test.ts` — because
// a component cannot render what it was never sent. What is checked here is the
// half a payload test cannot see: that the four cover statuses are worded
// distinguishably, and that "not covered" never comes out looking positive.

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  KioskAdultCoverSourceLine,
  KioskGroupTripBadge,
  KioskGroupTripOrganiserLine,
} from "../kiosk-group-trip-card";

describe("#3040 the kiosk Group Trip block", () => {
  it("renders the trip ordinal, and nothing when there is no linkage", () => {
    const { container } = render(<KioskGroupTripBadge groupTrip={{ label: 2 }} />);
    expect(screen.getByText("Group trip 2")).toBeInTheDocument();
    // The ordinal is the WHOLE disclosure: no id anywhere in the markup, and no
    // tooltip or accessible name carrying one.
    expect(container.innerHTML).not.toMatch(/title=|aria-label=/);

    const { container: empty } = render(
      <KioskGroupTripBadge groupTrip={undefined} />,
    );
    expect(empty.innerHTML).toBe("");
  });

  it("renders organiser context only when it was sent", () => {
    const { container } = render(
      <KioskGroupTripOrganiserLine organiser={undefined} />,
    );
    expect(container.innerHTML).toBe("");

    render(
      <KioskGroupTripOrganiserLine
        organiser={{ isOrganiser: false, organiserName: "Olivia Organiser" }}
      />,
    );
    expect(
      screen.getByText("Group Trip organised by Olivia Organiser"),
    ).toBeInTheDocument();
  });

  it("says the organiser is unavailable rather than showing a blank name", () => {
    render(
      <KioskGroupTripOrganiserLine
        organiser={{ isOrganiser: false, organiserName: null }}
      />,
    );
    expect(
      screen.getByText("Group Trip organiser: not available"),
    ).toBeInTheDocument();
  });

  it("reports partial cover as partial, naming the source categories", () => {
    render(
      <KioskAdultCoverSourceLine
        cover={{
          status: "EVALUATED",
          nights: [
            { night: "2026-08-01", covered: true, scopes: ["SAME_GROUP_TRIP"] },
            { night: "2026-08-02", covered: false, scopes: [] },
          ],
          scopes: ["SAME_GROUP_TRIP"],
        }}
      />,
    );
    expect(screen.getByText(/1 of 2 nights covered/)).toBeInTheDocument();
    expect(
      screen.getByText(/Another booking in the same Group Trip/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Not covered: 2026-08-02/)).toBeInTheDocument();
  });

  it.each([
    ["STALE" as const, /needs re-checking/],
    ["UNREADABLE" as const, /could not be read/],
    ["NOT_RECORDED" as const, /not recorded/],
  ])("never renders %s as cover", (status, wording) => {
    const { container } = render(
      <KioskAdultCoverSourceLine
        cover={{ status, nights: [], scopes: [] }}
      />,
    );
    expect(screen.getByText(wording)).toBeInTheDocument();
    expect(
      container.textContent,
      "INV-HOST-045 (docs/invariants/adult-member-hosting.md): a " +
        `${status} evaluation must not read as covered`,
    ).not.toMatch(/covered/);
  });

  it("renders nothing at all when the cover capability was not granted", () => {
    const { container } = render(
      <KioskAdultCoverSourceLine cover={undefined} />,
    );
    expect(container.innerHTML).toBe("");
  });
});
