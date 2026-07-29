// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WizardStepHelpers } from "@/components/admin/integration-wizard";
import type { DisplayWizardContext } from "../display-wizard-state";
import {
  BoardStep,
  BoardsStep,
  ConfigStep,
  DoneStep,
  ModuleStep,
  PairStep,
  WIZARD_WAIT_POLL_BUDGET,
  WIZARD_WAIT_POLL_MS,
} from "../display-wizard-steps";

// Behaviour these renders pin down, all of it load-bearing:
//  • the module step is honest about the SUPPORT area it needs, rather than
//    offering a lodge admin a button the route would refuse;
//  • the config quick-set posts the WHOLE config object, because the route
//    replaces `displayConfig` wholesale and a partial post would silently delete
//    every key the wizard does not show;
//  • pairing binds the chosen board BEFORE arming the code, so the screen never
//    flashes the club default;
//  • the shared install-wide cursor is stated on every step.

const editAccess = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: (area: string) => editAccess.value[area],
  ADMIN_VIEW_ONLY_ACTION_REASON: "view only",
}));

function makeContext(
  overrides: Partial<DisplayWizardContext> = {},
): DisplayWizardContext {
  return {
    moduleEnabled: true,
    templates: [
      {
        id: "tpl-1",
        key: "everyday-board",
        name: "Everyday board",
        layout: { id: "lay-1", key: "everyday-board", name: "Everyday board" },
        deviceCount: 0,
      },
    ],
    devices: [],
    lodges: [{ id: "lodge-1", name: "Ruapehu Lodge" }],
    lodgeId: "lodge-1",
    lodgeConfig: {
      lodgeId: "lodge-1",
      lodgeName: "Ruapehu Lodge",
      displayConfig: { "wifi-name": "RUAPEHU-GUEST", "custom-key": "keep me" },
      unrepresentableConfigKeys: [],
      displayNotice: null,
    },
    loaded: true,
    moduleBlockedReads: false,
    ...overrides,
  };
}

function makeHelpers(
  overrides: Partial<WizardStepHelpers> = {},
): WizardStepHelpers {
  return {
    canEdit: true,
    refresh: vi.fn(),
    goNext: vi.fn(),
    isVerified: false,
    optional: false,
    acknowledged: false,
    skip: vi.fn(),
    ...overrides,
  };
}

type FetchCall = { url: string; init?: RequestInit };

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const result = handler(url, init) as
        { ok?: boolean; status?: number; body?: unknown } | undefined;
      const status = result?.status ?? 200;
      return {
        ok: result?.ok ?? (status >= 200 && status < 300),
        status,
        json: async () => result?.body ?? {},
      } as unknown as Response;
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

beforeEach(() => {
  editAccess.value = { lodge: true, support: true };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("step 1 — module check", () => {
  it("says the module is on without offering a switch", () => {
    render(<ModuleStep context={makeContext()} helpers={makeHelpers()} />);
    expect(screen.getByText(/Lobby TV display is on/i)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /turn the module on/i }),
    ).toBeNull();
  });

  it("tells a lodge-only admin who can turn it on, instead of a dead button", () => {
    editAccess.value = { lodge: true, support: false };
    render(
      <ModuleStep
        context={makeContext({ moduleEnabled: false })}
        helpers={makeHelpers()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /turn the module on/i }),
    ).toBeNull();
    expect(
      screen.getByText(/needs system-settings \(support\) edit access/i),
    ).toBeTruthy();
  });

  it("reads the whole settings object before flipping the one flag", async () => {
    const calls = mockFetch((url, init) => {
      if (url === "/api/admin/modules" && init?.method === "PUT")
        return { ok: true };
      return { ok: true, body: { lobbyDisplay: false, chores: true } };
    });
    const helpers = makeHelpers();
    render(
      <ModuleStep
        context={makeContext({ moduleEnabled: false })}
        helpers={helpers}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /turn the module on/i }),
    );

    await waitFor(() => {
      const put = calls.find((call) => call.init?.method === "PUT");
      expect(put).toBeTruthy();
      // Every other module survives the write.
      expect(JSON.parse(String(put?.init?.body))).toEqual({
        settings: { lobbyDisplay: true, chores: true },
      });
    });
    expect(helpers.refresh).toHaveBeenCalled();
  });

  it("states the install-wide cursor", () => {
    render(<ModuleStep context={makeContext()} helpers={makeHelpers()} />);
    expect(screen.getByTestId("shared-cursor-note").textContent).toMatch(
      /saved for the whole club, not for you personally/i,
    );
  });
});

describe("step 4 — lodge details quick-set", () => {
  it("posts the FULL config object so keys it does not show survive", async () => {
    const calls = mockFetch(() => ({ ok: true }));
    render(<ConfigStep context={makeContext()} helpers={makeHelpers()} />);

    fireEvent.change(screen.getByLabelText(/Wi-Fi password/i), {
      target: { value: "kea2026" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /save lodge details/i }),
    );

    await waitFor(() => {
      const put = calls.find((call) => call.init?.method === "PUT");
      expect(put?.url).toBe("/api/admin/display/lodge-config");
      expect(JSON.parse(String(put?.init?.body))).toEqual({
        lodgeId: "lodge-1",
        displayConfig: {
          "wifi-name": "RUAPEHU-GUEST",
          "custom-key": "keep me",
          "wifi-code": "kea2026",
        },
        displayNotice: null,
      });
    });
  });

  it("names the other saved keys it is leaving alone, and links to the full editor", () => {
    render(<ConfigStep context={makeContext()} helpers={makeHelpers()} />);
    expect(screen.getByText(/custom-key/)).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: /full display settings/i })
        .getAttribute("href"),
    ).toBe("/admin/lodges/lodge-1/display");
  });

  it("disables the fields for a view-only admin", () => {
    render(
      <ConfigStep
        context={makeContext()}
        helpers={makeHelpers({ canEdit: false })}
      />,
    );
    expect(
      (screen.getByLabelText(/Wi-Fi network name/i) as HTMLInputElement)
        .disabled,
    ).toBe(true);
  });
});

describe("step 5 — pair the TV", () => {
  it("creates the screen, binds the chosen board, THEN arms the code", async () => {
    const calls = mockFetch((url, init) => {
      if (url === "/api/admin/display/devices" && init?.method === "POST") {
        return { ok: true, body: { device: { id: "dev-9" } } };
      }
      return { ok: true, body: { ok: true } };
    });
    render(
      <PairStep
        context={makeContext()}
        helpers={makeHelpers()}
        chosenTemplateId="tpl-1"
        onChoose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText(/code on the tv/i), {
      target: { value: "K7DPQM" },
    });
    fireEvent.click(screen.getByRole("button", { name: /pair this screen/i }));

    await waitFor(() => {
      expect(
        calls.map((call) => `${call.init?.method ?? "GET"} ${call.url}`),
      ).toEqual([
        "POST /api/admin/display/devices",
        "PATCH /api/admin/display/devices/dev-9",
        "POST /api/admin/display/devices/dev-9/pairing",
      ]);
    });
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({
      templateId: "tpl-1",
    });
  });

  it("reuses the screen already awaiting pairing rather than creating another", async () => {
    const calls = mockFetch(() => ({ ok: true, body: { ok: true } }));
    render(
      <PairStep
        context={makeContext({
          devices: [
            {
              id: "dev-pending",
              name: "Lobby TV — Ruapehu Lodge",
              lodgeId: "lodge-1",
              lodgeName: "Ruapehu Lodge",
              templateId: null,
              templateName: null,
              paired: false,
              pairingArmedUntil: null,
              lastSeenAt: null,
              revoked: false,
            },
          ],
        })}
        helpers={makeHelpers()}
        chosenTemplateId={null}
        onChoose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText(/code on the tv/i), {
      target: { value: "ABC123" },
    });
    fireEvent.click(screen.getByRole("button", { name: /pair this screen/i }));

    await waitFor(() => {
      expect(calls.map((call) => call.url)).toEqual([
        "/api/admin/display/devices/dev-pending/pairing",
      ]);
    });
  });

  it("explains a rate-limited pairing rather than blaming the code", async () => {
    mockFetch(() => ({ ok: false, status: 429 }));
    render(
      <PairStep
        context={makeContext({
          devices: [
            {
              id: "dev-pending",
              name: "Lobby TV",
              lodgeId: "lodge-1",
              lodgeName: "Ruapehu Lodge",
              templateId: null,
              templateName: null,
              paired: false,
              pairingArmedUntil: null,
              lastSeenAt: null,
              revoked: false,
            },
          ],
        })}
        helpers={makeHelpers()}
        chosenTemplateId={null}
        onChoose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText(/code on the tv/i), {
      target: { value: "ABC123" },
    });
    fireEvent.click(screen.getByRole("button", { name: /pair this screen/i }));

    await waitFor(() => {
      expect(screen.getByText(/too many pairing attempts/i)).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// #2249 review fixes
// ---------------------------------------------------------------------------

function pendingDevice(
  overrides: Partial<DisplayWizardContext["devices"][number]> = {},
) {
  return {
    id: "dev-pending",
    name: "Lobby TV — Ruapehu Lodge",
    lodgeId: "lodge-1",
    lodgeName: "Ruapehu Lodge",
    templateId: null,
    templateName: null,
    paired: false,
    pairingArmedUntil: null,
    lastSeenAt: null,
    revoked: false,
    ...overrides,
  };
}

function liveDevice(
  overrides: Partial<DisplayWizardContext["devices"][number]> = {},
) {
  return pendingDevice({ id: "dev-live", paired: true, ...overrides });
}

describe("waiting for the screen (H1 — the wizard can finish in one sitting)", () => {
  // The pairing truth is written by the TV, not by this page: the device claims
  // its token on its own ~4s poll. Before this fix nothing re-read that, so the
  // step could never tick over without a manual reload — while the copy said it
  // would. These tests pin the re-read, not the wording.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-reads server truth while a pairing is armed, and stops once the screen is live", () => {
    const helpers = makeHelpers();
    const armed = makeContext({
      devices: [
        pendingDevice({ pairingArmedUntil: "2026-07-29T10:00:00.000Z" }),
      ],
    });
    const { rerender } = render(
      <PairStep
        context={armed}
        helpers={helpers}
        chosenTemplateId={null}
        onChoose={vi.fn()}
      />,
    );

    expect(screen.getByTestId("pairing-armed")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(WIZARD_WAIT_POLL_MS * 3);
    });
    expect(helpers.refresh).toHaveBeenCalledTimes(3);

    // The TV claims its token: the SAME mounted step now verifies, without a
    // remount, and the polling stops.
    rerender(
      <PairStep
        context={makeContext({ devices: [liveDevice()] })}
        helpers={helpers}
        chosenTemplateId={null}
        onChoose={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("pairing-armed")).toBeNull();
    expect(screen.getByText(/1 screen is paired/i)).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(WIZARD_WAIT_POLL_MS * 3);
    });
    expect(helpers.refresh).toHaveBeenCalledTimes(3);
  });

  it("clears the interval on unmount", () => {
    const helpers = makeHelpers();
    const { unmount } = render(
      <PairStep
        context={makeContext({
          devices: [
            pendingDevice({ pairingArmedUntil: "2026-07-29T10:00:00.000Z" }),
          ],
        })}
        helpers={helpers}
        chosenTemplateId={null}
        onChoose={vi.fn()}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(WIZARD_WAIT_POLL_MS);
    });
    expect(helpers.refresh).toHaveBeenCalledTimes(1);

    unmount();
    act(() => {
      vi.advanceTimersByTime(WIZARD_WAIT_POLL_MS * 5);
    });
    expect(helpers.refresh).toHaveBeenCalledTimes(1);
  });

  it("stops polling after a bounded number of attempts and offers Check again", () => {
    const helpers = makeHelpers();
    render(
      <PairStep
        context={makeContext({
          devices: [
            pendingDevice({ pairingArmedUntil: "2026-07-29T10:00:00.000Z" }),
          ],
        })}
        helpers={helpers}
        chosenTemplateId={null}
        onChoose={vi.fn()}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(
        WIZARD_WAIT_POLL_MS * (WIZARD_WAIT_POLL_BUDGET + 5),
      );
    });
    expect(helpers.refresh).toHaveBeenCalledTimes(WIZARD_WAIT_POLL_BUDGET);

    // The operator is never stranded: the explicit affordance restarts it.
    fireEvent.click(screen.getByRole("button", { name: /check again/i }));
    expect(helpers.refresh).toHaveBeenCalledTimes(WIZARD_WAIT_POLL_BUDGET + 1);
    act(() => {
      vi.advanceTimersByTime(WIZARD_WAIT_POLL_MS);
    });
    expect(helpers.refresh).toHaveBeenCalledTimes(WIZARD_WAIT_POLL_BUDGET + 2);
  });

  it("re-reads on step 6 until the screen has actually checked in", () => {
    const helpers = makeHelpers();
    const { rerender } = render(
      <DoneStep
        context={makeContext({ devices: [liveDevice()] })}
        helpers={helpers}
      />,
    );
    expect(
      screen.getByText(/paired but has not fetched anything yet/i),
    ).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(WIZARD_WAIT_POLL_MS * 2);
    });
    expect(helpers.refresh).toHaveBeenCalledTimes(2);

    rerender(
      <DoneStep
        context={makeContext({
          devices: [liveDevice({ lastSeenAt: "2026-07-29T09:41:00.000Z" })],
        })}
        helpers={helpers}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(WIZARD_WAIT_POLL_MS * 2);
    });
    expect(helpers.refresh).toHaveBeenCalledTimes(2);
  });
});

describe("step 5 — one screen record, whatever goes wrong (M1/M2)", () => {
  it("re-arms the screen it created instead of creating another on retry", async () => {
    // Every failed attempt used to POST a new device: the created id lived in a
    // per-render local and the context list had not refreshed yet.
    const calls = mockFetch((url, init) => {
      if (url === "/api/admin/display/devices" && init?.method === "POST") {
        return { ok: true, body: { device: { id: "dev-9" } } };
      }
      if (url.endsWith("/pairing")) {
        return { ok: false, status: 400, body: { error: "Bad code" } };
      }
      return { ok: true, body: {} };
    });
    render(
      <PairStep
        context={makeContext()}
        helpers={makeHelpers()}
        chosenTemplateId={null}
        onChoose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText(/code on the tv/i), {
      target: { value: "WRONG1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /pair this screen/i }));
    await waitFor(() => expect(screen.getByText(/bad code/i)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /pair this screen/i }));

    await waitFor(() => {
      expect(
        calls.filter(
          (call) =>
            call.url === "/api/admin/display/devices" &&
            call.init?.method === "POST",
        ),
      ).toHaveLength(1);
    });
    // …and the retry armed the SAME row.
    await waitFor(() => {
      expect(
        calls.filter((call) => call.url.endsWith("/dev-9/pairing")),
      ).toHaveLength(2);
    });
  });

  it("says so when the board could not be bound, instead of promising it", async () => {
    mockFetch((url, init) => {
      if (url === "/api/admin/display/devices" && init?.method === "POST") {
        return { ok: true, body: { device: { id: "dev-9" } } };
      }
      if (init?.method === "PATCH") {
        return {
          ok: false,
          status: 500,
          body: { error: "Template not found" },
        };
      }
      return { ok: true, body: {} };
    });
    render(
      <PairStep
        context={makeContext()}
        helpers={makeHelpers()}
        chosenTemplateId="tpl-1"
        onChoose={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/It will be set to show Everyday board/i),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/code on the tv/i), {
      target: { value: "K7DPQM" },
    });
    fireEvent.click(screen.getByRole("button", { name: /pair this screen/i }));

    await waitFor(() => {
      expect(screen.getByText(/Template not found/i)).toBeTruthy();
    });
    expect(
      screen.queryByText(/It will be set to show Everyday board/i),
    ).toBeNull();
  });

  it("discloses that re-using a pending screen would change its board, and offers a new one", async () => {
    const calls = mockFetch((url, init) => {
      if (url === "/api/admin/display/devices" && init?.method === "POST") {
        return { ok: true, body: { device: { id: "dev-new" } } };
      }
      return { ok: true, body: {} };
    });
    render(
      <PairStep
        context={makeContext({
          devices: [
            pendingDevice({
              templateId: "tpl-2",
              templateName: "Nights ahead",
            }),
          ],
        })}
        helpers={makeHelpers()}
        chosenTemplateId="tpl-1"
        onChoose={vi.fn()}
      />,
    );

    expect(screen.getByText(/already set to show/i).textContent).toMatch(
      /Nights ahead/,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /create a new screen instead/i }),
    );
    fireEvent.change(screen.getByLabelText(/code on the tv/i), {
      target: { value: "K7DPQM" },
    });
    fireEvent.click(screen.getByRole("button", { name: /pair this screen/i }));

    await waitFor(() => {
      expect(
        calls.map((call) => `${call.init?.method ?? "GET"} ${call.url}`),
      ).toEqual([
        "POST /api/admin/display/devices",
        "PATCH /api/admin/display/devices/dev-new",
        "POST /api/admin/display/devices/dev-new/pairing",
      ]);
    });
  });

  it("keeps re-arming the NEW screen after choosing to create one", async () => {
    // The older pending row must not quietly take the next press back: that is
    // the screen the operator explicitly chose to leave alone.
    const calls = mockFetch((url, init) => {
      if (url === "/api/admin/display/devices" && init?.method === "POST") {
        return { ok: true, body: { device: { id: "dev-new" } } };
      }
      if (url.endsWith("/pairing")) {
        return { ok: false, status: 400, body: { error: "Bad code" } };
      }
      return { ok: true, body: {} };
    });
    render(
      <PairStep
        context={makeContext({
          devices: [
            pendingDevice({
              templateId: "tpl-2",
              templateName: "Nights ahead",
            }),
          ],
        })}
        helpers={makeHelpers()}
        chosenTemplateId="tpl-1"
        onChoose={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /create a new screen instead/i }),
    );
    fireEvent.change(screen.getByLabelText(/code on the tv/i), {
      target: { value: "WRONG1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /pair this screen/i }));
    await waitFor(() => expect(screen.getByText(/bad code/i)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /pair this screen/i }));

    await waitFor(() => {
      expect(
        calls.filter((call) => call.url.endsWith("/dev-new/pairing")),
      ).toHaveLength(2);
    });
    expect(
      calls.filter((call) => call.url.includes("dev-pending")),
    ).toHaveLength(0);
  });
});

describe("step 5 — the board pick survives a resume (M3)", () => {
  it("asks for the board again when the pick was lost and nothing is bound", () => {
    const onChoose = vi.fn();
    render(
      <PairStep
        context={makeContext({
          templates: [
            makeContext().templates[0],
            {
              id: "tpl-2",
              key: "nights-ahead",
              name: "Nights ahead",
              layout: {
                id: "lay-2",
                key: "nights-ahead",
                name: "Nights ahead",
              },
              deviceCount: 0,
            },
          ],
        })}
        helpers={makeHelpers()}
        chosenTemplateId={null}
        onChoose={onChoose}
      />,
    );

    fireEvent.change(screen.getByLabelText(/board this screen will show/i), {
      target: { value: "tpl-2" },
    });
    expect(onChoose).toHaveBeenCalledWith("tpl-2");
  });

  it("seeds the pick itself when the club has exactly one board", () => {
    const onChoose = vi.fn();
    render(
      <PairStep
        context={makeContext()}
        helpers={makeHelpers()}
        chosenTemplateId={null}
        onChoose={onChoose}
      />,
    );
    expect(onChoose).toHaveBeenCalledWith("tpl-1");
  });
});

describe("an unresolved lodge blocks steps 3-6 (M4)", () => {
  const unresolved = () =>
    makeContext({
      lodgeId: null,
      lodgeConfig: null,
      devices: [liveDevice({ lodgeId: "somewhere-else" })],
    });

  it("refuses to pair against another lodge's screen", () => {
    render(
      <PairStep
        context={unresolved()}
        helpers={makeHelpers()}
        chosenTemplateId={null}
        onChoose={vi.fn()}
      />,
    );
    expect(screen.getByText(/lodges could not be read/i)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /pair this screen/i }),
    ).toBeNull();
  });

  it("blocks the board and done steps too", () => {
    render(
      <BoardStep
        context={unresolved()}
        helpers={makeHelpers()}
        chosenTemplateId={null}
        onChoose={vi.fn()}
        onSelectLodge={vi.fn()}
      />,
    );
    expect(screen.getByText(/lodges could not be read/i)).toBeTruthy();
    cleanup();

    render(<DoneStep context={unresolved()} helpers={makeHelpers()} />);
    expect(screen.getByText(/lodges could not be read/i)).toBeTruthy();
  });
});

describe("view-only pins (L2)", () => {
  it("disables the Restore action on step 2", () => {
    render(
      <BoardsStep
        context={makeContext()}
        helpers={makeHelpers({ canEdit: false })}
      />,
    );
    expect(
      (
        screen.getByRole("button", {
          name: /restore built-in boards/i,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("disables the code, the name and the Pair action on step 5", () => {
    render(
      <PairStep
        context={makeContext()}
        helpers={makeHelpers({ canEdit: false })}
        chosenTemplateId={null}
        onChoose={vi.fn()}
      />,
    );
    expect(
      (screen.getByLabelText(/code on the tv/i) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByLabelText(/name this screen/i) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: /pair this screen/i,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});

describe("honest reporting of the states the wizard cannot fix", () => {
  it("says the later steps are being REFUSED, not that they are empty (L8)", () => {
    render(
      <ModuleStep
        context={makeContext({
          moduleEnabled: false,
          moduleBlockedReads: true,
        })}
        helpers={makeHelpers()}
      />,
    );
    expect(screen.getByTestId("module-blocked-reads").textContent).toMatch(
      /refused for now, not missing/i,
    );
  });

  it("warns that a non-text saved value cannot survive the quick-set (L7)", () => {
    render(
      <ConfigStep
        context={makeContext({
          lodgeConfig: {
            lodgeId: "lodge-1",
            lodgeName: "Ruapehu Lodge",
            displayConfig: { "wifi-name": "RUAPEHU-GUEST" },
            unrepresentableConfigKeys: ["legacy-counts"],
            displayNotice: null,
          },
        })}
        helpers={makeHelpers()}
      />,
    );
    expect(screen.getByTestId("unrepresentable-config").textContent).toMatch(
      /legacy-counts/,
    );
    expect(
      screen.getByTestId("unrepresentable-config-effect").textContent,
    ).toMatch(/saving here would remove those values/i);
  });

  it("drops the lodge-settings link on step 6 rather than pointing nowhere (L6)", () => {
    render(
      <DoneStep
        context={makeContext({ lodgeConfig: null })}
        helpers={makeHelpers()}
      />,
    );
    expect(
      screen.queryByRole("link", { name: /lodge display settings/i }),
    ).toBeNull();
    // The links that do not depend on a lodge are still there.
    expect(screen.getByRole("link", { name: /^devices$/i })).toBeTruthy();
  });
});
