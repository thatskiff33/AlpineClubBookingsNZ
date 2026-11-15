// @vitest-environment jsdom

/**
 * A refused fee-configuration load or save says why (#4976, ALP-589).
 *
 * Both parsed the reply as JSON before checking it and showed `err.message`,
 * so an HTML 502 from the proxy read as a JSON parse error and a dropped
 * connection as "Failed to fetch". The cross-area 403 notice is covered by
 * `fee-configuration-page.test.tsx`.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { itShowsEveryRefusal } from "@/lib/__tests__/support/failed-write-cases";

vi.mock("sonner", async () => (await import("@/lib/__tests__/support/toast-to-document")).sonnerToDocument);

import { FinanceFeesSections } from "../finance-fees-sections";

const data = {
  canEdit: true,
  familyBillingMode: "BILL_FAMILY_VIA_BILLING_MEMBER",
  defaultInvoiceAccountCode: "203",
  membershipTypes: [{
    id: "type-1", key: "FULL", name: "Full", isActive: true,
    annualFees: [{ id: "fee-1", ageTier: null, amountCents: 10000, effectiveFrom: "2026-01-01", effectiveTo: null, billingBasis: "PER_MEMBER", prorationRule: "NONE" }],
    joiningFees: [],
  }],
  familyGroups: [],
};

type Answer = () => Response | Promise<Response>;

function installFetch({ load, save }: { load?: Answer; save?: Answer }) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("chart-of-accounts")) return Response.json({ accounts: [] });
    if (url.includes("/admin/xero/items")) return Response.json({ items: [] });
    if (init?.method === "POST") return (save ?? (() => Response.json(data)))();
    return (load ?? (() => Response.json(data)))();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function updateTheFee() {
  render(<FinanceFeesSections />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit membership fees" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit Full Flat (all ages) fee" }));
  fireEvent.click(screen.getByRole("button", { name: "Update annual fee" }));
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("fee configuration refusals", () => {
  describe("loading the fee configuration", () => {
    itShowsEveryRefusal({
      fallback: "Failed to load fee configuration",
      submit: async (answer) => {
        installFetch({ load: answer });
        render(<FinanceFeesSections />);
      },
    });
  });

  describe("saving a fee schedule", () => {
    itShowsEveryRefusal({
      fallback: "Failed to save fee configuration",
      submit: async (answer) => {
        installFetch({ save: answer });
        await updateTheFee();
      },
    });

    it("takes the saved configuration on success", async () => {
      const fetchMock = installFetch({});
      await updateTheFee();

      expect(await screen.findByText("Fee schedule saved")).toBeInTheDocument();
      await waitFor(() =>
        expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1),
      );
    });
  });
});
