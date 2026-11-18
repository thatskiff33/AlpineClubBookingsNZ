// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The page reads the session permission matrix for view-only gating; give it an
// edit-level admin so the restore control is live (the view-only path is
// covered by the shared ViewOnlyActionButton contract).
vi.mock("next-auth/react", () => ({
  useSession: () => ({
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

import AdminDisplayTemplatesPage from "./page";

// #2247. Two complaints, one screen:
//
//  1. An install whose database predates the lobby-display feature has no
//     `builtin-*` rows — nothing but the seed ever creates them, and no upgrade
//     runs the seed. The gallery was simply blank, with no cause named and no
//     way out. It must now name WHICH of the three causes applies and offer the
//     restore.
//  2. The restore is a CONVERGENT re-seed: it rewrites every built-in from
//     code. It must state that before it runs.

/**
 * Templates GET answers with `status`; everything else is benign. `status: 0`
 * means the fetch itself REJECTS, the transport failure that used to hang the
 * page on "Loading…" for ever.
 */
function installFetch(status: number, templates: unknown[] = []) {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method });
    if (url === "/api/admin/display/templates" && method === "GET") {
      if (status === 0) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify(status === 200 ? { templates } : {}), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "/api/admin/display/built-ins/restore" && method === "POST") {
      return json({ layouts: 7, templates: 7 });
    }
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Display templates — empty state names the cause (#2247)", () => {
  it("a successful but empty list is the never-seeded case, and offers the restore", async () => {
    installFetch(200, []);
    render(<AdminDisplayTemplatesPage />);

    await screen.findByText(/not even the built-in boards/i);
    expect(screen.getByText(/does not re-run the seed/i)).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Restore built-in boards" })
    ).toBeDefined();
    // It must not blame a cause that did not happen.
    expect(screen.queryByText(/switched off/i)).toBeNull();
    expect(screen.queryByText(/403/)).toBeNull();
  });

  it("a 403 is reported as a permission problem, not an empty database", async () => {
    installFetch(403);
    render(<AdminDisplayTemplatesPage />);

    await screen.findByText(/can’t see the display templates/i);
    expect(screen.getByText(/lodge view/i)).toBeDefined();
    // Honest about the inference: the browser is never told which permission.
    expect(screen.getByText(/not which permission was missing/i)).toBeDefined();
    expect(screen.queryByText(/not even the built-in boards/i)).toBeNull();
  });

  it("a 404 names BOTH causes, because the page cannot tell them apart", async () => {
    // `/api/admin/display/*` is module-gated, and a gated route answers an
    // anonymous caller with the same 404 the module gate sends, so that one
    // anonymous probe cannot read which optional modules a club runs. A 404
    // here therefore means either the module is off or the sign-in expired, and
    // the copy has to offer both rather than asserting the one it cannot check.
    installFetch(404);
    render(<AdminDisplayTemplatesPage />);

    await screen.findByText(/sign-in may have expired/i);
    expect(screen.getByText(/Admin → Setup → Modules/)).toBeDefined();
    expect(screen.getByText(/Sign in again/)).toBeDefined();
    expect(screen.queryByText(/not even the built-in boards/i)).toBeNull();
  });

  it("an unexplained failure is named as unknown rather than guessed at", async () => {
    installFetch(500);
    render(<AdminDisplayTemplatesPage />);

    await screen.findByText(/could not be loaded/i);
    expect(screen.getByText(/did not say why/i)).toBeDefined();
    expect(screen.queryByText(/not even the built-in boards/i)).toBeNull();
    expect(screen.queryByText(/module looks switched off/i)).toBeNull();
  });

  it("a 401 is reported as an expired session", async () => {
    installFetch(401);
    render(<AdminDisplayTemplatesPage />);

    await screen.findByText(/session has expired/i);
    expect(screen.getByText(/sign in again/i)).toBeDefined();
    expect(screen.queryByText(/not even the built-in boards/i)).toBeNull();
  });

  // The page used to leave "Loading…" up for ever when the fetch rejected —
  // the very blank screen this issue removes.
  it("a transport failure ends the loading state and names the connection", async () => {
    installFetch(0);
    render(<AdminDisplayTemplatesPage />);

    await screen.findByText(/could not be fetched/i);
    expect(screen.getByText(/never reached the server/i)).toBeDefined();
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  // A 200 whose body will not parse — a proxy error page, a truncated
  // payload — used to reject inside `refresh` after the status had already
  // been read as fine, so the page spun on "Loading…" for ever: the same
  // permanent blank screen, reached the other way.
  it("a 200 with an unparseable body ends the loading state and is not called empty", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/admin/display/templates") {
        return new Response("<html>gateway error</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminDisplayTemplatesPage />);

    await screen.findByText(/could not be loaded/i);
    expect(screen.queryByText("Loading…")).toBeNull();
    // It must NOT claim the database was never seeded — that would be a
    // confident lie about a response we could not read.
    expect(screen.queryByText(/not even the built-in boards/i)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Restore built-in boards" })
    ).toBeNull();
  });

  // In these states the POST fails by construction — the same proxy, guard or
  // transport that refused the list refuses the restore — and the copy tells
  // the operator to do something else first.
  it.each([
    ["module off", 404],
    ["forbidden", 403],
    ["signed out", 401],
    ["unreachable", 0],
    ["server error", 500],
  ])("does not offer a restore that cannot work (%s)", async (_label, status) => {
    installFetch(status);
    render(<AdminDisplayTemplatesPage />);

    await screen.findByRole("button", { name: "New template" });
    expect(
      screen.queryByRole("button", { name: "Restore built-in boards" })
    ).toBeNull();
  });
});

describe("Restore built-in boards (#2247)", () => {
  it("warns that existing built-ins are overwritten before it runs", async () => {
    const { calls } = installFetch(200, []);
    render(<AdminDisplayTemplatesPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Restore built-in boards" })
    );

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/OVERWRITTEN/);
    expect(dialog.textContent).toMatch(/not touched/i);
    // The three things an operator can actually lose, all stated up front:
    // a reserved-key row, an in-place edit, and an imported customisation…
    expect(dialog.textContent).toMatch(/reserved built-in keys/i);
    expect(dialog.textContent).toMatch(/edited in place/i);
    expect(dialog.textContent).toMatch(/imported/i);
    // …plus the knock-on nobody expects: a custom board on a built-in layout
    // follows that layout's restored shape.
    expect(dialog.textContent).toMatch(/built on a built-in LAYOUT/i);
    // Nothing has been written yet — the warning precedes the action.
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("cancelling writes nothing", async () => {
    const { calls } = installFetch(200, []);
    render(<AdminDisplayTemplatesPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Restore built-in boards" })
    );
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      calls.some((c) => c.url === "/api/admin/display/built-ins/restore")
    ).toBe(false);
  });

  it("confirming posts the restore, reports it, and reloads the gallery", async () => {
    const { calls } = installFetch(200, []);
    render(<AdminDisplayTemplatesPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Restore built-in boards" })
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Restore built-in boards" })
    );

    await screen.findByText(/Restored the built-in boards/);
    expect(
      calls.filter(
        (c) =>
          c.url === "/api/admin/display/built-ins/restore" && c.method === "POST"
      )
    ).toHaveLength(1);
    // The outcome is announced, not merely displayed.
    const live = screen.getByText(/Restored the built-in boards/).closest(
      "[role='status']"
    );
    expect(live).not.toBeNull();
    // The list is re-read so the new boards appear without a manual reload.
    expect(
      calls.filter(
        (c) => c.url === "/api/admin/display/templates" && c.method === "GET"
      ).length
    ).toBeGreaterThan(1);
  });

  /*
    The trigger is deliberately NOT disabled while the restore is in flight:
    Radix restores focus to it as the dialog closes, and a trigger disabled in
    that same turn cannot take focus, so focus falls to <body> and a keyboard
    user loses their place.

    That leaves re-entrancy to be held by the hook's ref instead, which is what
    this pins — a second press mid-flight must not fire a second POST. Pinning
    `disabled === false` after the restore settles proved nothing: it is false
    under the old code too by then.
  */
  it("a second press mid-flight fires no second restore, and marks itself busy", async () => {
    let releasePost: (() => void) | null = null;
    const calls: Array<{ url: string; method: string }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method });
      if (url === "/api/admin/display/built-ins/restore" && method === "POST") {
        // Hold the request open so the second press lands genuinely mid-flight.
        await new Promise<void>((resolve) => {
          releasePost = resolve;
        });
        return json({ layouts: 7, templates: 7 });
      }
      if (url === "/api/admin/display/templates" && method === "GET") {
        return json({ templates: [] });
      }
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminDisplayTemplatesPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Restore built-in boards" })
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Restore built-in boards" })
    );

    // In flight: the label carries the busy state, aria-busy marks it, and the
    // control is still focusable.
    const trigger = (await screen.findByRole("button", {
      name: "Restoring…",
    })) as HTMLButtonElement;
    expect(trigger.getAttribute("aria-busy")).toBe("true");
    expect(trigger.disabled).toBe(false);

    // Press it again while the first POST is still open.
    fireEvent.click(trigger);
    fireEvent.click(trigger);

    releasePost!();
    await screen.findByText(/Restored the built-in boards/);

    expect(
      calls.filter(
        (c) =>
          c.url === "/api/admin/display/built-ins/restore" && c.method === "POST"
      )
    ).toHaveLength(1);
    // …and no second confirm dialog was opened by those presses either.
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
