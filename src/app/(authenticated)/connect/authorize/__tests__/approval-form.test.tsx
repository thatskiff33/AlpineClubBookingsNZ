// @vitest-environment jsdom

/**
 * The approval screen's buttons (ALP-653, `INV-MCP-002`): view only is the
 * choice already made, view and change is offered only when the screen may
 * offer it, and each button sends the member's answer with the request exactly
 * as it arrived. A refusal is shown and the buttons work again; an answer
 * sends the browser back to the app.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApprovalForm } from "@/app/(authenticated)/connect/authorize/approval-form";

const params = {
  response_type: "code",
  client_id: "client-1",
  redirect_uri: "https://claude.ai/callback",
  code_challenge: "c".repeat(43),
  code_challenge_method: "S256",
  state: "app-state",
  scope: "read write",
};

const assign = vi.fn();
const originalLocation = window.location;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // jsdom's location.assign is non-configurable: replace the whole object.
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { assign },
  });
  fetchMock = vi.fn(async () =>
    Response.json({ redirectTo: "https://claude.ai/callback?code=abc&state=app-state" }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
  vi.unstubAllGlobals();
});

function renderForm(
  overrides: { mayChange?: boolean; askedToChange?: boolean; onThisDevice?: boolean; officer?: boolean } = {},
) {
  return render(
    <ApprovalForm
      appName="Example Assistant"
      appHost="claude.ai"
      onThisDevice={overrides.onThisDevice ?? false}
      askedToChange={overrides.askedToChange ?? true}
      mayChange={overrides.mayChange ?? false}
      officer={overrides.officer ?? false}
      params={params}
    />,
  );
}

function sentBody(): Record<string, unknown> {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("/api/member/mcp-grants");
  expect(init.method).toBe("POST");
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

const allow = () => screen.getByRole("button", { name: "Allow" });
const dontAllow = () => screen.getByRole("button", { name: "Don't allow" });

describe("ApprovalForm", () => {
  it("shows where the approval is sent", () => {
    renderForm();
    expect(screen.getByTestId("mcp-app-host").textContent).toBe("claude.ai");
    cleanup();
    renderForm({ onThisDevice: true });
    expect(screen.getByTestId("mcp-app-host").textContent).toContain("this computer");
  });

  it("offers no choice when the club allows view only, and says the app asked for more", async () => {
    renderForm({ mayChange: false, askedToChange: true });
    expect(screen.queryByRole("button", { name: /view and change/i })).toBeNull();
    expect(screen.getByText(/asked to make changes too/i)).toBeTruthy();

    fireEvent.click(allow());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentBody()).toEqual({ decision: "approve", scope: "READ", officerNoticeShown: false, params });
  });

  it("sends view only unless the member picks view and change", async () => {
    renderForm({ mayChange: true });
    const viewOnly = screen.getByRole("button", { name: /view only/i });
    const viewAndChange = screen.getByRole("button", { name: /view and change/i });
    expect(viewOnly.getAttribute("aria-pressed")).toBe("true");
    expect(viewAndChange.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(allow());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentBody()).toMatchObject({ decision: "approve", scope: "READ" });
  });

  it("sends view and change once the member picks it", async () => {
    renderForm({ mayChange: true });
    fireEvent.click(screen.getByRole("button", { name: /view and change/i }));
    fireEvent.click(allow());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentBody()).toEqual({ decision: "approve", scope: "READ_WRITE", officerNoticeShown: false, params });
  });

  it("tells an officer the app can also act as an officer, and says it did", async () => {
    // Owner decision, #5305 comment 7093303964, item 1 (`INV-MCP-009`); general
    // wording so one approval covers every officer area, #5305 comment 7131483847.
    renderForm({ officer: true, mayChange: true });
    expect(screen.getByTestId("mcp-officer-notice").textContent).toBe(
      "As a club officer, the app can also see the club records your admin role gives you, such as other members' bookings and details and the club's booking settings. If you choose View and change, it can change them too, and it is told to ask you first.",
    );
    fireEvent.click(allow());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentBody()).toMatchObject({ decision: "approve", officerNoticeShown: true });
  });

  it("tells an officer on a view-only screen that the app can read, not change", () => {
    renderForm({ officer: true, mayChange: false });
    const notice = screen.getByTestId("mcp-officer-notice").textContent ?? "";
    expect(notice).toBe(
      "As a club officer, the app can also see the club records your admin role gives you, such as other members' bookings and details and the club's booking settings.",
    );
    expect(notice).not.toContain("change");
  });

  it("shows a member no officer line", () => {
    renderForm({ officer: false });
    expect(screen.queryByTestId("mcp-officer-notice")).toBeNull();
  });

  it("sends a refusal with the same request and follows the answer back to the app", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ redirectTo: "https://claude.ai/callback?error=access_denied" }),
    );
    renderForm();
    fireEvent.click(dontAllow());
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://claude.ai/callback?error=access_denied"));
    expect(sentBody()).toEqual({ decision: "deny", scope: "READ", officerNoticeShown: false, params });
  });

  it("goes to the address the server answered after an approval, and keeps both buttons off", async () => {
    renderForm();
    fireEvent.click(allow());
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("https://claude.ai/callback?code=abc&state=app-state"),
    );
    expect((allow() as HTMLButtonElement).disabled).toBe(true);
    expect((dontAllow() as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the server's reason for a refusal and lets the member answer again", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: "Verify your email address before connecting an AI app." }, { status: 403 }),
    );
    renderForm();
    fireEvent.click(allow());
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "Verify your email address before connecting an AI app.",
      ),
    );
    expect(assign).not.toHaveBeenCalled();
    expect((allow() as HTMLButtonElement).disabled).toBe(false);
    expect((dontAllow() as HTMLButtonElement).disabled).toBe(false);
  });

  it("says nothing was shared when the request never got an answer", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    renderForm();
    fireEvent.click(allow());
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Nothing was shared with the app"),
    );
    expect((allow() as HTMLButtonElement).disabled).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });
});
