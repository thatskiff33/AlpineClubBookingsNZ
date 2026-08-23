// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BookingChangeRequestsPanel } from "@/components/admin/booking-requests/booking-change-requests-panel";

/**
 * #2562 review — the note split on the LOCKED-PERIOD half of the same table.
 *
 * `BookingChangeRequest` holds both kinds of row, and the two kinds are decided from
 * different officer panels. #2562 rewrote the policy-exception panel and then wrote
 * the invariant down as TABLE-WIDE (`prisma/schema.prisma` on `adminNotes`,
 * `docs/DOMAIN_INVARIANTS.md`) — but this panel's field was still headed just "Admin
 * notes", with no audience wording anywhere in the file, while writing the same
 * member-visible column that `/bookings/<id>` renders to the member verbatim. So the
 * surface whose label most invited the mistake was the one the remedy never reached:
 * an officer typing "third ask this month, do not encourage" into a box called
 * "Admin notes" had no warning and nowhere else to put it.
 *
 * These cases pin the fix at the surface: both fields, both audiences named before
 * the decision is submitted, and the two travelling as separate wire fields.
 */

vi.mock("sonner", () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
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

function changeRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    bookingId: "bk-1",
    requestedByMemberId: "m-1",
    status: "REQUESTED",
    requestedChanges: { requested: { summary: "check-out to 2026-05-24" } },
    reason: "Weather closed the road.",
    adminNotes: null,
    internalNotes: null,
    reviewedAt: null,
    createdAt: "2026-05-23T10:00:00.000Z",
    requestedBy: {
      id: "m-1",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
    },
    reviewedBy: null,
    linkedModification: null,
    booking: {
      id: "bk-1",
      checkIn: "2026-05-23T00:00:00.000Z",
      checkOut: "2026-05-27T00:00:00.000Z",
      status: "COMPLETED",
      finalPriceCents: 12000,
      member: {
        id: "m-1",
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
      },
      payment: null,
    },
    ...overrides,
  };
}

/** A second card on the same table, owned by a DIFFERENT member. */
function secondChangeRequest() {
  return changeRequest({
    id: "req-2",
    bookingId: "bk-2",
    requestedByMemberId: "m-2",
    requestedBy: {
      id: "m-2",
      firstName: "Bea",
      lastName: "Tui",
      email: "bea@example.com",
    },
    booking: {
      ...changeRequest().booking,
      id: "bk-2",
      member: {
        id: "m-2",
        firstName: "Bea",
        lastName: "Tui",
        email: "bea@example.com",
      },
    },
  });
}

let listResponse: () => Response;
let fetchMock: ReturnType<typeof vi.fn>;

function installFetch() {
  listResponse = () =>
    jsonResponse({ data: [changeRequest()], page: 1, pageSize: 25, total: 1 });
  fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PATCH") {
      return jsonResponse({ id: "req-1", status: "REJECTED" });
    }
    if (url.includes("/api/admin/booking-change-requests")) return listResponse();
    return jsonResponse({});
  });
  global.fetch = fetchMock as unknown as typeof fetch;
}

beforeEach(() => {
  installFetch();
});

describe("the locked-period decision form names who reads what", () => {
  it("draws two fields, and names the audience of each before submission", async () => {
    render(<BookingChangeRequestsPanel />);
    expect(
      await screen.findByLabelText(/Explanation for the member/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Internal note/i)).toBeInTheDocument();
    // The label that caused the problem must be gone, not merely supplemented.
    expect(screen.queryByLabelText(/^Admin notes$/i)).toBeNull();
    expect(screen.getByText(/The member will see this/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Only admins see this. It is never shown to the member/i),
    ).toBeInTheDocument();
  });

  it("keeps both decisions unavailable until the MEMBER-facing note is written", async () => {
    render(<BookingChangeRequestsPanel />);
    const memberField = await screen.findByLabelText(/Explanation for the member/i);
    const reject = screen.getByRole("button", { name: "Reject" });
    const approve = screen.getByRole("button", {
      name: /Acknowledge as approved/i,
    });

    // AN UNTOUCHED FORM IS THE CASE THAT USED TO SLIP THROUGH. The old rule was
    // `reviewingId === request.id && !adminNotes.trim()`, so a row nobody had typed
    // into had both buttons live and could be decided with no member-facing
    // explanation at all — while the written invariant said the opposite.
    expect(reject).toBeDisabled();
    expect(approve).toBeDisabled();

    // An internal note alone must not unlock a decision: the member has to be told
    // something they can act on.
    fireEvent.change(screen.getByLabelText(/Internal note/i), {
      target: { value: "Third ask this month, do not encourage." },
    });
    expect(reject).toBeDisabled();
    expect(approve).toBeDisabled();

    // Whitespace is not an explanation.
    fireEvent.change(memberField, { target: { value: "   " } });
    expect(reject).toBeDisabled();
    expect(approve).toBeDisabled();

    fireEvent.change(memberField, {
      target: { value: "Those nights are already committed, sorry." },
    });
    expect(reject).not.toBeDisabled();
    expect(approve).not.toBeDisabled();
  });

  it("never carries one request's draft note onto another request", async () => {
    listResponse = () =>
      jsonResponse({
        data: [changeRequest(), secondChangeRequest()],
        page: 1,
        pageSize: 25,
        total: 2,
      });
    render(<BookingChangeRequestsPanel />);

    // The three inputs used to share one state slot, so a note typed on the first
    // card was POSTed onto whichever card the officer clicked next — and on this
    // table the member reads `adminNotes` verbatim, so Bea would have read a
    // sentence written about Ada's request.
    const memberFields = await screen.findAllByLabelText(
      /Explanation for the member/i,
    );
    fireEvent.change(memberFields[0], {
      target: { value: "Ada's road was closed, allowing it." },
    });
    fireEvent.change(screen.getAllByLabelText(/Internal note/i)[0], {
      target: { value: "Ada rings every month." },
    });

    // The second card owns no draft, so it cannot be decided at all.
    const secondReject = screen.getAllByRole("button", { name: "Reject" })[1];
    expect(secondReject).toBeDisabled();

    // And the first card still submits its own note, unchanged.
    fireEvent.click(screen.getAllByRole("button", { name: "Reject" })[0]);
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
      );
      expect(String(patch?.[0])).toContain("/req-1");
      expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toMatchObject({
        adminNotes: "Ada's road was closed, allowing it.",
        internalNotes: "Ada rings every month.",
      });
    });
    // Nothing was sent for the other member's request.
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          (init as RequestInit | undefined)?.method === "PATCH" &&
          String(url).includes("/req-2"),
      ),
    ).toHaveLength(0);
  });

  /**
   * #2562 RE-REVIEW — the case the first repair still failed.
   *
   * Routing every READ of the draft through the owner check was not enough: only
   * the member-facing textarea's onChange re-owned the draft, while the internal
   * note and the modification id ALSO claimed ownership and left the previous
   * row's sentence sitting in the shared slot. So typing an internal note on card
   * two handed card two Ada's member-facing explanation: it appeared in Bea's
   * field, it unlocked Bea's buttons, and a click posted Ada's sentence to
   * `/req-2` — which Bea then reads verbatim on her own booking page under "What
   * the club said". The draft is keyed per request now, so the order of the
   * keystrokes cannot matter.
   */
  it("keeps each row's draft to that row whichever field is typed first", async () => {
    listResponse = () =>
      jsonResponse({
        data: [changeRequest(), secondChangeRequest()],
        page: 1,
        pageSize: 25,
        total: 2,
      });
    render(<BookingChangeRequestsPanel />);

    const memberFields = await screen.findAllByLabelText(
      /Explanation for the member/i,
    );
    const internalFields = screen.getAllByLabelText(/Internal note/i);
    const modificationFields = screen.getAllByLabelText(
      /Linked booking modification id/i,
    );

    // Card ONE gets a member-facing explanation.
    fireEvent.change(memberFields[0], {
      target: { value: "Ada's road was closed, allowing it." },
    });
    // Card TWO is then typed into on the two fields that used to steal ownership:
    // the internal note first, then the modification id.
    fireEvent.change(internalFields[1], {
      target: { value: "Bea asks every season." },
    });
    fireEvent.change(modificationFields[1], { target: { value: "mod-123" } });

    // Bea's card must show NOTHING of Ada's sentence, and must stay undecidable.
    expect(memberFields[1]).toHaveValue("");
    expect(screen.getAllByRole("button", { name: "Reject" })[1]).toBeDisabled();
    expect(
      screen.getAllByRole("button", { name: /Acknowledge as approved/i })[1],
    ).toBeDisabled();

    // Ada's card kept its own draft while Bea's card was being typed into, and
    // Bea's internal note has not landed in Ada's field either.
    expect(memberFields[0]).toHaveValue("Ada's road was closed, allowing it.");
    expect(internalFields[0]).toHaveValue("");

    // Interleave back: Ada's internal note, then more of Bea's explanation. Both
    // rows keep exactly their own text.
    fireEvent.change(internalFields[0], {
      target: { value: "Ada rings every month." },
    });
    fireEvent.change(memberFields[1], {
      target: { value: "Bea's dates were already committed." },
    });
    expect(memberFields[0]).toHaveValue("Ada's road was closed, allowing it.");
    expect(internalFields[0]).toHaveValue("Ada rings every month.");
    expect(memberFields[1]).toHaveValue("Bea's dates were already committed.");
    expect(internalFields[1]).toHaveValue("Bea asks every season.");

    // And each row submits its own three fields, to its own id.
    fireEvent.click(screen.getAllByRole("button", { name: "Reject" })[1]);
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([url, init]) =>
          (init as RequestInit | undefined)?.method === "PATCH" &&
          String(url).includes("/req-2"),
      );
      expect(patch).toBeDefined();
      expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toMatchObject({
        status: "REJECTED",
        adminNotes: "Bea's dates were already committed.",
        internalNotes: "Bea asks every season.",
      });
    });
    // Nothing was sent for Ada's request, and her draft survives the other row's
    // successful decision.
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          (init as RequestInit | undefined)?.method === "PATCH" &&
          String(url).includes("/req-1"),
      ),
    ).toHaveLength(0);
    await waitFor(() => {
      expect(
        screen.getAllByLabelText(/Explanation for the member/i)[0],
      ).toHaveValue("Ada's road was closed, allowing it.");
    });
  });

  it("claims one row synchronously while its PATCH is pending", async () => {
    listResponse = () =>
      jsonResponse({
        data: [changeRequest(), secondChangeRequest()],
        page: 1,
        pageSize: 25,
        total: 2,
      });
    const patchGate = deferred<Response>();
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PATCH") return patchGate.promise;
      if (url.includes("/api/admin/booking-change-requests")) {
        return listResponse();
      }
      return jsonResponse({});
    });

    render(<BookingChangeRequestsPanel />);
    const memberFields = await screen.findAllByLabelText(
      /Explanation for the member/i,
    );
    fireEvent.change(memberFields[0], {
      target: { value: "Ada's request cannot be approved." },
    });
    fireEvent.change(memberFields[1], {
      target: { value: "Bea's request cannot be approved." },
    });
    const rejectButtons = screen.getAllByRole("button", { name: "Reject" });

    // One React batch: the DOM cannot receive the disabled prop between these two
    // native clicks. Removing the ref-backed claim makes this produce two PATCHes.
    act(() => {
      rejectButtons[0].click();
      rejectButtons[0].click();
    });

    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          (init as RequestInit | undefined)?.method === "PATCH" &&
          String(url).includes("/req-1"),
      ),
    ).toHaveLength(1);
    expect(rejectButtons[0]).toBeDisabled();
    expect(rejectButtons[1]).not.toBeDisabled();

    patchGate.resolve(jsonResponse({ error: "Please try again." }, 500));
    await waitFor(() => expect(rejectButtons[0]).not.toBeDisabled());
    expect(memberFields[0]).toHaveValue("Ada's request cannot be approved.");
  });

  it("sends the two notes as separate fields", async () => {
    render(<BookingChangeRequestsPanel />);
    fireEvent.change(await screen.findByLabelText(/Explanation for the member/i), {
      target: { value: "Those nights are already committed, sorry." },
    });
    fireEvent.change(screen.getByLabelText(/Internal note/i), {
      target: { value: "Third ask this month, do not encourage." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
      );
      expect(patch).toBeDefined();
      expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toMatchObject({
        status: "REJECTED",
        adminNotes: "Those nights are already committed, sorry.",
        internalNotes: "Third ask this month, do not encourage.",
      });
    });
  });

  it("omits a blank internal note rather than sending an empty string", async () => {
    render(<BookingChangeRequestsPanel />);
    fireEvent.change(await screen.findByLabelText(/Explanation for the member/i), {
      target: { value: "No room that weekend." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
      );
      const body = JSON.parse(String((patch?.[1] as RequestInit).body));
      expect(body.internalNotes).toBeUndefined();
    });
  });
});

describe("a decided locked-period request shows which half the member has read", () => {
  it("labels the two notes separately", async () => {
    listResponse = () =>
      jsonResponse({
        data: [
          changeRequest({
            status: "REJECTED",
            reviewedAt: "2026-05-24T09:00:00.000Z",
            reviewedBy: { id: "officer-1", firstName: "Grace", lastName: "Hopper" },
            adminNotes: "Those nights are already committed, sorry.",
            internalNotes: "Third ask this month, do not encourage.",
          }),
        ],
        page: 1,
        pageSize: 25,
        total: 1,
      });
    render(<BookingChangeRequestsPanel />);
    expect(
      await screen.findByText(/Explanation the member can see/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Internal note — admins only, never shown to the member/i),
    ).toBeInTheDocument();
  });

  it("draws no internal-note block when the officer left none", async () => {
    listResponse = () =>
      jsonResponse({
        data: [
          changeRequest({
            status: "REJECTED",
            adminNotes: "No room that weekend.",
            internalNotes: null,
          }),
        ],
        page: 1,
        pageSize: 25,
        total: 1,
      });
    render(<BookingChangeRequestsPanel />);
    expect(await screen.findByText("No room that weekend.")).toBeInTheDocument();
    expect(screen.queryByText(/Internal note — admins only/i)).toBeNull();
  });
});
