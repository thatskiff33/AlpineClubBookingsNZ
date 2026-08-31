// #3209 — a cancellation nobody asked for can never be refused by the hosting rule.
//
// This is the acceptance criterion "neither path can be blocked or made to throw by
// the reconciliation", proved where it actually lives. The two callers mock this
// seam, so a test of them can only show that they call it; the question of what
// happens when the reconciler REFUSES is settled here.
//
// Why it matters concretely rather than in principle. Cancelling a booking removes
// its adults from the host pool of its #738 split siblings, and the sibling loop
// inside `reconcileAdultMemberHostingReviewWithSiblings` reconciles each of those
// under the default `REFUSE`. At an ENFORCED lodge that raises
// `AdultMemberHostingRequiredError` from inside the caller's transaction. On the
// Internet Banking cron the rollback leaves the hold unreleased, the next run reads
// the same rows and throws again, and the beds are held for a stay nobody is paying
// for — permanently. On a group cancel the child stays CONFIRMED after the group is
// already fenced CANCELLED, which no re-drive recovers. `INV-HOST-028`: nothing
// automated can ever be gated by this machinery.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdultMemberHostingRequiredError } from "@/lib/adult-member-hosting-refusal";
import { HostingCoverageParticipantRetryError } from "@/lib/adult-member-hosting-queue-participants";
import {
  evaluateAdultMemberHostingWithPolicy,
  resolveAdultMemberHostingPolicy,
} from "@/lib/policies/adult-member-hosting";

const mocks = vi.hoisted(() => ({
  reconcileWithSiblings: vi.fn(),
  enqueueOwn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/adult-member-hosting-review", () => ({
  reconcileAdultMemberHostingReviewWithSiblings: mocks.reconcileWithSiblings,
  enqueueOwnHostingCoverageReevaluation: mocks.enqueueOwn,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: mocks.loggerError,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { reconcileHostingReviewForSystemCancellation } from "@/lib/adult-member-hosting-system-cancellation";

const tx = { marker: "the caller's transaction client" } as never;

/**
 * The real refusal an ENFORCED lodge raises, built through the real evaluator.
 *
 * A hand-written stand-in would not exercise `AdultMemberHostingRequiredError`'s
 * own construction, and the thing under test is an `instanceof` check — so the
 * error has to be the genuine article or the test proves nothing about the branch.
 * The date is relative to the frozen clock (`2026-07-01`), so it is permanently a
 * future lodge-night.
 */
function refusal() {
  const enforced = resolveAdultMemberHostingPolicy(
    [
      {
        id: "club-policy",
        scopeKey: "club-wide",
        lodgeId: null,
        mode: "ENFORCED",
        capacityMode: "NO_HOLD",
        version: 4,
        hostScopeSameBooking: true,
        hostScopeSameBookingOwner: false,
      },
    ],
    "lodge-1",
  );
  const violation = evaluateAdultMemberHostingWithPolicy(
    [
      {
        guestRef: "guest-1",
        guestName: "Pat Non-Member",
        member: null,
        nights: ["2026-08-01"],
        operationallyPresent: true,
      },
    ],
    enforced,
  );
  if (violation === null) {
    throw new Error("fixture is meant to produce an uncovered non-member night");
  }
  return new AdultMemberHostingRequiredError(violation);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reconcileWithSiblings.mockResolvedValue({
    action: "none",
    violation: null,
    mode: null,
  });
  mocks.enqueueOwn.mockResolvedValue("queue-item-1");
});

describe("reconcileHostingReviewForSystemCancellation", () => {
  it("reconciles through the shared seam with the caller's transaction client", async () => {
    await reconcileHostingReviewForSystemCancellation("booking-1", tx);

    // NO third argument, and that absence is the design. With no
    // `hostingCoverageActorOptions` the dependent disposition falls to its default
    // `ESCALATE` and `resolveDependentDisposition` has no actor member id it could
    // promote to `BLOCK`. Passing the actor helper here would either refuse the
    // cancellation or ask an officer for a confirmation nobody is present to give.
    expect(mocks.reconcileWithSiblings).toHaveBeenCalledWith("booking-1", tx);
    expect(mocks.reconcileWithSiblings.mock.calls[0]).toHaveLength(2);
  });

  it("does not enqueue a second time when the reconcile succeeded", async () => {
    // The reconcile's own settle step already recorded whatever was owed. A
    // belt-and-braces enqueue on the happy path would be a duplicate item on every
    // cancellation at every enforcing club.
    await reconcileHostingReviewForSystemCancellation("booking-1", tx);

    expect(mocks.enqueueOwn).not.toHaveBeenCalled();
    expect(mocks.loggerError).not.toHaveBeenCalled();
  });

  it("allows the cancellation when the hosting rule refuses, and escalates instead", async () => {
    mocks.reconcileWithSiblings.mockRejectedValue(refusal());

    await expect(
      reconcileHostingReviewForSystemCancellation("booking-1", tx),
    ).resolves.toBeUndefined();

    // The escalation the refusal interrupted is still recorded, in the SAME
    // transaction, so the obligation commits with the cancellation and the
    // caller's post-commit drain (or the cron behind it) opens the incident,
    // emails the owner and raises the officer task. Swallowing the refusal on its
    // own would have lost that: it is raised before the settle step ever runs.
    expect(mocks.enqueueOwn).toHaveBeenCalledWith("booking-1", tx, {
      cause: "SYSTEM_CHANGE",
    });
    // And it is not silent.
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
  });

  it("re-throws a participant retry rather than swallowing it", async () => {
    // A deliberate "somebody else holds the participant rows, come back" signal.
    // Swallowing it would enqueue against rows this transaction never locked, and
    // would rob the callers of the re-drive that makes the contention harmless.
    const retry = new HostingCoverageParticipantRetryError();
    mocks.reconcileWithSiblings.mockRejectedValue(retry);

    await expect(
      reconcileHostingReviewForSystemCancellation("booking-1", tx),
    ).rejects.toBe(retry);
    expect(mocks.enqueueOwn).not.toHaveBeenCalled();
  });

  it("re-throws a database failure rather than swallowing it", async () => {
    // A failed statement puts PostgreSQL's transaction into its aborted state, so
    // the enqueue could not commit anyway and continuing would report work that
    // never happened. The catch is narrowed to the one application-level refusal
    // precisely so this case still reaches the caller.
    const boom = new Error("could not serialize access due to concurrent update");
    mocks.reconcileWithSiblings.mockRejectedValue(boom);

    await expect(
      reconcileHostingReviewForSystemCancellation("booking-1", tx),
    ).rejects.toBe(boom);
    expect(mocks.enqueueOwn).not.toHaveBeenCalled();
  });
});
