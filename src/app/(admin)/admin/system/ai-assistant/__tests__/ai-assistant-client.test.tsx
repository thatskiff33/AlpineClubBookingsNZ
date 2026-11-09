// @vitest-environment jsdom

import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiAssistantClient } from "../ai-assistant-client";

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { accessRoles: ["FULL_ADMIN"] } },
    status: "authenticated",
  }),
}));

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => true,
}));

vi.mock("@/lib/access-roles", () => ({
  isFullAdmin: () => true,
}));

const healthyUsage = {
  budget: { limitCents: 1000, warningThresholds: [0.7, 0.85, 0.95] },
  month: {
    month: "2026-07",
    requestCount: 12,
    failedCount: 1,
    inputTokens: 3400,
    outputTokens: 900,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    costCents: 250,
    usagePercent: 0.25,
    budgetStatus: "healthy",
  },
  recentFailures: [],
  bySurface: [{ surface: "member", count: 12, successCount: 11, failureCount: 1 }],
};

const exhaustedUsage = {
  ...healthyUsage,
  month: {
    ...healthyUsage.month,
    costCents: 1000,
    usagePercent: 1,
    budgetStatus: "exhausted",
  },
};

function makeFetch({
  settingsCents = 1000,
  usage = healthyUsage,
}: {
  settingsCents?: number;
  usage?: typeof healthyUsage;
} = {}) {
  return vi.fn(async (url: string, opts?: RequestInit) => {
    const method = opts?.method ?? "GET";
    if (url.includes("/ai-assistant/settings")) {
      if (method === "PUT") {
        const body = JSON.parse(opts!.body as string);
        return {
          ok: true,
          status: 200,
          json: async () => ({ monthlyBudgetCents: body.monthlyBudgetCents }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ monthlyBudgetCents: settingsCents }),
      } as Response;
    }
    if (url.includes("/ai-assistant/usage")) {
      return { ok: true, status: 200, json: async () => usage } as Response;
    }
    if (url.includes("/integrations/credentials")) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", makeFetch());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AiAssistantClient key card", () => {
  it("shows the not-configured status and an empty write-only field", () => {
    render(<AiAssistantClient initialKeyState="not_configured" keySetAt={null} />);
    expect(screen.getByText("Not configured")).toBeTruthy();
    const input = screen.getByLabelText(/API key/i) as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.value).toBe("");
  });

  it("shows the saved status", () => {
    render(
      <AiAssistantClient
        initialKeyState="saved"
        keySetAt={new Date().toISOString()}
      />,
    );
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("shows a re-entry alert when the key needs re-entry", () => {
    render(<AiAssistantClient initialKeyState="needs_reentry" keySetAt={null} />);
    expect(screen.getByText("Re-enter required")).toBeTruthy();
    expect(
      screen.getByText(/could not be decrypted/i),
    ).toBeTruthy();
  });

  it("posts the key without echoing it back into the field", async () => {
    const fetchMock = makeFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<AiAssistantClient initialKeyState="not_configured" keySetAt={null} />);

    const input = screen.getByLabelText(/API key/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-ant-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save API key" }));

    await waitFor(() =>
      expect(screen.getByText(/write-only and never shown/i)).toBeTruthy(),
    );
    // The field is cleared and never re-populated with the value.
    expect(input.value).toBe("");
    // The credentials POST used the anthropic provider + api_key.
    const credCall = fetchMock.mock.calls.find(([url]) =>
      (url as string).includes("/integrations/credentials"),
    );
    const body = JSON.parse((credCall![1] as RequestInit).body as string);
    expect(body).toMatchObject({ provider: "anthropic", key: "api_key" });
  });
});

describe("AiAssistantClient budget card", () => {
  it("loads the cap as dollars and saves it back as cents", async () => {
    const fetchMock = makeFetch({ settingsCents: 2500 });
    vi.stubGlobal("fetch", fetchMock);
    render(<AiAssistantClient initialKeyState="saved" keySetAt={null} />);

    const input = (await screen.findByLabelText(
      /Monthly cap/i,
    )) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("25.00"));

    fireEvent.change(input, { target: { value: "40.50" } });
    fireEvent.click(screen.getByRole("button", { name: "Save spend cap" }));

    await waitFor(() =>
      expect(screen.getByText("Monthly spend cap saved.")).toBeTruthy(),
    );
    const putCall = fetchMock.mock.calls.find(
      ([url, opts]) =>
        (url as string).includes("/ai-assistant/settings") &&
        (opts as RequestInit)?.method === "PUT",
    );
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body.monthlyBudgetCents).toBe(4050);
  });

  it("warns when the cap is $0.00 (paid answers off)", async () => {
    vi.stubGlobal("fetch", makeFetch({ settingsCents: 0 }));
    render(<AiAssistantClient initialKeyState="saved" keySetAt={null} />);
    await waitFor(() =>
      expect(
        screen.getByText(/paid AI answers are currently switched off/i),
      ).toBeTruthy(),
    );
  });

  it("rejects an out-of-bounds cap without POSTing", async () => {
    const fetchMock = makeFetch({ settingsCents: 1000 });
    vi.stubGlobal("fetch", fetchMock);
    render(<AiAssistantClient initialKeyState="saved" keySetAt={null} />);
    const input = (await screen.findByLabelText(
      /Monthly cap/i,
    )) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("10.00"));

    fireEvent.change(input, { target: { value: "5000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save spend cap" }));

    await waitFor(() =>
      expect(screen.getByText(/cannot exceed/i)).toBeTruthy(),
    );
    expect(
      fetchMock.mock.calls.some(
        ([url, opts]) =>
          (url as string).includes("/ai-assistant/settings") &&
          (opts as RequestInit)?.method === "PUT",
      ),
    ).toBe(false);
  });
});

describe("AiAssistantClient usage panel", () => {
  it("renders the month spend and healthy status", async () => {
    render(<AiAssistantClient initialKeyState="saved" keySetAt={null} />);
    await waitFor(() =>
      expect(screen.getByText("$2.50")).toBeTruthy(),
    );
    expect(screen.getByText("healthy")).toBeTruthy();
  });

  it("renders the exhausted status", async () => {
    vi.stubGlobal("fetch", makeFetch({ usage: exhaustedUsage }));
    render(<AiAssistantClient initialKeyState="saved" keySetAt={null} />);
    await waitFor(() => expect(screen.getByText("exhausted")).toBeTruthy());
  });
});
