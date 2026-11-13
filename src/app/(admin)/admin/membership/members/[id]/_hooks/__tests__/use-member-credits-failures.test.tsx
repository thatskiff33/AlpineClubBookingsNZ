// @vitest-environment jsdom

/**
 * A refused credit adjustment or review says why (#4976, ALP-589).
 *
 * The review parsed a refusal as JSON with no catch, and both handlers showed
 * `err.message`: an HTML 502 from the proxy read as a JSON parse error and a
 * dropped connection as "Failed to fetch". Both now throw an
 * `ApiRefusalError` and fall back to their own sentence otherwise.
 */

import { cleanup, fireEvent, render, screen } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { itShowsEveryRefusal } from "@/lib/__tests__/support/failed-write-cases";

vi.mock("sonner", async () => (await import("@/lib/__tests__/support/toast-to-document")).sonnerToDocument);

import { useMemberCredits } from "../use-member-credits";

/** The member page's credit card, reduced to what these cases press. */
function Harness() {
  const credits = useMemberCredits("member-1");
  return (
    <>
      {credits.adjustmentError && <p role="alert">{credits.adjustmentError}</p>}
      <input
        aria-label="Amount"
        value={credits.adjustmentAmount}
        onChange={(event) => credits.setAdjustmentAmount(event.target.value)}
      />
      <input
        aria-label="Description"
        value={credits.adjustmentDescription}
        onChange={(event) => credits.setAdjustmentDescription(event.target.value)}
      />
      <button type="button" onClick={() => void credits.handleAdjustmentSubmit(null)}>
        Submit adjustment
      </button>
      <button
        type="button"
        onClick={() => void credits.handleReviewAdjustmentRequest("request-1", "APPROVE")}
      >
        Approve request
      </button>
    </>
  );
}

type Answer = () => Response | Promise<Response>;

function installFetch({ submit, review }: { submit?: Answer; review?: Answer }) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PATCH") {
      return (review ?? (() => Response.json({ message: "Adjustment approved" })))();
    }
    if (init?.method === "POST") {
      return (submit ?? (() => Response.json({ message: "Submitted for approval" })))();
    }
    if (url === "/api/admin/members/member-1/credits") {
      return Response.json({ balanceCents: 0, history: [], pendingRequests: [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function creditLoads(fetchMock: ReturnType<typeof installFetch>) {
  return fetchMock.mock.calls.filter(([, init]) => !init?.method).length;
}

function submitADebit() {
  render(<Harness />);
  // A debit needs no grant account, so the harness can pass none.
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "-25.00" } });
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Correction" } });
  fireEvent.click(screen.getByRole("button", { name: "Submit adjustment" }));
}

function approveTheRequest() {
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Approve request" }));
}

describe("member credit adjustments", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  describe("submitting an adjustment", () => {
    itShowsEveryRefusal({
      fallback: "Failed to save adjustment",
      submit: async (answer) => {
        installFetch({ submit: answer });
        submitADebit();
      },
    });

    it("reloads the credits after a submitted adjustment", async () => {
      const fetchMock = installFetch({});
      submitADebit();

      expect(await screen.findByText("Submitted for approval")).toBeInTheDocument();
      await vi.waitFor(() => expect(creditLoads(fetchMock)).toBe(2));
    });
  });

  describe("reviewing an adjustment request", () => {
    itShowsEveryRefusal({
      fallback: "Failed to review adjustment",
      submit: async (answer) => {
        installFetch({ review: answer });
        approveTheRequest();
      },
    });

    it("reloads the credits after a review", async () => {
      const fetchMock = installFetch({});
      approveTheRequest();

      expect(await screen.findByText("Adjustment approved")).toBeInTheDocument();
      await vi.waitFor(() => expect(creditLoads(fetchMock)).toBe(2));
    });
  });
});
