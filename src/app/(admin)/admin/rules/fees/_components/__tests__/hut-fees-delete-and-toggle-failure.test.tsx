// @vitest-environment jsdom

// #4976: Hut Fees' season delete and active toggle used to parse a refusal as
// JSON unguarded, so an HTML error page from the proxy in front of the app
// reached the officer as "Unexpected token < in JSON". They also recorded the
// failure with a bare `setError`, so pressing Delete again on the same refusal
// left the unchanged message where it was, possibly off-screen. Both now read
// the body through the shared error-message helper and report through
// `raiseError`, the section's re-announcing path that Save already used. A
// request that never arrives shows the section's own sentence, not the browser's.

import "@testing-library/jest-dom/vitest";
import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectRecoveryAlertToHoldFocus,
  installScrollIntoViewSpy,
  removeScrollIntoViewSpy,
} from "@/lib/__tests__/helpers/focus";

vi.mock("@/components/lodge-select", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/components/lodge-select");
  return {
    ...actual,
    initialLodgeIdFromLocation: () => null,
    useLodgeOptions: () => ({
      lodges: [{ id: "lodge-a", name: "Lodge A" }],
      loading: false,
      failed: false,
      forbidden: false,
      reload: vi.fn(),
    }),
    LodgeSelect: ({
      lodges,
      value,
      onChange,
    }: {
      lodges: ReadonlyArray<{ id: string; name: string }>;
      value: string | null;
      onChange: (value: string | null) => void;
    }) => {
      useEffect(() => {
        if (!value && lodges[0]) onChange(lodges[0].id);
      }, [lodges, onChange, value]);
      return <div data-testid="lodge-select" />;
    },
  };
});

import { ClubFormatProvider } from "@/components/club-format-provider";
import { ClubTimeProvider } from "@/components/club-time-provider";
import { CLUB_CURRENCY_FALLBACK, CLUB_LOCALE_FALLBACK } from "@/lib/club-format";
import { HutFeesSection } from "../hut-fees-section";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

const WINTER = {
  id: "season-1",
  name: "Winter 2026",
  type: "WINTER",
  startDate: "2026-06-01T00:00:00.000Z",
  endDate: "2026-09-30T00:00:00.000Z",
  active: true,
  flatWholeLodgeNightCents: null,
  membershipTypeRates: [],
};

const HTML_502 = () =>
  new Response("<html>Bad gateway</html>", {
    status: 502,
    headers: { "content-type": "text/html" },
  });

let mutationResponse: () => Response;
let seasonFetches = 0;

beforeEach(() => {
  seasonFetches = 0;
  installScrollIntoViewSpy();
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "DELETE" || init?.method === "PUT") return mutationResponse();
      if (url.startsWith("/api/admin/age-tier-settings")) return Response.json({ settings: [] });
      if (url.startsWith("/api/admin/membership-types")) {
        return Response.json({ membershipTypes: [] });
      }
      if (url.startsWith("/api/admin/seasons")) {
        seasonFetches += 1;
        return Response.json([WINTER]);
      }
      throw new Error(`unexpected request: ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  removeScrollIntoViewSpy();
  vi.unstubAllGlobals();
});

function renderSection() {
  return render(
    <ClubFormatProvider currencyCode={CLUB_CURRENCY_FALLBACK} locale={CLUB_LOCALE_FALLBACK}>
      <ClubTimeProvider zone="Pacific/Auckland" locale={CLUB_FORMAT_TEST.locale}>
        <HutFeesSection canEdit={true} />
      </ClubTimeProvider>
    </ClubFormatProvider>,
  );
}

function errorBox() {
  return document.getElementById("hut-fees-error");
}

describe("Hut Fees: a refused delete or toggle is readable (#4976)", () => {
  it("shows the server's sentence for a 404 delete", async () => {
    mutationResponse = () => Response.json({ error: "Season not found" }, { status: 404 });
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Delete Winter 2026" }));

    await waitFor(() => expect(errorBox()).toHaveTextContent("Season not found"));
  });

  it("shows the fallback, not a parse error, for an HTML delete refusal", async () => {
    mutationResponse = HTML_502;
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Delete Winter 2026" }));

    await waitFor(() => expect(errorBox()).toHaveTextContent("Failed to delete"));
    expect(errorBox()).not.toHaveTextContent(/JSON/);
  });

  it("shows the fallback, not a parse error, for an HTML toggle refusal", async () => {
    mutationResponse = HTML_502;
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Deactivate Winter 2026" }));

    await waitFor(() => expect(errorBox()).toHaveTextContent("Failed to update"));
    expect(errorBox()).not.toHaveTextContent(/JSON/);
  });

  it.each([
    ["delete", "Delete Winter 2026", "Failed to delete"],
    ["toggle", "Deactivate Winter 2026", "Failed to update"],
  ])(
    "shows the fallback, not the browser's wording, when the %s request never arrives",
    async (_action, button, fallback) => {
      mutationResponse = () => {
        throw new TypeError("Failed to fetch");
      };
      renderSection();
      fireEvent.click(await screen.findByRole("button", { name: button }));

      await waitFor(() => expect(errorBox()).toHaveTextContent(fallback));
      expect(errorBox()).not.toHaveTextContent(/fetch/i);
    },
  );

  it("takes the officer back to the same refusal when Delete is pressed again", async () => {
    mutationResponse = () => Response.json({ error: "Season not found" }, { status: 404 });
    renderSection();
    const remove = await screen.findByRole("button", { name: "Delete Winter 2026" });
    fireEvent.click(remove);
    await waitFor(() => expect(errorBox()).toHaveTextContent("Season not found"));
    await expectRecoveryAlertToHoldFocus(errorBox());

    act(() => remove.focus());
    fireEvent.click(remove);

    await expectRecoveryAlertToHoldFocus(errorBox());
  });

  it("clears an earlier refusal when the next attempt succeeds", async () => {
    mutationResponse = () => Response.json({ error: "Season not found" }, { status: 404 });
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Delete Winter 2026" }));
    await waitFor(() => expect(errorBox()).toHaveTextContent("Season not found"));

    mutationResponse = () => Response.json({ success: true });
    fireEvent.click(screen.getByRole("button", { name: "Deactivate Winter 2026" }));

    await waitFor(() => expect(seasonFetches).toBe(2));
    expect(errorBox()).not.toHaveTextContent("Season not found");
  });

  it("refreshes the seasons after a successful delete", async () => {
    mutationResponse = () => Response.json({ success: true });
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Delete Winter 2026" }));

    await waitFor(() => expect(seasonFetches).toBe(2));
    expect(errorBox()).toHaveTextContent("");
  });
});
