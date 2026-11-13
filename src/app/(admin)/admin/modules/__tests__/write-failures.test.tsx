// @vitest-environment jsdom

/**
 * A refused modules load or save says why (#4976, ALP-589).
 *
 * Both parsed every reply as JSON and showed `err.message`, so an HTML 502
 * from the proxy read as a JSON parse error and a dropped connection as
 * "Failed to fetch". Both now parse with a catch and throw an
 * `ApiRefusalError`; a 403 keeps the shared forbidden-save reason.
 */

import { cleanup, fireEvent, render, screen } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { itShowsEveryRefusal } from "@/lib/__tests__/support/failed-write-cases";
import { ADMIN_FORBIDDEN_SAVE_REASON } from "@/components/admin/view-only-action";
import { MODULE_KEYS, type ModuleSettingsValues } from "@/config/modules";

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

const settings = Object.fromEntries(MODULE_KEYS.map((key) => [key, true])) as ModuleSettingsValues;
const key = MODULE_KEYS[0];

const payload = {
  settings,
  modules: [
    {
      key,
      label: "First module",
      description: "The module these cases toggle.",
      adminEnabled: true,
      effectiveEnabled: true,
      readiness: { status: "ready", message: "First module is enabled.", dependencies: [] },
    },
  ],
  updatedAt: null,
  updatedByMemberId: null,
};

type Answer = () => Response | Promise<Response>;

function installFetch({ load, save }: { load?: Answer; save?: Answer }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return (save ?? (() => Response.json({ ...payload, settings: { ...settings, [key]: false } })))();
      }
      return (load ?? (() => Response.json(payload)))();
    }),
  );
}

async function turnTheModuleOffAndSave() {
  render(<AdminModulesPage />);
  fireEvent.click(await screen.findByRole("checkbox", { name: "First module" }));
  fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
}

describe("modules page refusals", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    cleanup();
  });

  describe("loading the modules", () => {
    itShowsEveryRefusal({
      fallback: "Failed to load modules",
      submit: async (answer) => {
        installFetch({ load: answer });
        render(<AdminModulesPage />);
      },
    });
  });

  describe("saving the modules", () => {
    itShowsEveryRefusal({
      fallback: "Failed to save modules",
      submit: async (answer) => {
        installFetch({ save: answer });
        await turnTheModuleOffAndSave();
      },
    });

    it("keeps the forbidden-save reason for a 403", async () => {
      installFetch({ save: () => Response.json({ error: "Forbidden" }, { status: 403 }) });
      await turnTheModuleOffAndSave();

      expect(await screen.findByText(ADMIN_FORBIDDEN_SAVE_REASON)).toBeInTheDocument();
    });

    it("says so after a successful save", async () => {
      installFetch({});
      await turnTheModuleOffAndSave();

      expect(await screen.findByText("Module settings saved.")).toBeInTheDocument();
    });
  });
});
