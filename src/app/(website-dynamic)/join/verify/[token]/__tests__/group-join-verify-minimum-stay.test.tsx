// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupJoinVerifyPageClient } from "@/app/(website-dynamic)/join/verify/[token]/group-join-verify-page-client";

// #2363. Minimum stay is re-checked when a non-member confirms their emailed
// link, so the rules can have tightened since they asked to join. That answer
// is a 409 of its own — NOT the "group stopped accepting joins" story — and
// the person reading it needs to know nothing was booked and who to ask.

const club = {
  name: "Alpine Club",
  lodgeName: "The Lodge",
} as unknown as Parameters<typeof GroupJoinVerifyPageClient>[0]["club"];

function jsonResponse(data: unknown, status: number) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let verifyResponse: () => Response;

beforeEach(() => {
  verifyResponse = () =>
    jsonResponse(
      {
        outcome: "minimum_stay",
        // What the route actually sends (#2363): the same generic sentence the
        // staging route answers with, never the rule's name or night count.
        message:
          "This group's stay is shorter than the minimum stay required for " +
          "those nights, so it cannot accept sign-ups. Please contact the organiser.",
      },
      409,
    );
  global.fetch = vi.fn(async () => verifyResponse()) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function confirm() {
  fireEvent.click(
    screen.getByRole("button", { name: /Confirm and continue to payment/i }),
  );
}

describe("GroupJoinVerifyPageClient — minimum stay (#2363)", () => {
  it("explains the refusal in plain English and reassures nothing was charged", async () => {
    render(<GroupJoinVerifyPageClient club={club} token={"a".repeat(64)} />);
    await confirm();

    expect(
      await screen.findByText(/shorter than the minimum stay required/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/contact the organiser/i)).toBeInTheDocument();
    expect(screen.getByText(/haven't been charged/i)).toBeInTheDocument();
  });

  it("never renders a detailed policy sentence, even if one somehow arrives", async () => {
    // Defence in depth for the privacy decision: the route sends only the
    // generic sentence, and this branch writes its own copy rather than echoing
    // whatever the server said — so a rule name and night count cannot reach
    // this unauthenticated page by either route.
    verifyResponse = () =>
      jsonResponse(
        {
          outcome: "minimum_stay",
          message:
            "Bookings including a Saturday night require a minimum stay of 3 nights (Lodge B weekends). Your booking is 2 nights.",
        },
        409,
      );

    render(<GroupJoinVerifyPageClient club={club} token={"a".repeat(64)} />);
    await confirm();

    await screen.findByText(/shorter than the minimum stay required/i);
    expect(screen.queryByText(/Lodge B weekends/)).not.toBeInTheDocument();
    expect(screen.queryByText(/minimum stay of 3 nights/)).not.toBeInTheDocument();
  });

  it("does not fall back to the generic not-joinable message", async () => {
    render(<GroupJoinVerifyPageClient club={club} token={"a".repeat(64)} />);
    await confirm();

    await screen.findByText(/shorter than the minimum stay required/i);
    expect(
      screen.queryByText(/no longer accepting joins/i),
    ).not.toBeInTheDocument();
  });

  it("still shows the not-joinable message for a plain 409", async () => {
    verifyResponse = () =>
      jsonResponse(
        { outcome: "not_joinable", message: "This group's stay has ended" },
        409,
      );

    render(<GroupJoinVerifyPageClient club={club} token={"a".repeat(64)} />);
    await confirm();

    expect(
      await screen.findByText("This group's stay has ended"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/shorter than the minimum stay required/i),
    ).not.toBeInTheDocument();
  });
});
