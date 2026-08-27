// @vitest-environment jsdom

/**
 * THE DIAGNOSTICS TAB (AID-7, #2378; owner decisions D8-D10).
 *
 * Two of these tests are the UI half of a server-side security decision, and they are
 * the reason this file exists rather than a screenshot:
 *
 *  - D9: both consent ticks appear on EVERY question and start unticked. AID-7a grants
 *    both permissions per REQUEST, so a tick that survived a send would be the UI
 *    claiming an authority the gate never gave it.
 *  - D10: the collapsed provenance line always carries the caveat.
 */

import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HelpWidget } from "@/components/help-widget/help-widget";
import {
  HelpWidgetProvider,
  usePublishDiagnosticsViewState,
  type DiagnosticsViewState,
} from "@/components/help-widget/help-widget-context";
import type { HelpPageContent } from "@/lib/help/types";
import type { DiagnosticsAskResponse } from "@/lib/diagnostics/answer/contract";

const mocks = vi.hoisted(() => ({ pathname: "/admin/bookings/abc" }));
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }));

const CONTENT: HelpPageContent = {
  title: "Bookings",
  summary: "",
  actions: [],
  sections: [],
  questions: [],
};

function answered(overrides: Partial<DiagnosticsAskResponse> = {}) {
  return {
    status: "answered",
    answer: "The deposit is unpaid.",
    truncated: false,
    provenance: {
      line: "Read from Booking blockers, just now.",
      hasCaveat: false,
      hasPermissionWithheld: false,
      hasConsentWithheld: false,
      hasSearchWithheld: false,
      hasPartialEvidence: false,
      hasStaleEvidence: false,
      withheldAreas: [],
      sources: [
        {
          toolId: "booking_block_state",
          label: "Booking blockers",
          state: "ok",
          stateDescription: "Evidence was retrieved.",
          observedAt: "2026-08-12T11:59:00.000Z",
          rowCount: 3,
          missingAreas: [],
        },
      ],
      roundsUsed: 1,
    },
    ...overrides,
  } as DiagnosticsAskResponse;
}

/**
 * `diagnostics` is spread from an object rather than passed as a defaulted parameter
 * on purpose: an explicit `undefined` argument would trigger a default and the
 * "no prop means no tab" case would silently test the opposite of what it claims.
 * That is exactly what the first version of this file did, and the test failed loudly
 * — which is the only reason it is written this way now.
 */
function renderWidget(
  props: { diagnostics?: { moduleEnabled: boolean } } = {
    diagnostics: { moduleEnabled: true },
  },
) {
  return render(
    <HelpWidgetProvider>
      <HelpWidget
        surface="admin"
        llmEnabled={false}
        resolveHelp={() => CONTENT}
        {...props}
      />
    </HelpWidgetProvider>,
  );
}

function openDiagnostics() {
  fireEvent.click(screen.getByTestId("help-widget-launcher"));
  fireEvent.click(screen.getByTestId("help-widget-tab-diagnostics"));
}

beforeEach(() => {
  mocks.pathname = "/admin/bookings/abc";
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => answered(),
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the tab exists only where the server granted it (#2378, Q6)", () => {
  it("is absent when the surface supplied no diagnostics prop", () => {
    renderWidget({});
    fireEvent.click(screen.getByTestId("help-widget-launcher"));
    expect(screen.queryByTestId("help-widget-tab-diagnostics")).toBeNull();
  });

  it("is present when it did", () => {
    renderWidget();
    fireEvent.click(screen.getByTestId("help-widget-launcher"));
    expect(screen.getByTestId("help-widget-tab-diagnostics")).toBeTruthy();
  });

  it("says the module is off rather than offering a box that can only refuse", () => {
    renderWidget({ diagnostics: { moduleEnabled: false } });
    openDiagnostics();
    expect(screen.getByText(/AI Diagnostics is switched off/)).toBeTruthy();
    expect(screen.queryByTestId("diagnostics-input")).toBeNull();
  });
});

describe("the consent ticks are per question (#2378, D9)", () => {
  it("both start unticked", () => {
    renderWidget();
    openDiagnostics();
    expect(
      (screen.getByTestId("diagnostics-consent-search") as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      (screen.getByTestId("diagnostics-consent-record") as HTMLInputElement).checked,
    ).toBe(false);
  });

  it("sends exactly what was ticked, and RESETS both afterwards", async () => {
    renderWidget();
    openDiagnostics();

    fireEvent.click(screen.getByTestId("diagnostics-consent-search"));
    fireEvent.change(screen.getByTestId("diagnostics-input"), {
      target: { value: "who is on this booking?" },
    });
    fireEvent.click(screen.getByTestId("diagnostics-send"));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const body = JSON.parse(
      (fetch as unknown as { mock: { calls: [string, { body: string }][] } }).mock
        .calls[0][1].body,
    );
    expect(body.allowPeopleSearch).toBe(true);
    expect(body.allowRecordPersonalDetails).toBe(false);
    expect(body.pathname).toBe("/admin/bookings/abc");

    // THE RULE. The server granted people-search for THAT request only, so the box
    // must be empty again before the next one.
    await waitFor(() =>
      expect(
        (screen.getByTestId("diagnostics-consent-search") as HTMLInputElement).checked,
      ).toBe(false),
    );
  });

  it("tells a THROTTLED operator to wait, never to check their connection", async () => {
    // The per-admin limiter (15 questions / 10 minutes) is the refusal an operator
    // working a batch of stuck bookings actually hits, and the first cut rendered
    // its 429 as the network-failure sentence — wrong guidance that invites the
    // retry storm the limiter exists to stop (correctness review, 13 Aug 2026).
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) }),
    );
    renderWidget();
    openDiagnostics();
    fireEvent.change(screen.getByTestId("diagnostics-input"), {
      target: { value: "why is this pending?" },
    });
    fireEvent.click(screen.getByTestId("diagnostics-send"));
    await waitFor(() =>
      expect(screen.getByText(/lot of questions in a short time/)).toBeTruthy(),
    );
    expect(screen.queryByText(/Check your connection/)).toBeNull();
  });

  it("says the SESSION changed on a 401/403, never that the network failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) }),
    );
    renderWidget();
    openDiagnostics();
    fireEvent.change(screen.getByTestId("diagnostics-input"), {
      target: { value: "why is this pending?" },
    });
    fireEvent.click(screen.getByTestId("diagnostics-send"));
    await waitFor(() =>
      expect(screen.getByText(/session no longer allows this/)).toBeTruthy(),
    );
    expect(screen.queryByText(/Check your connection/)).toBeNull();
  });

  it("resets the ticks even when the question was REFUSED", async () => {
    // The worst version of getting this wrong: the operator retries, and a permission
    // they granted for a question that never ran is silently reused for the next one.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          status: "blocked",
          reason: "budget_exhausted",
          message: "Diagnostics has reached this month's spending limit.",
        }),
      }),
    );
    renderWidget();
    openDiagnostics();

    fireEvent.click(screen.getByTestId("diagnostics-consent-search"));
    fireEvent.change(screen.getByTestId("diagnostics-input"), {
      target: { value: "who is on this booking?" },
    });
    fireEvent.click(screen.getByTestId("diagnostics-send"));

    await waitFor(() =>
      expect(
        (screen.getByTestId("diagnostics-consent-search") as HTMLInputElement).checked,
      ).toBe(false),
    );
    // And a spent budget disables the input for the rest of the session.
    expect(
      (screen.getByTestId("diagnostics-input") as HTMLTextAreaElement).disabled,
    ).toBe(true);
  });
});

describe("the answer carries its provenance (#2378, D10)", () => {
  it("shows the server's collapsed line, with the detail hidden until asked", async () => {
    renderWidget();
    openDiagnostics();
    fireEvent.change(screen.getByTestId("diagnostics-input"), {
      target: { value: "why is this stuck?" },
    });
    fireEvent.click(screen.getByTestId("diagnostics-send"));

    const toggle = await screen.findByTestId("diagnostics-provenance-toggle");
    // The LINE is the server's, verbatim — the client composes no wording of its own.
    expect(toggle.textContent).toContain("Read from Booking blockers, just now.");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Booking blockers")).toBeTruthy();
    expect(screen.getByText(/3 records/)).toBeTruthy();
  });

  it("marks a caveat on the COLLAPSED line, not only inside the expander", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () =>
          answered({
            provenance: {
              ...answered().provenance!,
              line: "Read from Booking blockers, just now — a search was not allowed on this question.",
              hasCaveat: true,
              hasSearchWithheld: true,
            },
          } as Partial<DiagnosticsAskResponse>),
      }),
    );
    renderWidget();
    openDiagnostics();
    fireEvent.change(screen.getByTestId("diagnostics-input"), {
      target: { value: "who is on this booking?" },
    });
    fireEvent.click(screen.getByTestId("diagnostics-send"));

    const toggle = await screen.findByTestId("diagnostics-provenance-toggle");
    expect(toggle.getAttribute("data-has-caveat")).toBe("true");
    expect(toggle.textContent).toContain("a search was not allowed");
    // Still collapsed — the caveat reached the operator without them opening anything.
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("the conversation stays with the operator (#2378, D8)", () => {
  it("keeps the Diagnostics tab open across a navigation", async () => {
    const { rerender } = renderWidget();
    openDiagnostics();
    expect(screen.getByTestId("diagnostics-input")).toBeTruthy();

    // The operator navigates to the booking they are asking about. Page guide is
    // page-specific and falls back to Ask; an open investigation must not.
    mocks.pathname = "/admin/bookings/def";
    rerender(
      <HelpWidgetProvider>
        <HelpWidget
          surface="admin"
          llmEnabled={false}
          resolveHelp={() => CONTENT}
          diagnostics={{ moduleEnabled: true }}
        />
      </HelpWidgetProvider>,
    );
    expect(screen.getByTestId("diagnostics-input")).toBeTruthy();
  });

  it("shows a pending state while a question is in flight", async () => {
    let resolve: ((value: unknown) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(
        new Promise((r) => {
          resolve = r;
        }),
      ),
    );
    renderWidget();
    openDiagnostics();
    fireEvent.change(screen.getByTestId("diagnostics-input"), {
      target: { value: "why is this stuck?" },
    });
    fireEvent.click(screen.getByTestId("diagnostics-send"));

    const pending = await screen.findByTestId("diagnostics-pending");
    // `role="status"` + polite, so it is announced without interrupting.
    expect(pending.getAttribute("role")).toBe("status");
    expect(pending.getAttribute("aria-live")).toBe("polite");

    resolve?.({ ok: true, status: 200, json: async () => answered() });
    await waitFor(() => expect(screen.queryByTestId("diagnostics-pending")).toBeNull());
  });
});

describe("an arriving answer is announced and focus is not stranded (WCAG 4.1.3)", () => {
  it("renders the thread as a polite log region, separate from the pending status", async () => {
    let resolve: ((value: unknown) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(
        new Promise((r) => {
          resolve = r;
        }),
      ),
    );
    renderWidget();
    openDiagnostics();

    const thread = screen.getByTestId("diagnostics-thread");
    // The transcript is a live region in its own right, so an answer that arrives
    // while focus is elsewhere is still announced.
    expect(thread.getAttribute("role")).toBe("log");
    expect(thread.getAttribute("aria-live")).toBe("polite");

    fireEvent.change(screen.getByTestId("diagnostics-input"), {
      target: { value: "why is this stuck?" },
    });
    fireEvent.click(screen.getByTestId("diagnostics-send"));

    // The pending status is a SEPARATE region, not nested inside the log — otherwise
    // "Looking into that…" would be read by both regions (the double-announcement the
    // component is careful to avoid).
    const pending = await screen.findByTestId("diagnostics-pending");
    expect(thread.contains(pending)).toBe(false);

    resolve?.({ ok: true, status: 200, json: async () => answered() });
    await waitFor(() =>
      expect(screen.queryByTestId("diagnostics-pending")).toBeNull(),
    );
    // The answer lands INSIDE the log, so it is the log's own addition that is
    // announced.
    const answer = screen.getByTestId("diagnostics-message-assistant");
    expect(thread.contains(answer)).toBe(true);
    expect(answer.textContent).toContain("The deposit is unpaid.");
  });

  it("returns focus to the question box after an answer, off the disabled Ask button", async () => {
    renderWidget();
    openDiagnostics();
    fireEvent.change(screen.getByTestId("diagnostics-input"), {
      target: { value: "why is this stuck?" },
    });
    fireEvent.click(screen.getByTestId("diagnostics-send"));

    // The Ask button self-disables when the draft clears, dropping browser focus to
    // <body>; the settle handler must put it back on the still-usable question box.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("diagnostics-input")),
    );
  });

  it("moves focus to Start again when a budget refusal disables the box", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          status: "blocked",
          reason: "budget_exhausted",
          message: "Diagnostics has reached this month's spending limit.",
        }),
      }),
    );
    renderWidget();
    openDiagnostics();
    fireEvent.change(screen.getByTestId("diagnostics-input"), {
      target: { value: "why is this stuck?" },
    });
    fireEvent.click(screen.getByTestId("diagnostics-send"));

    // The question box is now disabled, so focus cannot go there; it must land on a
    // real control rather than be lost to <body>.
    //
    // Both conditions are awaited, and the focus one separately, because disabling the
    // box and moving focus are different effects. Waiting only for `disabled` and then
    // asserting focus synchronously races the second effect: on a loaded runner the
    // assertion lands while focus is still on the announcement heading, which is the
    // intermediate state, and the test fails for a reason that has nothing to do with
    // the behaviour it guards (#2883).
    await waitFor(() =>
      expect(
        (screen.getByTestId("diagnostics-input") as HTMLTextAreaElement).disabled,
      ).toBe(true),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Start again" }),
      ),
    );
  });
});

/** Stands in for a wired admin list: publishes, then unmounts on "navigation". */
function ViewPublisher({ view }: { view: DiagnosticsViewState | undefined }) {
  usePublishDiagnosticsViewState(view);
  return null;
}

function renderWidgetWithPublisher(view: DiagnosticsViewState | undefined) {
  const tree = (published: DiagnosticsViewState | undefined, mounted = true) => (
    <HelpWidgetProvider>
      {mounted ? <ViewPublisher view={published} /> : null}
      <HelpWidget
        surface="admin"
        llmEnabled={false}
        resolveHelp={() => CONTENT}
        diagnostics={{ moduleEnabled: true }}
      />
    </HelpWidgetProvider>
  );
  const { rerender } = render(tree(view));
  return {
    republish: (next: DiagnosticsViewState | undefined) => rerender(tree(next)),
    navigateAway: () => rerender(tree(undefined, false)),
  };
}

function sentBody(call = 0) {
  return JSON.parse(
    (fetch as unknown as { mock: { calls: [string, { body: string }][] } }).mock
      .calls[call][1].body,
  );
}

async function ask(question: string, expectedCalls = 1) {
  fireEvent.change(screen.getByTestId("diagnostics-input"), {
    target: { value: question },
  });
  fireEvent.click(screen.getByTestId("diagnostics-send"));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(expectedCalls));
}

describe("the question carries the page's PUBLISHED APPLIED view state (#2816)", () => {
  /**
   * The owner decision of 13 Aug 2026: the channel is what the page APPLIED, not
   * the address bar. These tests are the precedence half; the pages' own
   * derivations are proved in `src/lib/__tests__/diagnostics-published-view-*`.
   */
  it("prefers the published view over the URL when the two disagree", async () => {
    // The payments case in miniature: the address says nothing about the
    // activity window the page actually applied, and it carries a stale status.
    window.history.pushState({}, "", "/admin/payments?status=FAILED");
    try {
      renderWidgetWithPublisher({
        status: "SUCCEEDED",
        filters: { lastUpdatedFrom: "2026-05-13", lastUpdatedTo: "2026-08-13" },
      });
      openDiagnostics();
      await ask("why is this payment not here?");
      expect(sentBody().view).toEqual({
        status: "SUCCEEDED",
        filters: { lastUpdatedFrom: "2026-05-13", lastUpdatedTo: "2026-08-13" },
      });
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  it("sends NO view when the page published an empty one, even from a filtered-looking URL", async () => {
    // THE MALFORMED-ADDRESS CASE. `?from=13-45-2026` fails the bookings query
    // schema, whose parse is total, so the page applied no filters at all while
    // the address still displays every one of them. An empty publication must
    // SUPPRESS the URL fallback — falling back here would report filters the
    // list is not using, the exact wrong answer to "why is this booking not
    // showing?".
    window.history.pushState(
      {},
      "",
      "/admin/bookings?status=CONFIRMED&from=13-45-2026&search=ngata",
    );
    try {
      renderWidgetWithPublisher({});
      openDiagnostics();
      await ask("why is this booking not showing?");
      expect(sentBody().view).toBeUndefined();
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  it("republishes when a filter changes, so the second question carries the second view", async () => {
    const { republish } = renderWidgetWithPublisher({
      filters: { search: "ngata" },
    });
    openDiagnostics();
    await ask("first");
    expect(sentBody(0).view).toEqual({ filters: { search: "ngata" } });

    republish({ filters: { search: "hemi" } });
    await ask("second", 2);
    expect(sentBody(1).view).toEqual({ filters: { search: "hemi" } });
  });

  it("clears on navigation, so the next page cannot inherit the last one's filters", async () => {
    // The conversation deliberately survives a navigation (D8), which is exactly
    // why the view state must not: an operator who filtered the payments list to
    // one member, then moved to bookings, must not have that name reported as
    // the bookings list's filter.
    const { navigateAway } = renderWidgetWithPublisher({
      filters: { search: "ngata" },
    });
    openDiagnostics();
    navigateAway();
    await ask("and on this screen?");
    expect(sentBody().view).toBeUndefined();
  });
});

describe("the operator is told the filters travel (#2816, owner decision)", () => {
  it("renders the disclosure on the surface where questions are typed", () => {
    renderWidget();
    openDiagnostics();
    const disclosure = screen.getByTestId("diagnostics-view-disclosure");
    expect(disclosure.textContent).toMatch(/filters and search on this page/);
    // The free-text search is the part that is easy to be surprised by, and the
    // ticks do NOT gate it — both facts have to be in the sentence.
    expect(disclosure.textContent).toMatch(/typed into a search box/);
    expect(disclosure.textContent).toMatch(/boxes above do not affect that/);
    // It sits with the input, not somewhere the operator has to go looking.
    expect(screen.getByTestId("diagnostics-input")).toBeTruthy();
  });

  it("wires the disclosure to the question box, so it is announced on focus", () => {
    // Placing it next to the box is not enough: a screen-reader user tabbing
    // straight into the textarea never hears an unassociated paragraph, and they
    // are the audience the owner decision's "always send and SAY SO" most
    // obviously covers (review finding, 13 Aug 2026).
    renderWidget();
    openDiagnostics();
    const disclosure = screen.getByTestId("diagnostics-view-disclosure");
    const input = screen.getByTestId("diagnostics-input");
    expect(disclosure.id).toBeTruthy();
    expect(input.getAttribute("aria-describedby")).toBe(disclosure.id);
  });
});

describe("page help never gains the admin view state (#2816)", () => {
  it("carries no view field, even while an admin list is publishing one", async () => {
    // Diagnostics and page help are separate products with separate endpoints
    // (ADR-001). The published state is read by the Diagnostics surface only, so
    // a member-facing question cannot carry an operator's filters — including a
    // search term naming a person.
    render(
      <HelpWidgetProvider>
        <ViewPublisher view={{ filters: { search: "ngata" } }} />
        <HelpWidget
          surface="member"
          llmEnabled
          chatEndpoint="/api/help/chat"
          resolveHelp={() => CONTENT}
        />
      </HelpWidgetProvider>,
    );
    fireEvent.click(screen.getByTestId("help-widget-launcher"));
    // No Diagnostics surface exists at all without the prop that grants it.
    expect(screen.queryByTestId("help-widget-tab-diagnostics")).toBeNull();

    const input = screen.getByLabelText("Ask about this page");
    fireEvent.change(input, { target: { value: "how do I book?" } });
    fireEvent.click(screen.getByLabelText("Send question"));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const body = sentBody();
    expect(body.view).toBeUndefined();
    // And the published search term is nowhere in the payload at all.
    expect(JSON.stringify(body)).not.toContain("ngata");
  });
});

describe("the URL fallback still serves a page that publishes nothing (#2816)", () => {
  it("sends the live query string as the view, raw", async () => {
    // Unwired pages keep the original channel: read at ask time, sent raw,
    // narrowed to the registry row's allowlists SERVER-side.
    window.history.pushState({}, "", "/admin/bookings?status=CONFIRMED&from=2026-08-01&page=3");
    try {
      renderWidget();
      openDiagnostics();
      fireEvent.change(screen.getByTestId("diagnostics-input"), {
        target: { value: "why is this list so short?" },
      });
      fireEvent.click(screen.getByTestId("diagnostics-send"));
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      const sent = JSON.parse(
        (fetch as unknown as { mock: { calls: [string, { body: string }][] } }).mock
          .calls[0][1].body,
      );
      expect(sent.view).toEqual({
        status: "CONFIRMED",
        filters: { from: "2026-08-01", page: "3" },
      });
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  it("sends no view at all from a bare URL", async () => {
    window.history.pushState({}, "", "/admin/bookings");
    try {
      renderWidget();
      openDiagnostics();
      fireEvent.change(screen.getByTestId("diagnostics-input"), {
        target: { value: "anything" },
      });
      fireEvent.click(screen.getByTestId("diagnostics-send"));
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      const sent = JSON.parse(
        (fetch as unknown as { mock: { calls: [string, { body: string }][] } }).mock
          .calls[0][1].body,
      );
      expect(sent.view).toBeUndefined();
    } finally {
      window.history.pushState({}, "", "/");
    }
  });
});
