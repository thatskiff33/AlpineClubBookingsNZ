// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { OfficerFactorResetButton } from "../officer-factor-reset-button";

function stubReset(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

describe("officer factor reset button (#4618, #4620)", () => {
  beforeEach(() => {
    refresh.mockReset();
  });

  it("announces a refused reset as an alert, not as a status", async () => {
    stubReset(409, { error: "You cannot reset your own factors." });
    render(<OfficerFactorResetButton memberId="member-2" />);
    fireEvent.click(screen.getByRole("button", { name: "Reset two-factor" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "You cannot reset your own factors.",
      );
    });
    expect(screen.getByRole("status")).toHaveTextContent("");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("announces a completed reset politely and refreshes the page", async () => {
    stubReset(200, { ok: true });
    render(<OfficerFactorResetButton memberId="member-2" />);
    fireEvent.click(screen.getByRole("button", { name: "Reset two-factor" }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "Their authenticator and passkeys were reset",
      );
    });
    expect(screen.getByRole("alert")).toHaveTextContent("");
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
