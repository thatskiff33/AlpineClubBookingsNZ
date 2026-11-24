// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real permission hook and the route's own requirement list decide who
// may edit; only the session behind them is faked.
const session = vi.hoisted(() => ({
  status: "authenticated" as "authenticated" | "loading",
  membership: "edit" as "edit" | "view",
  finance: "edit" as "edit" | "view",
}));
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    status: session.status,
    data:
      session.status === "loading"
        ? null
        : {
            user: {
              id: "officer",
              adminPermissionMatrix: {
                overview: "view",
                bookings: "view",
                membership: session.membership,
                finance: session.finance,
                lodge: "view",
                content: "view",
                support: "view",
              },
            },
          },
  }),
}));

import { SubscriptionLiabilityRuleSection } from "@/components/admin/subscription-liability-rule-section";

/**
 * The subscription-liability section on Admin -> Subscription lockout (#5190).
 *
 * What it must guarantee: the rule is saved only after the officer has seen a
 * preview of exactly the answers being saved (choosing moves money); the save
 * sends the pair and nothing else, so the lockout panel's other settings are
 * never re-written from this section; and an admin without both Membership
 * edit and Finance edit cannot open the editor (owner decision 23 Nov 2026).
 */

const ENDPOINT = "/api/admin/membership-lockout-settings";
const IMPACT_ENDPOINT = "/api/admin/membership-lockout-settings/liability-impact";
const NOT_CHOSEN = { requiredTypeAgeRule: "NOT_CHOSEN", liabilityAgeSource: "NOT_CHOSEN" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const IMPACT = {
  seasonYear: 2026,
  current: NOT_CHOSEN,
  proposed: { requiredTypeAgeRule: "ALWAYS_OWES", liabilityAgeSource: "SEASON_START" },
  newlyOwing: [{ memberId: "sam", name: "Sam Small", billingChanges: false, accessChanges: true }],
  noLongerOwing: [
    { memberId: "ola", name: "Ola Old", billingChanges: true, accessChanges: false, unpaidInvoiceNumber: "INV-7" },
  ],
  staleRecords: [
    {
      memberId: "mia",
      name: "Mia Major",
      inBillingPopulation: true,
      listStatus: "NOT_INVOICED",
      listNote: "Marked not required, but billing treats this member as owing",
    },
    {
      memberId: "ivy",
      name: "Ivy Idle",
      inBillingPopulation: false,
      listStatus: "NOT_REQUIRED",
      listNote: null,
    },
  ],
};

function stubFetch(input: {
  stored?: Record<string, string>;
  putStatus?: number;
  putBody?: unknown;
  clearedStaleRecords?: number | null;
} = {}) {
  let stored = { mode: "HARD_BLOCK", ...NOT_CHOSEN, ...input.stored };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === ENDPOINT && method === "GET") return json({ settings: stored });
    if (url.startsWith(`${IMPACT_ENDPOINT}?`) && method === "GET") {
      const query = new URLSearchParams(url.slice(IMPACT_ENDPOINT.length + 1));
      return json({
        impact: { ...IMPACT, proposed: Object.fromEntries(query) },
        invoiceNumbersShown: true,
      });
    }
    if (url === ENDPOINT && method === "PUT") {
      if (input.putStatus && input.putStatus !== 200) {
        return json(input.putBody ?? { error: "Refused" }, input.putStatus);
      }
      stored = { ...stored, ...JSON.parse(String(init?.body)) };
      return json({ settings: stored, clearedStaleRecords: input.clearedStaleRecords ?? null });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function putCalls(fetchMock: ReturnType<typeof stubFetch>) {
  return fetchMock.mock.calls.filter(([url, init]) => url === ENDPOINT && init?.method === "PUT");
}

async function openEditor() {
  fireEvent.click(await screen.findByRole("button", { name: /choose rule|change rule/i }));
}

function choose(label: string) {
  fireEvent.click(screen.getByRole("radio", { name: new RegExp(label, "i") }));
}

describe("SubscriptionLiabilityRuleSection (#5190)", () => {
  beforeEach(() => {
    session.status = "authenticated";
    session.membership = "edit";
    session.finance = "edit";
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("explains a club still on Not chosen, read-only", async () => {
    stubFetch();
    render(<SubscriptionLiabilityRuleSection />);
    expect(await screen.findByText("Not chosen yet")).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("states a chosen rule in plain English", async () => {
    stubFetch({ stored: { requiredTypeAgeRule: "AGE_TIER_EXEMPTS", liabilityAgeSource: "SEASON_END" } });
    render(<SubscriptionLiabilityRuleSection />);
    expect(await screen.findByText("Their age group exempts them")).toBeTruthy();
    expect(screen.getByText("Their age on the last day of the season")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change rule" })).toBeTruthy();
  });

  it.each([
    ["Membership edit alone", { membership: "edit", finance: "view" }],
    ["Finance edit alone", { membership: "view", finance: "edit" }],
  ] as const)("is view-only with %s, saying both are needed", async (_label, granted) => {
    Object.assign(session, granted);
    stubFetch();
    render(<SubscriptionLiabilityRuleSection />);
    const edit = await screen.findByRole("button", { name: "Choose rule" });
    expect((edit as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/needs both Membership edit and Finance edit/)).toBeTruthy();
  });

  it("does not offer age today until part-season invoices exist", async () => {
    stubFetch();
    render(<SubscriptionLiabilityRuleSection />);
    await openEditor();
    expect((screen.getByRole("radio", { name: /their age today/i }) as HTMLInputElement).disabled).toBe(true);
  });

  it("saves only after a preview of exactly the chosen answers, and sends only the pair", async () => {
    const fetchMock = stubFetch({ clearedStaleRecords: 2 });
    render(<SubscriptionLiabilityRuleSection />);
    await openEditor();
    const save = () => screen.getByRole("button", { name: "Save rule" }) as HTMLButtonElement;
    const previewButton = () => screen.getByRole("button", { name: "Preview changes" }) as HTMLButtonElement;

    // Half a rule cannot be previewed or saved.
    choose("They still owe");
    expect(previewButton().disabled).toBe(true);
    expect(save().disabled).toBe(true);

    choose("first day of the season");
    expect(save().disabled).toBe(true);
    fireEvent.click(previewButton());

    // The preview names every list the officer is deciding on.
    expect(await screen.findByText("Sam Small")).toBeTruthy();
    expect(screen.getByText("(must pay before booking)")).toBeTruthy();
    expect(screen.getByText(/unpaid invoice INV-7/)).toBeTruthy();
    expect(screen.getByText("Mia Major")).toBeTruthy();
    expect(screen.getByText(/inactive or archived/)).toBeTruthy();
    // Owner decision 22 Nov 2026: each stale row names the members list's own
    // status, billing's "Not Invoiced" for a noted row.
    expect(
      screen.getByText(/members list shows Not Invoiced, with the “Marked not required” note/),
    ).toBeTruthy();
    expect(screen.getByText(/members list shows Not Required; inactive or archived/)).toBeTruthy();
    await waitFor(() => expect(save().disabled).toBe(false));

    // Changing an answer makes the preview stale and blocks Save again.
    choose("last day of the season");
    expect(save().disabled).toBe(true);
    expect(screen.getByText(/answers have changed since this preview/)).toBeTruthy();
    choose("first day of the season");
    expect(save().disabled).toBe(false);

    fireEvent.click(save());
    expect(await screen.findByText(/Rule saved.*2 "Not required" records were reset/)).toBeTruthy();

    const puts = putCalls(fetchMock);
    expect(puts).toHaveLength(1);
    expect(JSON.parse(String(puts[0]?.[1]?.body))).toEqual({
      requiredTypeAgeRule: "ALWAYS_OWES",
      liabilityAgeSource: "SEASON_START",
    });
    // The preview asked about the same pair the save sent.
    const previewUrl = fetchMock.mock.calls
      .map(([url]) => String(url))
      .find((url) => url.startsWith(IMPACT_ENDPOINT));
    expect(previewUrl).toBe(`${IMPACT_ENDPOINT}?requiredTypeAgeRule=ALWAYS_OWES&liabilityAgeSource=SEASON_START`);
    // Back to read-only, showing the saved rule.
    expect(await screen.findByText("They still owe")).toBeTruthy();
  });

  it("shows the route's own refusal and stays in the editor", async () => {
    stubFetch({
      putStatus: 403,
      putBody: {
        error: "Choosing the subscription liability rule needs both Membership edit and Finance edit access.",
      },
    });
    render(<SubscriptionLiabilityRuleSection />);
    await openEditor();
    choose("Their age group exempts them");
    choose("first day of the season");
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    await screen.findByText("Sam Small");
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
    expect(
      await screen.findByText(
        "Choosing the subscription liability rule needs both Membership edit and Finance edit access.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save rule" })).toBeTruthy();
  });

  it("Cancel reverts the answers and drops the preview", async () => {
    const fetchMock = stubFetch();
    render(<SubscriptionLiabilityRuleSection />);
    await openEditor();
    choose("They still owe");
    choose("first day of the season");
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    await screen.findByText("Sam Small");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("Sam Small")).toBeNull();
    expect(screen.getByText("Not chosen yet")).toBeTruthy();
    expect(putCalls(fetchMock)).toHaveLength(0);
  });

  it("offers no editor and no view-only banner while the session resolves", async () => {
    session.status = "loading";
    stubFetch();
    render(<SubscriptionLiabilityRuleSection />);
    const edit = await screen.findByRole("button", { name: "Choose rule" });
    expect((edit as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/needs both Membership edit and Finance edit/)).toBeNull();
  });

  it("says so when the save reset a different number of records than the preview listed", async () => {
    stubFetch({ clearedStaleRecords: 3 });
    render(<SubscriptionLiabilityRuleSection />);
    await openEditor();
    choose("They still owe");
    choose("first day of the season");
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    await screen.findByText("Sam Small");
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
    expect(
      await screen.findByText(/3 "Not required" records were reset.*The preview listed 2/),
    ).toBeTruthy();
  });

  it("drops a preview that arrives after Cancel, so a reopened editor cannot save on it", async () => {
    const fetchMock = stubFetch();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const answer = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith(`${IMPACT_ENDPOINT}?`)) await held;
      return answer(url, init);
    });
    render(<SubscriptionLiabilityRuleSection />);
    await openEditor();
    choose("They still owe");
    choose("first day of the season");
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    release();
    await held;

    await openEditor();
    choose("They still owe");
    choose("first day of the season");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Sam Small")).toBeNull();
    expect((screen.getByRole("button", { name: "Save rule" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
