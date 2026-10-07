// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@/lib/__tests__/support/club-time-render";
import { describe, expect, it } from "vitest";
import { GroupJoinVerifyPageClient } from "@/app/(website-dynamic)/join/verify/[token]/group-join-verify-page-client";

// #2919. "Confirm your email to finalise your spot at ..." named the CLUB'S
// DEFAULT lodge for every group, because the component held nothing but a token
// and the club identity. The copy renders before the joiner clicks Confirm, so
// the (mutating, POST-only) verify endpoint can never supply the name — the
// server page resolves it from the token and hands it down as a prop.

const club = {
  name: "Alpine Club",
  lodgeName: "Default Lodge",
} as unknown as Parameters<typeof GroupJoinVerifyPageClient>[0]["club"];

const TOKEN = "a".repeat(64);

describe("GroupJoinVerifyPageClient — lodge name (#2919)", () => {
  it("names the group's own lodge when the server resolved one", () => {
    render(
      <GroupJoinVerifyPageClient
        club={club}
        token={TOKEN}
        lodgeName="Second Lodge"
      />,
    );

    expect(
      screen.getByText(/finalise your spot at Second Lodge/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/spot at Default Lodge/i)).toBeNull();
  });

  it("falls back to the club's lodge name when the token resolved to nothing", () => {
    render(
      <GroupJoinVerifyPageClient club={club} token={TOKEN} lodgeName={null} />,
    );

    // An unknown token must read exactly as it always has, so the copy never
    // becomes a "does this token exist?" oracle.
    expect(
      screen.getByText(/finalise your spot at Default Lodge/i),
    ).toBeInTheDocument();
  });
});
