// @vitest-environment jsdom

/**
 * A promo-code read that fails says so in the screen's own words (#4976,
 * ALP-589).
 *
 * The list, the archived list and the Xero account and item lists used to show
 * the caught error's own text. A dropped connection therefore read as the
 * browser's "Failed to fetch", and a 200 whose body was an HTML page as a JSON
 * parse error. Each now shows the screen's sentence: the same one a refused
 * (non-2xx) reply has always shown.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";
import { htmlErrorPage } from "@/lib/__tests__/support/failed-write-cases";

vi.mock("@/components/lodge-select", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  useLodgeOptions: () => ({
    lodges: [{ id: "lodge-a", name: "Lodge A" }],
    loading: false,
    failed: false,
    forbidden: false,
    reload: vi.fn(),
  }),
}));

import { PromoCodesPageClient } from "../promo-codes-page-client";

const MATRIX: AdminPermissionMatrix = {
  overview: "edit",
  bookings: "edit",
  membership: "edit",
  finance: "edit",
  lodge: "edit",
  content: "edit",
  support: "edit",
};

type Answer = () => Response | Promise<Response>;
const dropped: Answer = () => Promise.reject(new TypeError("Failed to fetch"));
const htmlWithOkStatus: Answer = () =>
  new Response("<html><body>Bad Gateway</body></html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });

function stub(answers: Record<string, Answer>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const answer = answers[String(input)];
      if (answer) return answer();
      return Response.json([]);
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Every way a read can fail that is not a refusal the server worded. */
const FAILURES: Array<[string, Answer]> = [
  ["a dropped connection", dropped],
  ["an HTML 502", () => htmlErrorPage(502)],
  ["an HTML page with a 200 status", htmlWithOkStatus],
];

describe("Promo codes: a failed list read", () => {
  it.each(FAILURES)("shows the screen's sentence for %s", async (_label, answer) => {
    stub({ "/api/admin/promo-codes": answer });
    render(<PromoCodesPageClient permissionMatrix={MATRIX} />);

    expect(await screen.findAllByText("Failed to fetch promo codes")).not.toHaveLength(0);
    expect(screen.queryByText("Failed to fetch")).not.toBeInTheDocument();
    expect(screen.queryByText(/JSON|Unexpected token/)).not.toBeInTheDocument();
  });
});

describe("Promo codes: a failed archived-list read", () => {
  it.each(FAILURES)("shows the screen's sentence for %s", async (_label, answer) => {
    stub({ "/api/admin/promo-codes?archived=true": answer });
    render(<PromoCodesPageClient permissionMatrix={MATRIX} />);
    fireEvent.click(await screen.findByRole("button", { name: /Archived Promo Codes/ }));

    expect(await screen.findAllByText("Failed to fetch archived codes")).not.toHaveLength(0);
    expect(screen.queryByText("Failed to fetch")).not.toBeInTheDocument();
    expect(screen.queryByText(/JSON|Unexpected token/)).not.toBeInTheDocument();
  });
});

describe("Promo codes: a failed Xero account and item read", () => {
  async function openForm() {
    render(<PromoCodesPageClient permissionMatrix={MATRIX} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add Promo Code" }));
  }

  it.each([
    ["a dropped connection", dropped],
    ["an HTML page with a 200 status", htmlWithOkStatus],
  ] as Array<[string, Answer]>)("shows the screen's sentence for %s", async (_label, answer) => {
    stub({ "/api/admin/xero/chart-of-accounts": answer });
    await openForm();

    expect(await screen.findByText(/Could not load Xero accounts\/items/)).toBeInTheDocument();
    expect(screen.queryByText(/Failed to fetch|JSON|Unexpected token/)).not.toBeInTheDocument();
  });

  it("keeps the amber note for a Xero connection that is down", async () => {
    stub({ "/api/admin/xero/chart-of-accounts": () => htmlErrorPage(500) });
    await openForm();

    expect(
      await screen.findByText(/Xero not connected or accounts\/items unavailable/),
    ).toBeInTheDocument();
  });
});
