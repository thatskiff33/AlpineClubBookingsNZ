// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SetupPageClient } from "@/app/(admin)/admin/setup/setup-page-client";
import { emptyAdminPermissionMatrix } from "@/lib/admin-permissions";
import type { FeatureFlags } from "@/config/schema";
import {
  expectRecoveryAlertToHoldFocus,
  installScrollIntoViewSpy,
  removeScrollIntoViewSpy,
} from "./helpers/focus";

const setup = {
  readiness: {
    status: "warning",
    summary: { total: 1, complete: 0, warning: 1, blocked: 0, skipped: 0 },
    categories: [
      {
        id: "providers",
        title: "Providers",
        description: "Provider readiness",
        status: "warning",
        checks: [
          {
            id: "smtp",
            title: "Email",
            description: "Email readiness",
            status: "warning",
            required: false,
            message: "Check email",
            details: [],
            progress: "completed",
            action: {
              type: "provider-test",
              provider: "smtp",
              label: "Test email",
            },
          },
        ],
      },
    ],
  },
  progress: {
    completedAt: null,
    completedStepIds: [],
    skippedStepIds: [],
    completedByMemberId: null,
  },
};
const response = (body: unknown, ok = true) => ({ ok, json: async () => body });
const fetchMock = vi.fn();
let scroll: ReturnType<typeof installScrollIntoViewSpy>;
function mount() {
  return render(
    <SetupPageClient
      permissionMatrix={{ ...emptyAdminPermissionMatrix(), support: "edit" }}
      features={{} as FeatureFlags}
    />,
  );
}
beforeEach(() => {
  scroll = installScrollIntoViewSpy();
  fetchMock.mockReset().mockResolvedValue(response(setup));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  removeScrollIntoViewSpy();
  vi.unstubAllGlobals();
});

describe("Setup action attention", () => {
  it.each([
    "Test email",
    "Acknowledge",
    "Skip",
    "Reopen",
    "Mark Setup Complete",
  ])("focuses and reveals a failed %s", async (name) => {
    if (name === "Acknowledge") {
      fetchMock.mockResolvedValue(
        response({
          ...setup,
          readiness: {
            ...setup.readiness,
            categories: [
              {
                ...setup.readiness.categories[0],
                checks: [
                  {
                    ...setup.readiness.categories[0]!.checks[0],
                    progress: "open",
                  },
                ],
              },
            ],
          },
        }),
      );
    }
    mount();
    const button = await screen.findByRole("button", { name });
    const alert = document.getElementById("setup-error");
    expect(alert).toBeEmptyDOMElement();
    expect(alert).toHaveAttribute("role", "alert");
    expect(scroll).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(
      response({ error: "Action failed" }, false),
    );
    fireEvent.click(button);
    await expectRecoveryAlertToHoldFocus(alert);
    expect(alert).toHaveTextContent("Action failed");
    expect(scroll.mock.instances).toContain(alert);
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("focuses a provider failure returned in a successful HTTP response", async () => {
    mount();
    const button = await screen.findByRole("button", { name: "Test email" });
    fetchMock.mockResolvedValueOnce(
      response({ ok: false, provider: "smtp", message: "Email failed" }),
    );
    fireEvent.click(button);
    await expectRecoveryAlertToHoldFocus(
      document.getElementById("setup-error"),
    );
    expect(document.getElementById("setup-error")).toHaveTextContent(
      "Email failed",
    );
  });

  it("announces and positions an explicit finish, but does not position on a passive refresh", async () => {
    const scrollTo = vi.fn();
    const { container } = render(
      <div style={{ overflowY: "auto" }}>
        <SetupPageClient
          permissionMatrix={{
            ...emptyAdminPermissionMatrix(),
            support: "edit",
          }}
          features={{} as FeatureFlags}
        />
      </div>,
    );
    Object.assign(container.firstElementChild!, { scrollTo });
    const finish = await screen.findByRole("button", {
      name: "Mark Setup Complete",
    });
    const status = screen.getByRole("status");
    expect(status).toBeEmptyDOMElement();
    fetchMock
      .mockResolvedValueOnce(response({}))
      .mockResolvedValue(
        response({
          ...setup,
          progress: {
            ...setup.progress,
            completedAt: "2026-07-01T00:00:00.000Z",
          },
        }),
      );
    fireEvent.click(finish);
    await waitFor(() =>
      expect(status).toHaveTextContent("Setup has been marked complete."),
    );
    await waitFor(() => expect(scrollTo).toHaveBeenCalledTimes(1));
    const refresh = screen.getByRole("button", { name: "Refresh" });
    refresh.focus();
    fireEvent.click(refresh);
    await waitFor(() => expect(refresh).toBeEnabled());
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(refresh);
  });

  it("drops the finish notice when a refresh finds setup reopened", async () => {
    mount();
    const finish = await screen.findByRole("button", {
      name: "Mark Setup Complete",
    });
    const completed = response({
      ...setup,
      progress: { ...setup.progress, completedAt: "2026-07-01T00:00:00.000Z" },
    });
    fetchMock.mockResolvedValueOnce(response({})).mockResolvedValueOnce(completed);
    fireEvent.click(finish);
    const status = screen.getByRole("status");
    await waitFor(() =>
      expect(status).toHaveTextContent("Setup has been marked complete."),
    );
    // Another admin reopened setup; this page's Refresh reloads it.
    fetchMock.mockResolvedValue(response(setup));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(status).toBeEmptyDOMElement());
    expect(
      screen.queryByText("Setup has been marked complete."),
    ).not.toBeInTheDocument();
  });

  it("shows saved completion as a banner without announcing it on load", async () => {
    fetchMock.mockResolvedValue(
      response({
        ...setup,
        progress: {
          ...setup.progress,
          completedAt: "2026-07-01T00:00:00.000Z",
        },
      }),
    );
    mount();
    await screen.findByText("Setup has been marked complete.");
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(scroll).not.toHaveBeenCalled();
  });

  it("announces a passive load failure without taking focus", async () => {
    fetchMock.mockResolvedValue(
      response({ error: "Readiness unavailable" }, false),
    );
    mount();
    await screen.findByText("Readiness unavailable");
    expect(scroll).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });
});
