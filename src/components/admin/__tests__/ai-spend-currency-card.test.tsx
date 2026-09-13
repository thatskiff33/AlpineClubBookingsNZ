// @vitest-environment jsdom

/**
 * THE CURRENCY FOR AI SPEND CARD (#3354). One component on two settings pages;
 * the states pinned here are the ones an operator can be misled by: an NZD club
 * shown an editor for a rate that does nothing, an unset rate rendered as a
 * number, a view-only admin invited to type, and a saved draft trusted over the
 * server's echo.
 */

import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AiSpendCurrencyCard } from "../ai-spend-currency-card";

const mocks = vi.hoisted(() => ({ canEdit: true as boolean | undefined }));
vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => mocks.canEdit,
}));

type RateBody = {
  clubCurrency: string;
  isNzd: boolean;
  isConfigured: boolean;
  clubUnitsPerNzdMicros: number;
  clubUnitsPerNzd: string;
  rateSetAt: string | null;
  rateSetByMemberId: string | null;
};

const UNSET_AUD: RateBody = {
  clubCurrency: "AUD",
  isNzd: false,
  isConfigured: false,
  clubUnitsPerNzdMicros: 1_000_000,
  clubUnitsPerNzd: "1.00",
  rateSetAt: null,
  rateSetByMemberId: null,
};

const SET_AUD: RateBody = {
  clubCurrency: "AUD",
  isNzd: false,
  isConfigured: true,
  clubUnitsPerNzdMicros: 920_000,
  clubUnitsPerNzd: "0.92",
  rateSetAt: "2026-06-15T02:00:00.000Z",
  rateSetByMemberId: "admin-1",
};

function makeFetch(initial: RateBody, onPut?: (body: unknown) => Response | Promise<Response>) {
  let current = initial;
  return vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      if (onPut) return onPut(body);
      current = {
        ...SET_AUD,
        clubUnitsPerNzd: body.clubUnitsPerNzd,
        clubUnitsPerNzdMicros: Math.round(Number(body.clubUnitsPerNzd) * 1_000_000),
      };
      return { ok: true, status: 200, json: async () => current } as Response;
    }
    return { ok: true, status: 200, json: async () => current } as Response;
  });
}

beforeEach(() => {
  mocks.canEdit = true;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("what the card says", () => {
  it("tells an NZD club that nothing converts, and renders no editor", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetch({ ...UNSET_AUD, clubCurrency: "NZD", isNzd: true }),
    );
    render(<AiSpendCurrencyCard />);
    expect(await screen.findByTestId("spend-currency-nzd")).toBeTruthy();
    expect(screen.queryByTestId("spend-currency-edit")).toBeNull();
    expect(screen.queryByTestId("spend-currency-input")).toBeNull();
  });

  it("says the rate is NOT SET rather than showing 1.00 as if someone chose it", async () => {
    vi.stubGlobal("fetch", makeFetch(UNSET_AUD));
    render(<AiSpendCurrencyCard />);
    const rate = await screen.findByTestId("spend-currency-rate");
    expect(rate.textContent).toContain("Not set");
    expect(rate.textContent).toContain("1 NZD = 1 AUD");
    expect(screen.queryByTestId("spend-currency-set-at")).toBeNull();
    expect(screen.getByTestId("spend-currency-edit").textContent).toBe("Set rate");
  });

  it("shows the stored rate with the club currency and when it was set", async () => {
    vi.stubGlobal("fetch", makeFetch(SET_AUD));
    render(<AiSpendCurrencyCard />);
    const rate = await screen.findByTestId("spend-currency-rate");
    expect(rate.textContent).toContain("1 NZD = 0.92 AUD");
    expect(screen.getByTestId("spend-currency-set-at").textContent).toMatch(/2026/);
    expect(screen.getByTestId("spend-currency-edit").textContent).toBe("Change rate");
  });

  it("states honestly when the setting is not shown to this role", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) }),
    );
    render(<AiSpendCurrencyCard />);
    expect(await screen.findByTestId("spend-currency-denied")).toBeTruthy();
  });
});

describe("the staged edit", () => {
  it("opens the editor seeded with the current rate, saves the typed decimal, and re-reads", async () => {
    const fetchMock = makeFetch(SET_AUD);
    vi.stubGlobal("fetch", fetchMock);
    render(<AiSpendCurrencyCard />);
    fireEvent.click(await screen.findByTestId("spend-currency-edit"));

    const input = screen.getByTestId("spend-currency-input") as HTMLInputElement;
    expect(input.value).toBe("0.92");
    // Pristine: Save is dirty-gated.
    expect((screen.getByTestId("spend-currency-save") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: "0.95" } });
    expect((screen.getByTestId("spend-currency-save") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId("spend-currency-save"));

    await waitFor(() => expect(screen.getByTestId("spend-currency-saved")).toBeTruthy());
    const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === "PUT");
    expect(put).toBeTruthy();
    expect(JSON.parse(String((put![1] as RequestInit).body))).toEqual({
      clubUnitsPerNzd: "0.95",
    });
    // The card shows the server's echo, and the editor is closed again.
    expect(screen.getByTestId("spend-currency-rate").textContent).toContain("0.95");
    expect(screen.queryByTestId("spend-currency-input")).toBeNull();
  });

  it("keeps Save disabled for a value the parser refuses, and Cancel reverts", async () => {
    vi.stubGlobal("fetch", makeFetch(SET_AUD));
    render(<AiSpendCurrencyCard />);
    fireEvent.click(await screen.findByTestId("spend-currency-edit"));
    const input = screen.getByTestId("spend-currency-input") as HTMLInputElement;
    for (const bad of ["0", "-1", "$0.92", "0.9200001"]) {
      fireEvent.change(input, { target: { value: bad } });
      expect((screen.getByTestId("spend-currency-save") as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.click(screen.getByTestId("spend-currency-cancel"));
    expect(screen.queryByTestId("spend-currency-input")).toBeNull();
    expect(screen.getByTestId("spend-currency-rate").textContent).toContain("0.92");
  });

  it("surfaces the server's refusal instead of swallowing it", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetch(UNSET_AUD, () =>
        Promise.resolve({
          ok: false,
          status: 400,
          json: async () => ({ error: "Refused by the server." }),
        } as Response),
      ),
    );
    render(<AiSpendCurrencyCard />);
    fireEvent.click(await screen.findByTestId("spend-currency-edit"));
    fireEvent.change(screen.getByTestId("spend-currency-input"), {
      target: { value: "0.5" },
    });
    fireEvent.click(screen.getByTestId("spend-currency-save"));
    expect((await screen.findByTestId("spend-currency-error")).textContent).toBe(
      "Refused by the server.",
    );
  });
});

describe("view-only access", () => {
  it("heads the section with the banner and disables the edit affordance", async () => {
    mocks.canEdit = false;
    vi.stubGlobal("fetch", makeFetch(SET_AUD));
    render(<AiSpendCurrencyCard />);
    const edit = (await screen.findByTestId("spend-currency-edit")) as HTMLButtonElement;
    expect(edit.disabled).toBe(true);
    expect(screen.getByTestId("admin-view-only-banner").textContent).toContain(
      "view-only access",
    );
  });

  it("renders the banner's live region from first paint, before the read settles", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(<AiSpendCurrencyCard />);
    expect(screen.getByTestId("spend-currency-loading")).toBeTruthy();
    expect(screen.getByTestId("admin-view-only-banner")).toBeTruthy();
  });
});
