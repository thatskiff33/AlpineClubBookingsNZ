// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConfirmItsYouHost,
  fetchWithRecentAuth,
} from "@/components/confirm-its-you";
import { recentAuthRefusalBody } from "@/lib/recent-auth-factors";

const RESTORE_BODY = JSON.stringify({ confirmation: "RESTORE" });

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function Harness() {
  const [status, setStatus] = useState("idle");
  return (
    <>
      <ConfirmItsYouHost />
      <button
        type="button"
        onClick={() => {
          void fetchWithRecentAuth("/api/admin/restore", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: RESTORE_BODY,
          }).then((response) => setStatus(String(response.status)));
        }}
      >
        Restore
      </button>
      <p data-testid="status">{status}</p>
    </>
  );
}

function protectedCalls(calls: Array<{ url: string; init?: RequestInit }>) {
  return calls.filter((call) => !call.url.includes("/api/auth/reauth"));
}

describe("confirm it's you dialog (#4616)", () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push({ url, init });
        if (url.includes("/api/auth/reauth") && init?.method !== "POST") {
          return jsonResponse({ factors: ["PASSWORD"] });
        }
        if (url.includes("/api/auth/reauth")) {
          return jsonResponse({ ok: true });
        }
        return jsonResponse(recentAuthRefusalBody(), 403);
      }),
    );
  });

  it("replays the original request once, with the same body", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    const password = await screen.findByLabelText("Password");
    fireEvent.change(password, { target: { value: "lodge-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(screen.getByTestId("status").textContent).toBe("403");
    });

    const restored = protectedCalls(calls);
    expect(restored).toHaveLength(2);
    expect(restored[0]?.init?.body).toBe(RESTORE_BODY);
    expect(restored[1]?.init?.body).toBe(RESTORE_BODY);
    expect(restored[0]?.init?.method).toBe("POST");
    expect(calls.filter((call) => call.url.includes("/api/auth/reauth"))).toHaveLength(2);
  });

  it("does not replay when the person cancels", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await screen.findByLabelText("Password");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.getByTestId("status").textContent).toBe("403");
    });
    expect(protectedCalls(calls)).toHaveLength(1);
    expect(
      calls.filter((call) => call.init?.method === "POST" && call.url.includes("/api/auth/reauth")),
    ).toHaveLength(0);
  });
});
