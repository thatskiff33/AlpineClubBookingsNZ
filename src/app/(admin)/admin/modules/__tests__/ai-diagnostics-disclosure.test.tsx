// @vitest-environment jsdom

/**
 * The Modules page states where AI Diagnostics sends data before it can be
 * switched on, and asks for a tick that the save carries to the route (#5243).
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODULE_SETTINGS, type ModuleSettingsValues } from "@/config/modules";
import {
  AI_DIAGNOSTICS_DISCLOSURE,
  AI_DIAGNOSTICS_DISCLOSURE_VERSION,
} from "@/lib/ai-diagnostics-disclosure";

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    status: "authenticated",
    data: {
      user: {
        id: "admin-1",
        adminPermissionMatrix: {
          overview: "edit",
          bookings: "edit",
          membership: "edit",
          finance: "edit",
          lodge: "edit",
          content: "edit",
          support: "edit",
        },
      },
    },
  }),
}));

import AdminModulesPage from "../page";

function payloadFor(settings: ModuleSettingsValues) {
  const moduleStatus = (key: "aiDiagnostics" | "magicLink", label: string) => ({
    key,
    label,
    description: `${label} description.`,
    adminEnabled: settings[key],
    effectiveEnabled: settings[key],
    readiness: { status: "ready", message: `${label} state.`, dependencies: [] },
  });
  return {
    settings,
    modules: [moduleStatus("aiDiagnostics", "AI Diagnostics"), moduleStatus("magicLink", "Magic link")],
    updatedAt: null,
    updatedByMemberId: null,
  };
}

let putBodies: unknown[] = [];

function installFetch(initial: ModuleSettingsValues) {
  putBodies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { settings: ModuleSettingsValues };
        putBodies.push(body);
        return Response.json(payloadFor(body.settings));
      }
      return Response.json(payloadFor(initial));
    }),
  );
}

const saveButton = () => screen.getByRole("button", { name: /^Save$/ });
const acknowledgement = () =>
  screen.queryByRole("checkbox", { name: AI_DIAGNOSTICS_DISCLOSURE.acknowledgementLabel });

describe("Modules page — AI Diagnostics disclosure", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    mocks.refresh.mockReset();
  });
  afterEach(() => cleanup());

  it("states the provider, the place and the data before Diagnostics is switched on", async () => {
    installFetch({ ...DEFAULT_MODULE_SETTINGS });
    render(<AdminModulesPage />);
    const statement = await screen.findByTestId("ai-diagnostics-disclosure");
    expect(statement.textContent).toContain("Anthropic");
    expect(statement.textContent).toContain("outside New Zealand");
    expect(statement.textContent).toContain("personal details");
    expect(statement.textContent).toContain("no instruction about how long to keep");
    // Nothing to acknowledge until the administrator ticks the module.
    expect(acknowledgement()).toBeNull();
  });

  it("keeps Save disabled until the statement is ticked, then sends the version", async () => {
    installFetch({ ...DEFAULT_MODULE_SETTINGS });
    render(<AdminModulesPage />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "AI Diagnostics" }));

    expect(saveButton()).toBeDisabled();
    const hint = screen.getByText(AI_DIAGNOSTICS_DISCLOSURE.acknowledgementRequired);
    // The disabled Save names the hint that says why, for screen-reader users.
    expect(hint.id).not.toBe("");
    expect(saveButton().getAttribute("aria-describedby")?.split(" ")).toContain(hint.id);
    expect(saveButton()).toHaveAccessibleDescription(AI_DIAGNOSTICS_DISCLOSURE.acknowledgementRequired);

    fireEvent.click(acknowledgement()!);
    expect(saveButton()).toBeEnabled();
    expect(saveButton()).not.toHaveAttribute("aria-describedby");
    fireEvent.click(saveButton());

    await screen.findByText("Module settings saved.");
    expect(putBodies).toEqual([
      {
        settings: { ...DEFAULT_MODULE_SETTINGS, aiDiagnostics: true },
        aiDiagnosticsDisclosureAcknowledgedVersion: AI_DIAGNOSTICS_DISCLOSURE_VERSION,
      },
    ]);
    // Once on, there is nothing left to acknowledge.
    await waitFor(() => expect(acknowledgement()).toBeNull());
  });

  it("clears the tick when Diagnostics is unticked again", async () => {
    installFetch({ ...DEFAULT_MODULE_SETTINGS });
    render(<AdminModulesPage />);
    const moduleBox = await screen.findByRole("checkbox", { name: "AI Diagnostics" });
    fireEvent.click(moduleBox);
    fireEvent.click(acknowledgement()!);
    fireEvent.click(moduleBox);
    fireEvent.click(moduleBox);

    expect(acknowledgement()).not.toBeChecked();
    expect(saveButton()).toBeDisabled();
  });

  it("asks for nothing when Diagnostics is already on, and sends no version", async () => {
    installFetch({ ...DEFAULT_MODULE_SETTINGS, aiDiagnostics: true });
    render(<AdminModulesPage />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Magic link" }));

    expect(screen.getByTestId("ai-diagnostics-disclosure")).toBeInTheDocument();
    expect(acknowledgement()).toBeNull();
    fireEvent.click(saveButton());

    await screen.findByText("Module settings saved.");
    expect(putBodies).toEqual([
      { settings: { ...DEFAULT_MODULE_SETTINGS, aiDiagnostics: true, magicLink: !DEFAULT_MODULE_SETTINGS.magicLink } },
    ]);
  });
});
