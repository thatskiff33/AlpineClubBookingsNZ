// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PolicyExceptionRequestsPanel } from "@/components/admin/booking-requests/policy-exception-requests-panel";
import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus";

/**
 * #2562 — the officer-note split on the #2526 queue.
 *
 * The owner's decision is specific about the labelling, not just the plumbing: any
 * note shown to the member must be labelled member-visible IN THE OFFICER UI, and
 * the UI must say so BEFORE the officer submits. The private field exists so an
 * officer who needs to record a judgement has somewhere to put it that is not the
 * member's screen, so both halves are pinned: the labels, and that the two travel
 * to their own fields on the wire.
 */

vi.mock("sonner", () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function queueItem(overrides: Record<string, unknown> = {}) {
  return {
    source: "MODIFICATION",
    id: "req-1",
    status: "REQUESTED",
    createdAt: "2026-07-01T10:00:00.000Z",
    version: 3,
    bookingId: "bk-1",
    lodgeId: "lodge-1",
    requestedBy: {
      id: "m-1",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
    },
    reviewedBy: null,
    reviewedAt: null,
    memberMessage: "Please allow the one-night stay.",
    proposalHash: "abc",
    aggregateCapacityMode: "HOLD",
    reasonCodes: ["MINIMUM_STAY"],
    policyRefs: [
      {
        reasonCode: "MINIMUM_STAY",
        policyId: "pol-1",
        policyVersion: 1,
        capacityMode: "HOLD",
      },
    ],
    affectedNights: ["2026-07-01"],
    proposedCheckIn: "2026-07-01",
    proposedCheckOut: "2026-07-02",
    proposedGuestCount: 1,
    adminNotes: null,
    internalNotes: null,
    createdBookingId: null,
    attemptCount: 1,
    conflictCount: 0,
    lastConflictAt: null,
    lastConflictReason: null,
    supersededByRequestId: null,
    summary: "check-out to 2026-07-02",
    ...overrides,
  };
}

let queueResponse: () => Response;
let decisionResponse: () => Response;
let fetchMock: ReturnType<typeof vi.fn>;
let scrollIntoView: ReturnType<typeof vi.fn>;
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

function installFetch() {
  queueResponse = () => jsonResponse({ data: [queueItem()], page: 1, pageSize: 100, total: 1 });
  decisionResponse = () => jsonResponse({ id: "req-1", status: "REJECTED" });
  fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/admin/booking-exception-requests?")) return queueResponse();
    if (init?.method === "PATCH") return decisionResponse();
    return jsonResponse({ proposedGuests: [] });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
}

beforeEach(() => {
  installFetch();
  scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
});

afterEach(() => {
  if (originalScrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: originalScrollIntoView,
    });
  } else {
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  }
});

async function openDecisionForm() {
  render(<PolicyExceptionRequestsPanel />);
  const decide = await screen.findByRole("button", { name: /Decide this request/i });
  fireEvent.click(decide);
}

describe("the officer decision form labels who reads what, before submission", () => {
  it("keeps a permanent alert and focuses and scrolls load failures", async () => {
    const loadGate = deferred<Response>();
    fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input).includes("/api/admin/booking-exception-requests?")) {
        return loadGate.promise;
      }
      return jsonResponse({ proposedGuests: [] });
    });
    render(<PolicyExceptionRequestsPanel />);

    const alert = document.getElementById("policy-exception-error");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toBeEmptyDOMElement();
    expect(alert).toHaveClass("sr-only");
    loadGate.resolve(jsonResponse({ error: "Queue service unavailable" }, 503));
    expect(await screen.findByText("Queue service unavailable")).toBeInTheDocument();
    expect(document.getElementById("policy-exception-error")).toBe(alert);
    expect(alert).not.toHaveClass("sr-only");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(
      screen.queryByText(/No requested booking-policy exception requests/i),
    ).not.toBeInTheDocument();
    await expectRecoveryAlertToHoldFocus(alert);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
  });

  it("retries the current filter from the load-failure alert", async () => {
    let queueLoads = 0;
    fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input).includes("/api/admin/booking-exception-requests?")) {
        queueLoads += 1;
        return queueLoads === 1
          ? jsonResponse({ error: "Queue service unavailable" }, 503)
          : jsonResponse({ data: [queueItem()], page: 1, pageSize: 100, total: 1 });
      }
      return jsonResponse({ proposedGuests: [] });
    });

    render(<PolicyExceptionRequestsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
    expect(queueLoads).toBe(2);
    expect(
      fetchMock.mock.calls
        .filter(([input]) =>
          String(input).includes("/api/admin/booking-exception-requests?"),
        )
        .every(([input]) => String(input).includes("status=REQUESTED")),
    ).toBe(true);
    const alert = document.getElementById("policy-exception-error");
    expect(alert).toBeEmptyDOMElement();
    expect(alert).toHaveClass("sr-only");
  });

  it("does not show the previous filter's rows or a false empty state when a filter load fails", async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("status=APPROVED")) {
        return jsonResponse({ error: "Approved queue unavailable" }, 503);
      }
      if (url.includes("/api/admin/booking-exception-requests?")) {
        return jsonResponse({ data: [queueItem()], page: 1, pageSize: 100, total: 1 });
      }
      return jsonResponse({ proposedGuests: [] });
    });

    render(<PolicyExceptionRequestsPanel />);
    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approved" }));

    expect(await screen.findByText("Approved queue unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Ada Lovelace")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/No approved booking-policy exception requests/i),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("visually collapses the empty permanent alert after a successful load", async () => {
    render(<PolicyExceptionRequestsPanel />);
    await screen.findByRole("button", { name: /Decide this request/i });

    const alert = document.getElementById("policy-exception-error");
    expect(alert).toBeEmptyDOMElement();
    expect(alert).toHaveClass("sr-only");
  });

  it("focuses a decision failure without discarding the open decision draft", async () => {
    decisionResponse = () => jsonResponse({ error: "Decision service unavailable" }, 503);
    await openDecisionForm();
    const memberNote = screen.getByLabelText(/Explanation for the member/i);
    const privateNote = screen.getByLabelText(/Internal note/i);
    fireEvent.change(memberNote, {
      target: { value: "Member-visible draft must remain." },
    });
    fireEvent.change(privateNote, {
      target: { value: "Officer-only draft must remain." },
    });
    fireEvent.click(screen.getByLabelText(/I have read the proposal above/i));
    fireEvent.click(screen.getByRole("button", { name: /Approve and apply/i }));

    expect(
      await screen.findByText("Decision service unavailable"),
    ).toBeInTheDocument();
    const alert = document.getElementById("policy-exception-error");
    await expectRecoveryAlertToHoldFocus(alert);
    expect(memberNote).toHaveValue("Member-visible draft must remain.");
    expect(privateNote).toHaveValue("Officer-only draft must remain.");
    expect(screen.getByLabelText(/I have read the proposal above/i)).toBeChecked();
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
  });

  it("draws two fields, and names the audience of each", async () => {
    await openDecisionForm();
    expect(screen.getByLabelText(/Explanation for the member/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Internal note/i)).toBeInTheDocument();
    // Said before the decision is submitted, not afterwards.
    expect(
      screen.getByText(/The member will see this/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Only admins see this. It is never shown to the member/i),
    ).toBeInTheDocument();
  });

  it("tells the officer the member-facing note is required to refuse", async () => {
    await openDecisionForm();
    expect(
      screen.getByText(/required to refuse; optional on approve/i),
    ).toBeInTheDocument();
  });

  it("keeps Refuse unavailable until the MEMBER-facing note is written", async () => {
    await openDecisionForm();
    const refuse = screen.getByRole("button", { name: "Refuse" });
    expect(refuse).toBeDisabled();
    // An internal note alone does not unlock it — the member must be told something.
    fireEvent.change(screen.getByLabelText(/Internal note/i), {
      target: { value: "Not worth the argument." },
    });
    expect(refuse).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Explanation for the member/i), {
      target: { value: "That weekend is always full." },
    });
    expect(refuse).not.toBeDisabled();
  });

  it("sends the two notes as separate fields", async () => {
    await openDecisionForm();
    fireEvent.change(screen.getByLabelText(/Explanation for the member/i), {
      target: { value: "That weekend is always full." },
    });
    fireEvent.change(screen.getByLabelText(/Internal note/i), {
      target: { value: "Third time this season." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Refuse" }));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
      );
      expect(patch).toBeDefined();
      expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toMatchObject({
        action: "reject",
        adminNotes: "That weekend is always full.",
        internalNotes: "Third time this season.",
      });
    });
  });

  /**
   * #2562 RE-REVIEW — the sibling surface's bug, checked for here.
   *
   * `booking-change-requests-panel` draws every REQUESTED card's decision form at
   * once and kept ONE draft, so a keystroke on one card claimed another card's
   * half-written member-facing explanation and could post it to the wrong member.
   * This queue is an accordion — one `openId`, one form, and opening a card resets
   * the draft — so the same class of leak has nowhere to happen. That is a
   * structural property worth a test rather than a comment: if a later change ever
   * mounts two forms, or keeps a draft across cards, this fails.
   */
  it("draws only the open card's decision form, so no other card can carry its draft", async () => {
    queueResponse = () =>
      jsonResponse({
        data: [
          queueItem(),
          queueItem({
            id: "req-2",
            bookingId: "bk-2",
            requestedBy: {
              id: "m-2",
              firstName: "Bea",
              lastName: "Tui",
              email: "bea@example.com",
            },
          }),
        ],
        page: 1,
        pageSize: 100,
        total: 2,
      });
    render(<PolicyExceptionRequestsPanel />);

    // Both cards offer to be decided; neither has a form until one is opened.
    const openButtons = await screen.findAllByRole("button", {
      name: /Decide this request/i,
    });
    expect(openButtons).toHaveLength(2);
    expect(screen.queryByLabelText(/Explanation for the member/i)).toBeNull();

    fireEvent.click(openButtons[0]);
    // Exactly ONE note field pair exists — the open card's.
    expect(screen.getAllByLabelText(/Explanation for the member/i)).toHaveLength(1);
    expect(screen.getAllByLabelText(/Internal note/i)).toHaveLength(1);
    fireEvent.change(screen.getByLabelText(/Explanation for the member/i), {
      target: { value: "Ada's road was closed, allowing it." },
    });
    fireEvent.change(screen.getByLabelText(/Internal note/i), {
      target: { value: "Ada rings every month." },
    });
    // The other card still has no decision affordance at all, so there is nothing
    // for the draft to unlock.
    expect(
      screen.getAllByRole("button", { name: /Decide this request/i }),
    ).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Refuse" })).toHaveLength(1);

    // Opening the OTHER card takes the draft with it, rather than carrying Ada's
    // sentence over to Bea.
    fireEvent.click(screen.getByRole("button", { name: /Decide this request/i }));
    expect(screen.getByLabelText(/Explanation for the member/i)).toHaveValue("");
    expect(screen.getByLabelText(/Internal note/i)).toHaveValue("");
    expect(screen.getByRole("button", { name: "Refuse" })).toBeDisabled();

    // And a decision from here goes to Bea's id with Bea's own note.
    fireEvent.change(screen.getByLabelText(/Explanation for the member/i), {
      target: { value: "Bea's weekend is already committed." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Refuse" }));
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
      );
      expect(String(patch?.[0])).toContain("/req-2");
      expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toMatchObject({
        adminNotes: "Bea's weekend is already committed.",
      });
      expect(
        JSON.parse(String((patch?.[1] as RequestInit).body)).internalNotes,
      ).toBeUndefined();
    });
  });

  it("claims one request synchronously while its PATCH is pending", async () => {
    queueResponse = () =>
      jsonResponse({
        data: [
          queueItem(),
          queueItem({
            id: "req-2",
            bookingId: "bk-2",
            requestedBy: {
              id: "m-2",
              firstName: "Bea",
              lastName: "Tui",
              email: "bea@example.com",
            },
          }),
        ],
        page: 1,
        pageSize: 100,
        total: 2,
      });
    const patchGate = deferred<Response>();
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PATCH") return patchGate.promise;
      if (url.includes("/api/admin/booking-exception-requests?")) {
        return queueResponse();
      }
      return jsonResponse({ proposedGuests: [] });
    });

    render(<PolicyExceptionRequestsPanel />);
    const openButtons = await screen.findAllByRole("button", {
      name: /Decide this request/i,
    });
    fireEvent.click(openButtons[0]);
    const memberField = screen.getByLabelText(/Explanation for the member/i);
    fireEvent.change(memberField, {
      target: { value: "That weekend is already full." },
    });
    const refuse = screen.getByRole("button", { name: "Refuse" });

    // Both clicks are dispatched before React can commit the disabled state. The
    // synchronous ref claim, not the button, is what limits this to one PATCH.
    act(() => {
      refuse.click();
      refuse.click();
    });

    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          (init as RequestInit | undefined)?.method === "PATCH" &&
          String(url).includes("/req-1"),
      ),
    ).toHaveLength(1);
    expect(refuse).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Decide this request/i }),
    ).not.toBeDisabled();

    patchGate.resolve(jsonResponse({ error: "Please try again." }, 500));
    await waitFor(() => expect(refuse).not.toBeDisabled());
    expect(memberField).toHaveValue("That weekend is already full.");
  });

  it("omits an internal note that was left blank rather than sending an empty string", async () => {
    await openDecisionForm();
    fireEvent.change(screen.getByLabelText(/Explanation for the member/i), {
      target: { value: "No room." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Refuse" }));
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
      );
      const body = JSON.parse(String((patch?.[1] as RequestInit).body));
      expect(body.internalNotes).toBeUndefined();
    });
  });

  it("requires a separate private confirmation after the service identifies stranded same-owner bookings", async () => {
    let attempt = 0;
    decisionResponse = () => {
      attempt += 1;
      return attempt === 1
        ? jsonResponse(
            {
              error: "This change would leave another booking uncovered.",
              code: "SAME_OWNER_COVERAGE_OVERRIDE_REQUIRED",
              status: "REQUESTED",
              keptPending: true,
              requiresOverrideReason: true,
              strandedStateKey: `v1:${"a".repeat(64)}`,
              strandedBookings: [
                {
                  bookingId: "bk-dependent-secret",
                  reference: "ACB-1234",
                  lodgeName: "Example Lodge",
                  nights: ["2026-07-01", "2026-07-02"],
                },
              ],
            },
            409,
          )
        : jsonResponse({ id: "req-1", status: "APPROVED" });
    };

    await openDecisionForm();
    fireEvent.change(screen.getByLabelText(/Explanation for the member/i), {
      target: { value: "Member-facing exception explanation." },
    });
    fireEvent.change(screen.getByLabelText(/Internal note/i), {
      target: { value: "Separate officer context." },
    });
    fireEvent.click(
      screen.getByLabelText(/I have read the proposal above/i),
    );
    fireEvent.click(screen.getByRole("button", { name: /Approve and apply/i }));

    expect(
      await screen.findByText(/Separate hosting coverage override required/i),
    ).toBeInTheDocument();
    expect(screen.getByText("ACB-1234")).toBeInTheDocument();
    expect(screen.getByText(/Example Lodge/)).toBeInTheDocument();
    expect(screen.getByText(/2026-07-01, 2026-07-02/)).toBeInTheDocument();
    expect(screen.queryByText("bk-dependent-secret")).toBeNull();

    const approve = screen.getByRole("button", { name: /Approve and apply/i });
    expect(approve).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Private hosting override reason/i), {
      target: { value: "Confirmed alternate supervision plan." },
    });
    expect(approve).toBeDisabled();
    fireEvent.click(
      screen.getByLabelText(/I confirm these exact affected bookings and nights/i),
    );
    expect(approve).not.toBeDisabled();
    fireEvent.click(approve);
    fireEvent.click(approve);

    await waitFor(() => {
      const patches = fetchMock.mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
      );
      expect(patches).toHaveLength(2);
      const firstBody = JSON.parse(String((patches[0][1] as RequestInit).body));
      const secondBody = JSON.parse(String((patches[1][1] as RequestInit).body));
      expect(firstBody.hostingCoverageOverride).toBeUndefined();
      expect(secondBody).toMatchObject({
        adminNotes: "Member-facing exception explanation.",
        internalNotes: "Separate officer context.",
        hostingCoverageOverride: {
          acknowledged: true,
          reason: "Confirmed alternate supervision plan.",
          strandedStateKey: `v1:${"a".repeat(64)}`,
        },
      });
    });
  });

  it("replaces a changed coverage prompt and token without losing either note", async () => {
    let attempt = 0;
    decisionResponse = () => {
      attempt += 1;
      if (attempt === 3) return jsonResponse({ id: "req-1", status: "APPROVED" });
      const changed = attempt === 2;
      return jsonResponse(
        {
          error: changed
            ? "The affected hosting coverage changed. Review it again."
            : "This change would leave another booking uncovered.",
          code: "SAME_OWNER_COVERAGE_OVERRIDE_REQUIRED",
          status: "REQUESTED",
          keptPending: true,
          requiresOverrideReason: true,
          strandedStateKey: `v1:${(changed ? "b" : "a").repeat(64)}`,
          strandedBookings: [
            {
              bookingId: changed ? "bk-new" : "bk-original",
              reference: changed ? "ACB-NEW" : "ACB-OLD",
              lodgeName: "Example Lodge",
              nights: [changed ? "2026-07-03" : "2026-07-01"],
            },
          ],
        },
        409,
      );
    };

    await openDecisionForm();
    const memberNote = screen.getByLabelText(/Explanation for the member/i);
    const privateNote = screen.getByLabelText(/Internal note/i);
    fireEvent.change(memberNote, { target: { value: "Member-visible reason." } });
    fireEvent.change(privateNote, { target: { value: "Officer-only context." } });
    fireEvent.click(screen.getByLabelText(/I have read the proposal above/i));
    fireEvent.click(screen.getByRole("button", { name: /Approve and apply/i }));
    expect(await screen.findByText("ACB-OLD")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Private hosting override reason/i), {
      target: { value: "First exact-set confirmation reason." },
    });
    fireEvent.click(
      screen.getByLabelText(/I confirm these exact affected bookings and nights/i),
    );
    fireEvent.click(screen.getByRole("button", { name: /Approve and apply/i }));

    expect(await screen.findByText("ACB-NEW")).toBeInTheDocument();
    expect(screen.queryByText("ACB-OLD")).toBeNull();
    expect(memberNote).toHaveValue("Member-visible reason.");
    expect(privateNote).toHaveValue("Officer-only context.");
    expect(screen.getByLabelText(/Private hosting override reason/i)).toHaveValue("");
    expect(
      screen.getByLabelText(/I confirm these exact affected bookings and nights/i),
    ).not.toBeChecked();

    fireEvent.change(screen.getByLabelText(/Private hosting override reason/i), {
      target: { value: "Second exact-set confirmation reason." },
    });
    fireEvent.click(
      screen.getByLabelText(/I confirm these exact affected bookings and nights/i),
    );
    fireEvent.click(screen.getByRole("button", { name: /Approve and apply/i }));

    await waitFor(() => {
      const patches = fetchMock.mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
      );
      expect(patches).toHaveLength(3);
      const second = JSON.parse(String((patches[1][1] as RequestInit).body));
      const third = JSON.parse(String((patches[2][1] as RequestInit).body));
      expect(second.hostingCoverageOverride.strandedStateKey).toBe(
        `v1:${"a".repeat(64)}`,
      );
      expect(third).toMatchObject({
        adminNotes: "Member-visible reason.",
        internalNotes: "Officer-only context.",
        hostingCoverageOverride: {
          reason: "Second exact-set confirmation reason.",
          strandedStateKey: `v1:${"b".repeat(64)}`,
        },
      });
    });
  });

  it("clears the same-owner override prompt and private draft when the form is cancelled", async () => {
    decisionResponse = () =>
      jsonResponse(
        {
          error: "This change would leave another booking uncovered.",
          code: "SAME_OWNER_COVERAGE_OVERRIDE_REQUIRED",
          status: "REQUESTED",
          keptPending: true,
          requiresOverrideReason: true,
          strandedStateKey: `v1:${"c".repeat(64)}`,
          strandedBookings: [
            {
              bookingId: "bk-dependent",
              reference: "ACB-5678",
              lodgeName: "Example Lodge",
              nights: ["2026-07-01"],
            },
          ],
        },
        409,
      );

    await openDecisionForm();
    fireEvent.click(screen.getByLabelText(/I have read the proposal above/i));
    fireEvent.click(screen.getByRole("button", { name: /Approve and apply/i }));
    expect(await screen.findByText("ACB-5678")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Private hosting override reason/i), {
      target: { value: "This private draft must be cleared." },
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("ACB-5678")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: /Decide this request/i }),
    );
    expect(screen.queryByLabelText(/Private hosting override reason/i)).toBeNull();
    expect(screen.getByLabelText(/Explanation for the member/i)).toHaveValue("");
  });
});

describe("a decided request shows which half the member has already read", () => {
  it("labels the two notes separately on the decided card", async () => {
    queueResponse = () =>
      jsonResponse({
        data: [
          queueItem({
            status: "REJECTED",
            reviewedAt: "2026-07-02T09:00:00.000Z",
            reviewedBy: { id: "officer-1", firstName: "Grace", lastName: "Hopper" },
            adminNotes: "That weekend is always full, sorry.",
            internalNotes: "Third time this season.",
          }),
        ],
        page: 1,
        pageSize: 100,
        total: 1,
      });
    render(<PolicyExceptionRequestsPanel />);
    expect(
      await screen.findByText(/Explanation the member can see/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Internal note — admins only, never shown to the member/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText("That weekend is always full, sorry."),
    ).toBeInTheDocument();
    expect(screen.getByText("Third time this season.")).toBeInTheDocument();
  });

  it("draws no internal-note block when the officer left none", async () => {
    queueResponse = () =>
      jsonResponse({
        data: [
          queueItem({
            status: "REJECTED",
            adminNotes: "No room that weekend.",
            internalNotes: null,
          }),
        ],
        page: 1,
        pageSize: 100,
        total: 1,
      });
    render(<PolicyExceptionRequestsPanel />);
    expect(await screen.findByText("No room that weekend.")).toBeInTheDocument();
    expect(screen.queryByText(/Internal note — admins only/i)).toBeNull();
  });
});
