// #3209 — a cancellation nobody asked for can never be refused by the hosting rule.
//
// This is the acceptance criterion "neither path can be blocked or made to throw by
// the reconciliation", proved where it lives. The callers mock this seam, so a test
// of them can only show that they call it; what the seam ASKS FOR is settled here,
// and what the real reconciler then DOES with that request is settled against the
// real engine in `adult-member-hosting-same-owner.test.ts` ("a system cancellation
// records the hazard instead of refusing it").
//
// Why it matters concretely rather than in principle. Cancelling a booking removes
// its adults from the host pool of its #738 split siblings, and the sibling loop
// inside `reconcileAdultMemberHostingReviewWithSiblings` reconciles each of those
// under whatever `enforcement` the caller passed. Under the default `REFUSE`, an
// ENFORCED lodge raises `AdultMemberHostingRequiredError` from inside the caller's
// transaction. On the Internet Banking cron the rollback leaves the hold
// unreleased, the next run reads the same rows and refuses again — deterministically,
// every fifteen minutes, forever — and the beds are held for a stay nobody is paying
// for. `HostingDependentCoverageDisposition` states the rule this breaks: "§8's list
// of changes that cannot reasonably be blocked includes every automated path".
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HostingCoverageParticipantRetryError } from "@/lib/adult-member-hosting-queue-participants";

const mocks = vi.hoisted(() => ({
  reconcileWithSiblings: vi.fn(),
}));

vi.mock("@/lib/adult-member-hosting-review", () => ({
  reconcileAdultMemberHostingReviewWithSiblings: mocks.reconcileWithSiblings,
}));

import { reconcileHostingReviewForSystemCancellation } from "@/lib/adult-member-hosting-system-cancellation";

const tx = { marker: "the caller's transaction client" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reconcileWithSiblings.mockResolvedValue({
    action: "none",
    violation: null,
    mode: null,
  });
});

describe("reconcileHostingReviewForSystemCancellation", () => {
  it("asks for REVIEW_ONLY, so the sibling loop records instead of refusing", async () => {
    // THE FIX, and the first attempt at #3209 got this wrong in a way no caller
    // test could see. It let the refusal be raised and CAUGHT it, falling back to
    // an enqueue for the booking being cancelled. But the refusal is raised by a
    // SIBLING, and at the DEFAULT host scope (`sameBookingOwner: false`) the drain
    // computes an empty dependent list for a terminal source — so the fallback
    // recorded nothing whatsoever. `REVIEW_ONLY` travels into the sibling loop by
    // design, which removes the refusal at its only throw site instead.
    await reconcileHostingReviewForSystemCancellation("booking-1", tx);

    expect(mocks.reconcileWithSiblings).toHaveBeenCalledWith("booking-1", tx, {
      enforcement: "REVIEW_ONLY",
    });
  });

  it("passes the caller's own transaction client and no actor options", async () => {
    // The transaction client is the whole contract: the obligation has to commit
    // with the cancellation rather than in a second connection that can be lost.
    // And NO `hostingCoverageActorOptions`, which is equally deliberate — with no
    // actor the dependent disposition falls to its default `ESCALATE` and
    // `resolveDependentDisposition` has no actor member id it could promote to
    // `BLOCK`. Passing the actor helper here would either refuse the cancellation
    // or ask an officer for a confirmation nobody is present to give.
    await reconcileHostingReviewForSystemCancellation("booking-1", tx);

    const call = mocks.reconcileWithSiblings.mock.calls[0];
    expect(call?.[1]).toBe(tx);
    expect(Object.keys(call?.[2] as object)).toEqual(["enforcement"]);
  });

  it("re-throws a participant retry rather than swallowing it", async () => {
    // A deliberate "somebody else holds the participant rows, come back" signal.
    // Swallowing it would rob the callers of the re-drive that makes the contention
    // harmless. There is no `try` in this module at all — that is what keeps this
    // true — and the census asserts the absence textually as well.
    const retry = new HostingCoverageParticipantRetryError();
    mocks.reconcileWithSiblings.mockRejectedValue(retry);

    await expect(
      reconcileHostingReviewForSystemCancellation("booking-1", tx),
    ).rejects.toBe(retry);
  });

  it("re-throws a database failure rather than swallowing it", async () => {
    // A failed statement puts PostgreSQL's transaction into its aborted state, so
    // nothing after it could commit and continuing would report work that never
    // happened. The callers' existing re-drive boundaries own it.
    const boom = new Error("could not serialize access due to concurrent update");
    mocks.reconcileWithSiblings.mockRejectedValue(boom);

    await expect(
      reconcileHostingReviewForSystemCancellation("booking-1", tx),
    ).rejects.toBe(boom);
  });
});
