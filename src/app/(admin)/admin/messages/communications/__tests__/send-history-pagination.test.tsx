// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SendHistoryCard } from "../_components/send-history-card";

/**
 * #5202 / INV-OPS-020 — the send history pages through every bulk send,
 * shows its total, steps back from a page left empty, never lets a slower read
 * replace the page shown, and returns to page 1 after a send.
 */

const route = "/api/admin/communications/history";

function send(page: number) {
  return {
    id: `send-${page}`,
    sentBy: "m-1",
    subject: `Newsletter ${page}`,
    recipientFilter: "all",
    totalRecipients: 10,
    eligibleRecipients: 9,
    queued: 9,
    sentAt: "2026-06-30T10:00:00.000Z",
  };
}

/** The route's response: one page through the shared `adminListPage` keys. */
function envelope(history: unknown[], page: number, total: number) {
  return { data: history, history, page, pageSize: 25, total, totalPages: Math.ceil(total / 25) };
}

function installFetch(handler: (page: number) => unknown | Promise<unknown>) {
  const pages: string[] = [];
  global.fetch = vi.fn(async (input: unknown) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === route) pages.push(url.searchParams.get("page") ?? "");
    const body = await handler(Number(url.searchParams.get("page")));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return pages;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SendHistoryCard paging", () => {
  it("asks for page 1, shows the total and steps through pages", async () => {
    const pages = installFetch((page) => envelope([send(page)], page, 40));
    render(<SendHistoryCard refreshVersion={0} />);

    expect(await screen.findByText("Showing 1–25 of 40")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("Showing 26–40 of 40")).toBeInTheDocument();
    expect(screen.getByText("Newsletter 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(await screen.findByText("Showing 1–25 of 40")).toBeInTheDocument();
    expect(pages).toEqual(["1", "2", "1"]);
  });

  it("shows the total line on a single page", async () => {
    installFetch(() => envelope([send(1)], 1, 1));
    render(<SendHistoryCard refreshVersion={0} />);
    expect(await screen.findByText("Showing 1–1 of 1")).toBeInTheDocument();
  });

  it("returns to page 1 after a send, and re-reads page 1 when already there", async () => {
    const pages = installFetch((page) => envelope([send(page)], page, 40));
    const { rerender } = render(<SendHistoryCard refreshVersion={0} />);
    await screen.findByText("Showing 1–25 of 40");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("Showing 26–40 of 40");

    rerender(<SendHistoryCard refreshVersion={1} />);
    expect(await screen.findByText("Showing 1–25 of 40")).toBeInTheDocument();
    rerender(<SendHistoryCard refreshVersion={2} />);
    await waitFor(() => expect(pages).toEqual(["1", "2", "1", "1"]));
  });

  it("steps back a page when the page it is on has emptied", async () => {
    let total = 40;
    const pages = installFetch((page) =>
      page === 2 && total === 25 ? envelope([], 2, total) : envelope([send(page)], page, total),
    );
    render(<SendHistoryCard refreshVersion={0} />);
    await screen.findByText("Showing 1–25 of 40");

    total = 25;
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    // The total line is drawn from the stepped-back page number as soon as the
    // empty page 2 is received, in the render before the effect that asks for
    // page 1 again runs. So the third request is awaited, never counted straight after the
    // line appears (#5361: that order failed once on main).
    await waitFor(() => expect(pages).toEqual(["1", "2", "1"]));
    expect(await screen.findByText("Showing 1–25 of 25")).toBeInTheDocument();
    // Page 1's row is back, so the step-back read was answered and shown.
    expect(await screen.findByText("Newsletter 1")).toBeInTheDocument();
    expect(pages).toEqual(["1", "2", "1"]);
  });

  it("never lets a slower read for a page it has left replace the list shown", async () => {
    const slow: { release?: () => void } = {};
    installFetch(async (page) => {
      if (page === 2) {
        await new Promise<void>((resolve) => {
          slow.release = resolve;
        });
        return envelope([{ ...send(2), subject: "Stale newsletter" }], 2, 40);
      }
      return envelope([send(1)], 1, 40);
    });
    render(<SendHistoryCard refreshVersion={0} />);
    await screen.findByText("Showing 1–25 of 40");

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(slow.release).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    await screen.findByText("Newsletter 1");

    slow.release!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText("Stale newsletter")).not.toBeInTheDocument();
    expect(screen.getByText("Newsletter 1")).toBeInTheDocument();
    expect(screen.getByText("Showing 1–25 of 40")).toBeInTheDocument();
  });
});
