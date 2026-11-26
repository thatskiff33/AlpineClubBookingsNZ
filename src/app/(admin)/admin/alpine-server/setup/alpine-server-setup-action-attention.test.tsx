// @vitest-environment jsdom

/*
  #5257 — the Alpine Central Server setup page's own buttons (Save, Save key,
  Enable or Disable, Upload, Download): a failure takes focus in the page's
  alert, and takes it AGAIN when it repeats word for word (#4975). The route's
  own sentence is shown when it sends one; an error page or a dropped
  connection shows the page's own sentence. Successes and notices (another
  sync running) stay in the passive status line and move nothing.
*/

import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus";
import { itShowsEveryRefusal } from "@/lib/__tests__/support/failed-write-cases";
import {
  OTHER_LODGES_SYNC_RUNNING_CODE,
  SERVERNZ_ADDRESS_CHANGED_CODE,
  SERVER_VERSION_MISMATCH_CODE,
} from "@/lib/servernz-api-version";

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    status: "authenticated",
    data: { user: { id: "admin-1", accessRoles: ["ADMIN"] } },
  }),
}));
vi.mock("@/components/club-time-provider", () => ({
  useClubTime: () => ({ instantDateTime: () => "a date" }),
}));
// Partial: `ViewOnlyActionButton` reads the reason constants from the same
// module, so only the hook is replaced.
vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => true,
}));

import { AlpineServerSetup } from "./alpine-server-setup";

const ALERT_ID = "alpine-server-action-error";
const VERSION_MATCH = {
  status: "match",
  serverVersion: "2.6",
  expected: "2.6",
  checkedAt: null,
  couldNotCheck: false,
  missingBaseUrl: false,
};

function initial(otherLodgesEnabled = true) {
  return {
    apiKeySet: true,
    apiKeyUpdatedAt: null,
    baseUrl: "https://central.test",
    otherLodgesEnabled,
    otherLodgesLastUploadAt: null,
    otherLodgesLastDownloadAt: null,
    serverVersion: "2.6",
    serverVersionCheckedAt: null,
  };
}

/** The version check on entry matches; every write gets `answer`. */
function answerWrites(answer: () => Response | Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      String(url).includes("/alpine-server/version") ? Response.json(VERSION_MATCH) : answer(),
    ),
  );
}

function alert() {
  return document.getElementById(ALERT_ID);
}

/**
 * Counts every time the alert receives focus. A disabled-while-busy button can
 * lose focus to `<body>` on its own, so "focus stayed on the button" is not the
 * contract; "the alert never took it" is.
 */
function watchAlertFocus() {
  const seen = { count: 0 };
  alert()?.addEventListener("focus", () => {
    seen.count += 1;
  });
  return seen;
}

const ACTIONS = [
  { name: "Save", fallback: "Failed to save base URL", enabled: true },
  { name: "Save key", fallback: "Failed to save API key", enabled: true },
  { name: "Disable", fallback: "Failed to update", enabled: true },
  { name: "Enable", fallback: "Failed to update", enabled: false },
  { name: "Upload", fallback: "Failed to upload", enabled: true },
  { name: "Download", fallback: "Failed to download", enabled: true },
];

/** Press the action's button; Save key needs a key typed first. */
function press(name: string) {
  if (name === "Save key") {
    fireEvent.change(screen.getByLabelText(/API key/i), { target: { value: "acs_x" } });
  }
  const button = screen.getByRole("button", { name });
  button.focus();
  fireEvent.click(button);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each(ACTIONS)("a failed $name", ({ name, fallback, enabled }) => {
  it("takes focus, and takes it again when it repeats word for word", async () => {
    answerWrites(() => Response.json({ error: "The central server said no." }, { status: 502 }));
    render(<AlpineServerSetup initialState={initial(enabled)} />);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      press(name);
      await waitFor(() => expect(alert()).toHaveTextContent("The central server said no."));
      await expectRecoveryAlertToHoldFocus(alert());
      await waitFor(() => expect(screen.getByRole("button", { name })).toBeEnabled());
    }
  });

  itShowsEveryRefusal({
    fallback,
    submit: async (answer) => {
      answerWrites(answer);
      render(<AlpineServerSetup initialState={initial(enabled)} />);
      press(name);
    },
  });
});

describe("the page's own worded refusals take focus too", () => {
  it("a key save refused because the address changed", async () => {
    answerWrites(() => Response.json({ code: SERVERNZ_ADDRESS_CHANGED_CODE }, { status: 409 }));
    render(<AlpineServerSetup initialState={initial()} />);
    press("Save key");
    await waitFor(() => expect(alert()).toHaveTextContent(/address was changed after this page was loaded/i));
    await expectRecoveryAlertToHoldFocus(alert());
  });

  it("a Download paused for a different server version", async () => {
    answerWrites(() =>
      Response.json(
        { error: "version", code: SERVER_VERSION_MISMATCH_CODE, serverVersion: "2.7" },
        { status: 409 },
      ),
    );
    render(<AlpineServerSetup initialState={initial()} />);
    press("Download");
    await waitFor(() => expect(alert()).toHaveTextContent(/^Download paused: the server is on a different software version/));
    await expectRecoveryAlertToHoldFocus(alert());
    expect(screen.getByTestId("server-version-actual").textContent).toBe("2.7");
  });
});

describe("a success reply that is not JSON is a failure, not a blank save", () => {
  const notJson = () => new Response("<html>OK</html>", { status: 200, headers: { "content-type": "text/html" } });

  it("Save keeps the address and says it failed", async () => {
    answerWrites(notJson);
    render(<AlpineServerSetup initialState={initial()} />);
    press("Save");
    await waitFor(() => expect(alert()).toHaveTextContent("Failed to save base URL"));
    expect(screen.getByLabelText("Server base URL")).toHaveValue("https://central.test");
    expect(screen.queryByText("Base URL saved.")).toBeNull();
  });

  it("Disable keeps sharing on and says it failed", async () => {
    answerWrites(notJson);
    render(<AlpineServerSetup initialState={initial()} />);
    press("Disable");
    await waitFor(() => expect(alert()).toHaveTextContent("Failed to update"));
    expect(screen.getByRole("button", { name: "Disable" })).toBeInTheDocument();
  });

  it("Upload says it failed rather than counting nothing", async () => {
    answerWrites(notJson);
    render(<AlpineServerSetup initialState={initial()} />);
    press("Upload");
    await waitFor(() => expect(alert()).toHaveTextContent("Failed to upload"));
    expect(screen.queryByText(/^Uploaded/)).toBeNull();
  });
});

describe("successes and notices stay passive", () => {
  it("a successful Save does not move focus to the alert, which stays empty", async () => {
    answerWrites(() => Response.json({ baseUrl: "https://central.test" }));
    render(<AlpineServerSetup initialState={initial()} />);
    const focused = watchAlertFocus();
    const save = screen.getByRole("button", { name: "Save" });
    press("Save");
    expect(await screen.findByText("Base URL saved.")).toHaveAttribute("role", "status");
    await waitFor(() => expect(save).toBeEnabled());
    expect(alert()).toHaveTextContent("");
    expect(focused.count).toBe(0);
  });

  it("a success after a failure empties the alert", async () => {
    let fail = true;
    answerWrites(() =>
      fail
        ? Response.json({ error: "The central server said no." }, { status: 502 })
        : Response.json({ baseUrl: "https://central.test" }),
    );
    render(<AlpineServerSetup initialState={initial()} />);
    press("Save");
    await waitFor(() => expect(alert()).toHaveTextContent("The central server said no."));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
    fail = false;
    press("Save");
    await screen.findByText("Base URL saved.");
    expect(alert()).toHaveTextContent("");
  });

  it("another sync running is a notice in the status line, not a failure", async () => {
    answerWrites(() =>
      Response.json({ error: "Another sync is running.", code: OTHER_LODGES_SYNC_RUNNING_CODE }, { status: 409 }),
    );
    render(<AlpineServerSetup initialState={initial()} />);
    const focused = watchAlertFocus();
    const upload = screen.getByRole("button", { name: "Upload" });
    press("Upload");
    expect(await screen.findByText("Another sync is running.")).toHaveAttribute("role", "status");
    await waitFor(() => expect(upload).toBeEnabled());
    expect(alert()).toHaveTextContent("");
    expect(focused.count).toBe(0);
  });
});
