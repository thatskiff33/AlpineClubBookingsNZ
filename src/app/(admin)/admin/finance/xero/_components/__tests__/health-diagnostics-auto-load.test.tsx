// @vitest-environment jsdom

/**
 * The Xero health snapshot and the two mismatch audits each load automatically
 * once per opening (#5276).
 *
 * Before the shared `useAutoLoadOncePerOpening` latch, each effect re-fired
 * every time its `loading` flag settled, so a failing read was requested over
 * and over and its error flickered in and out — the loop #5203 fixed for
 * Account Mappings.
 */

import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@/lib/__tests__/support/club-time-render";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchJson: vi.fn(),
  postJson: vi.fn(),
}));

vi.mock("../api", () => ({
  fetchJson: mocks.fetchJson,
  postJson: mocks.postJson,
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

import { HealthAndDiagnosticsPanels } from "../health-diagnostics-panel";
import { xeroSectionId } from "../types";

type ListCase = {
  name: string;
  /** The GET the automatic load makes. */
  url: string;
  /** The section's key; the other two sections stay closed. */
  section: "health" | "contactGroupMismatches" | "contactLinkMismatches";
  /** Which prop opens it. */
  openProp: "healthOpen" | "contactGroupMismatchesOpen" | "contactLinkMismatchesOpen";
  /** The admin's own retry: its button, and the client function it calls. */
  retryButton: string;
  retryMock: "fetchJson" | "postJson";
};

const LISTS: ListCase[] = [
  {
    name: "Xero health",
    url: "/api/admin/xero/health",
    section: "health",
    openProp: "healthOpen",
    retryButton: "Refresh Health",
    retryMock: "fetchJson",
  },
  {
    name: "contact group mismatches",
    url: "/api/admin/xero/contact-group-mismatches",
    section: "contactGroupMismatches",
    openProp: "contactGroupMismatchesOpen",
    retryButton: "Refresh",
    retryMock: "postJson",
  },
  {
    name: "contact link mismatches",
    url: "/api/admin/xero/contact-link-mismatches",
    section: "contactLinkMismatches",
    openProp: "contactLinkMismatchesOpen",
    retryButton: "Refresh",
    retryMock: "postJson",
  },
];

const ERROR = "Xero is unreachable";

function requests(mock: "fetchJson" | "postJson", url: string): number {
  return mocks[mock].mock.calls.filter(([called]) => String(called).startsWith(url)).length;
}

function panels(list: ListCase, open: boolean, connected = true) {
  return (
    <HealthAndDiagnosticsPanels
      connected={connected}
      shortCode={null}
      currentXeroPath="/admin/xero"
      healthOpen={false}
      contactGroupMismatchesOpen={false}
      contactLinkMismatchesOpen={false}
      {...{ [list.openProp]: open }}
      onToggle={() => {}}
      onMessage={() => {}}
      onRefreshOperations={() => {}}
      refreshToken={0}
      scrollToSection={() => {}}
    />
  );
}

// Let any effect re-run that a settled load would trigger get its chance.
async function settle() {
  for (let i = 0; i < 5; i += 1) await act(async () => {});
}

describe.each(LISTS)("$name — auto-load runs once per opening (#5276)", (list) => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchJson.mockRejectedValue(new Error(ERROR));
    mocks.postJson.mockRejectedValue(new Error(ERROR));
  });

  it("a failed load is requested once and stays shown until the admin retries", async () => {
    render(panels(list, true));

    await screen.findByText(ERROR);
    await settle();
    expect(requests("fetchJson", list.url)).toBe(1);
    expect(screen.getByText(ERROR)).toBeTruthy();

    const retriesBefore = requests(list.retryMock, list.url);
    // Every section renders its actions even while closed, so find the button
    // inside this list's own section.
    const section = document.getElementById(xeroSectionId(list.section));
    if (!section) throw new Error(`section ${list.section} not rendered`);
    fireEvent.click(within(section).getByRole("button", { name: list.retryButton }));
    await waitFor(() => expect(requests(list.retryMock, list.url)).toBe(retriesBefore + 1));
    await screen.findByText(ERROR);
    await settle();
    // The pressed retry's failure is requested once and shown once, and it
    // does not set the automatic load off again.
    expect(requests(list.retryMock, list.url)).toBe(retriesBefore + 1);
    expect(requests("fetchJson", list.url)).toBe(list.retryMock === "fetchJson" ? 2 : 1);
    expect(screen.getAllByText(ERROR)).toHaveLength(1);
  });

  it("closing and reopening the section loads again after a failed load", async () => {
    const { rerender } = render(panels(list, true));
    await screen.findByText(ERROR);
    await settle();
    expect(requests("fetchJson", list.url)).toBe(1);

    rerender(panels(list, false));
    await settle();
    expect(requests("fetchJson", list.url)).toBe(1);
    rerender(panels(list, true));
    await settle();
    expect(requests("fetchJson", list.url)).toBe(2);
  });

  it("disconnecting and reconnecting Xero loads again after a failed load", async () => {
    const { rerender } = render(panels(list, true));
    await screen.findByText(ERROR);
    await settle();
    expect(requests("fetchJson", list.url)).toBe(1);

    rerender(panels(list, true, false));
    await settle();
    expect(requests("fetchJson", list.url)).toBe(1);
    rerender(panels(list, true, true));
    await settle();
    expect(requests("fetchJson", list.url)).toBe(2);
  });
});

// A valid re-sync result for each mismatch list, and the text it shows once
// loaded: an up-to-date cache with nothing mismatched.
const RESYNC_CASES = [
  {
    list: LISTS[1],
    response: {
      mode: "MEMBERSHIP_TYPE",
      cacheReady: true,
      lastRefreshedAt: null,
      activeRuleCount: 1,
      membersConsidered: 0,
      mismatchCount: 0,
      addCount: 0,
      removeCount: 0,
      estimatedXeroCalls: 0,
      skippedNoContact: [],
      mismatches: [],
      informationalCount: 0,
      informational: [],
    },
    shown: "No linked members are currently mismatched against the active grouping rules.",
  },
  {
    list: LISTS[2],
    response: { cacheReady: true, lastRefreshedAt: null, count: 0, mismatches: [] },
    shown: "No linked members are currently mismatched against the cached Xero contact names.",
  },
];

describe.each(RESYNC_CASES)("$list.name — a running re-sync counts as busy (#5276)", ({ list, response, shown }) => {
  beforeEach(() => {
    vi.clearAllMocks();
    // If the cached read did fire, it would succeed; the count is what matters.
    mocks.fetchJson.mockResolvedValue(response);
  });

  it("opening the section while a re-sync is in flight makes no cached read", async () => {
    let resolveResync: (value: unknown) => void = () => {};
    mocks.postJson.mockImplementation(
      () => new Promise((resolve) => { resolveResync = resolve; }),
    );

    // Refresh renders while the section is closed, so the re-sync can start
    // before the section opens.
    const { rerender } = render(panels(list, false));
    const section = document.getElementById(xeroSectionId(list.section));
    if (!section) throw new Error(`section ${list.section} not rendered`);
    fireEvent.click(within(section).getByRole("button", { name: list.retryButton }));
    await waitFor(() => expect(requests("postJson", list.url)).toBe(1));

    rerender(panels(list, true));
    await settle();
    // Without the busy term the automatic read would race the re-sync and
    // could overwrite its newer result.
    expect(requests("fetchJson", list.url)).toBe(0);

    await act(async () => { resolveResync(response); });
    await settle();
    expect(requests("fetchJson", list.url)).toBe(0);
    expect(requests("postJson", list.url)).toBe(1);
    expect(screen.getByText(shown)).toBeTruthy();
  });
});
