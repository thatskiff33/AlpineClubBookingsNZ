// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DisplayScreen } from "@/app/display/display-screen";
import { clubIdentity } from "@/config/club-identity";

/**
 * The club timezone these renders are about (CT-4, #2870).
 *
 * `DisplayScreen` takes the zone as a REQUIRED prop because `/display` sits
 * outside both route-group chrome components and so has no shared provider above
 * it: the server page resolves the club's persisted setting and hands it down.
 * A test therefore has to say which club it is rendering for, which is what makes
 * a zone assertion here capable of failing.
 */
const CLUB_ZONE = "Pacific/Auckland";

// Issue #32 (LTV-007): the display page lifecycle — pairing (code shown,
// claim polled), active (template rendered from the payload), transient
// failure (last good payload retained, stale badge past the threshold), and
// revocation (back to pairing within one poll).

const PAYLOAD = {
  lodge: { name: "Silverpeak Lodge" },
  club: { name: "Alpine Sports Club", logoUrl: null, logoDataUrl: null },
  generatedAt: "2026-04-13T00:00:00.000Z",
  window: { start: "2026-04-13", days: 3 },
  rooms: null,
  bookings: [
    {
      key: "row-1-0",
      label: "Olive O",
      wholeLodge: false,
      roomId: null,
      guests: [
        {
          label: "Jane S",
          stayStart: "2026-04-13",
          stayEnd: "2026-04-15",
          nights: ["2026-04-13", "2026-04-14"],
        },
      ],
      guestCount: 1,
      stayStart: "2026-04-13",
      stayEnd: "2026-04-15",
      // #2735: the expanded envelope, which is what the serialiser emits for a
      // contiguous stay.
      nights: ["2026-04-13", "2026-04-14"],
    },
  ],
  occupancy: [
    { date: "2026-04-13", arriving: 1, departing: 0, staying: 1 },
    { date: "2026-04-14", arriving: 0, departing: 0, staying: 1 },
    { date: "2026-04-15", arriving: 0, departing: 1, staying: 1 },
  ],
  chores: [],
  rules: null,
  notice: null,
  config: { "wifi-code": "alpine1234" },
  capabilities: { bedAllocation: false, chores: false },
  template: {
    key: "everyday-board",
    name: "Everyday board",
    regions: [
      { key: "header", panels: [{ module: "lodge-header" }] },
      { key: "main", panels: [{ module: "arrivals-board", options: { days: 3 } }] },
      { key: "footer", panels: [{ module: "info-footer" }] },
    ],
  },
};

type QueuedResponse =
  | { status: number; body: unknown }
  | { reject: true };

const queue: Array<{ match: (url: string, init?: RequestInit) => boolean; response: QueuedResponse }> = [];

function enqueue(
  match: (url: string, init?: RequestInit) => boolean,
  response: QueuedResponse
) {
  queue.push({ match, response });
}

beforeEach(() => {
  vi.useFakeTimers();
  queue.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const index = queue.findIndex((entry) => entry.match(url, init));
      if (index === -1) throw new Error(`no queued response for ${url}`);
      const [entry] = queue.splice(index, 1);
      if ("reject" in entry.response) throw new Error("network down");
      return new Response(JSON.stringify(entry.response.body), {
        status: entry.response.status,
        headers: { "content-type": "application/json" },
      });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const isState = (url: string) => url.includes("/api/display/state");
const isPairStart = (url: string, init?: RequestInit) =>
  url.includes("/api/display/pair") && String(init?.body).includes("start");
const isPairClaim = (url: string, init?: RequestInit) =>
  url.includes("/api/display/pair") && String(init?.body).includes("claim");

describe("display page render mode", () => {
  it("forces dynamic rendering so inline scripts carry the CSP nonce (issue #54)", async () => {
    // A statically prerendered /display ships Next's inline bootstrap
    // scripts without the per-request nonce; the production nonce-only CSP
    // then blocks hydration and the page renders blank on real TVs.
    const page = await import("@/app/display/page");
    expect(page.dynamic).toBe("force-dynamic");
  });
});

describe("DisplayScreen lifecycle", () => {
  it("walks pairing → claim → active, keeps the last payload on failure, and re-pairs on revocation", async () => {
    // 1. unauthorised → pairing start shows the code
    enqueue(isState, { status: 401, body: { error: "Unauthorised" } });
    enqueue(isPairStart, {
      status: 200,
      body: { code: "ABCDEF", expiresAt: "2026-04-13T00:15:00.000Z" },
    });

    render(<DisplayScreen zone={CLUB_ZONE} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByText("ABCDEF")).toBeDefined();

    // 2. first claim poll: not yet bound → still pairing
    enqueue(isPairClaim, { status: 200, body: { paired: false } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(screen.getByText("ABCDEF")).toBeDefined();

    // 3. second claim poll: paired → state fetch → active board renders
    enqueue(isPairClaim, { status: 200, body: { paired: true } });
    enqueue(isState, { status: 200, body: PAYLOAD });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_100);
    });
    expect(screen.getByText("Silverpeak Lodge")).toBeDefined();
    expect(screen.getByText(/Jane S/)).toBeDefined();
    // Footer wifi item: text is split across elements ("Wi-Fi" + <b>code</b>).
    expect(screen.getByText("alpine1234")).toBeDefined();
    expect(screen.getByText(/Wi-Fi/)).toBeDefined();

    // 4. transient network failure → last payload retained, no stale badge yet
    enqueue(isState, { reject: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.getByText("Silverpeak Lodge")).toBeDefined();
    expect(screen.queryByText(/out of date/)).toBeNull();

    // 5. keep failing past the staleness threshold → badge appears, board stays
    for (let i = 0; i < 3; i++) {
      enqueue(isState, { reject: true });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
    }
    expect(screen.getByText("Silverpeak Lodge")).toBeDefined();
    expect(screen.getByText(/out of date/)).toBeDefined();

    // 6. token revoked → 401 → back to the pairing screen within one poll
    enqueue(isState, { status: 401, body: { error: "Unauthorised" } });
    enqueue(isPairStart, {
      status: 200,
      body: { code: "QRSTUV", expiresAt: "2026-04-13T01:15:00.000Z" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.getByText("QRSTUV")).toBeDefined();
    expect(screen.queryByText("Silverpeak Lodge")).toBeNull();
  });

  it("drives the active-board tick and staleness from the payload's pollSeconds (LTV-039)", async () => {
    // First good payload advertises a fast 20s cadence.
    enqueue(isState, { status: 200, body: { ...PAYLOAD, pollSeconds: 20 } });
    render(<DisplayScreen zone={CLUB_ZONE} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByText("Silverpeak Lodge")).toBeDefined();

    // A default 60s tick would not re-fetch at 20s; a 20s tick must. Queue a
    // distinct next payload: it stays unconsumed at 19s, then arrives just past 20s.
    enqueue(isState, {
      status: 200,
      body: { ...PAYLOAD, lodge: { name: "Second Lodge" }, pollSeconds: 20 },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(19_000);
    });
    expect(screen.queryByText("Second Lodge")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(screen.getByText("Second Lodge")).toBeDefined();

    // Staleness scales to 3× the interval (= 60s). Three failed 20s polls reach
    // exactly 60s — not yet past the threshold, so no stale badge.
    for (let i = 0; i < 3; i++) {
      enqueue(isState, { reject: true });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
    }
    expect(screen.queryByText(/out of date/)).toBeNull();
    expect(screen.getByText("Second Lodge")).toBeDefined();

    // A fourth failed poll pushes past 60s → the stale badge appears, board stays.
    enqueue(isState, { reject: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(screen.getByText(/out of date/)).toBeDefined();
    expect(screen.getByText("Second Lodge")).toBeDefined();
  });

  it("preview mode never pairs: denied shows the admin-login prompt, an admin session renders the board (issue #52)", async () => {
    window.history.pushState({}, "", "/display?previewDevice=dev-9");
    try {
      // The preview query is forwarded verbatim to the state API.
      const isPreviewState = (url: string) =>
        url.includes("/api/display/state?previewDevice=dev-9");

      // 1. not signed in as an admin → denied prompt, NO pairing start
      enqueue(isPreviewState, { status: 401, body: { error: "Unauthorised" } });
      render(<DisplayScreen zone={CLUB_ZONE} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(screen.getByText("Display preview")).toBeDefined();
      expect(screen.getByText(/administrator login/)).toBeDefined();
      expect(screen.queryByText("Pair this display")).toBeNull();

      // 2. admin signs in elsewhere → the next poll renders the board
      enqueue(isPreviewState, { status: 200, body: PAYLOAD });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(screen.getByText("Silverpeak Lodge")).toBeDefined();
    } finally {
      window.history.pushState({}, "", "/display");
    }
  });

  it("marks the header clock as simulated (amber, in place) when a previewDate is active (issue #60)", async () => {
    window.history.pushState({}, "", "/display?previewDevice=dev-9&previewDate=2026-08-01");
    try {
      const isPreviewState = (url: string) =>
        url.includes("/api/display/state?previewDevice=dev-9");
      enqueue(isPreviewState, { status: 200, body: PAYLOAD });
      const { container } = render(<DisplayScreen zone={CLUB_ZONE} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      // The existing clock container carries the simulated state — recoloured
      // in place, so no separate marker element is added.
      expect(
        container.querySelector(".display-header-clock[data-simulated]")
      ).not.toBeNull();
      // The date line is a picker with a hidden date input in preview mode.
      expect(container.querySelector('input[type="date"]')).not.toBeNull();
      // Accessible-only hint, but no visible layout-shifting marker element.
      expect(screen.getByText(/Simulating/)).toBeDefined();
      // #109 follow-up: the lodge is identified on the admin preview host page
      // around the frame, so there is no in-frame "previewing against" line.
      expect(screen.queryByText(/Previewing against/)).toBeNull();
    } finally {
      window.history.pushState({}, "", "/display");
    }
  });

  it("applies a selected date via the sibling input (the #65 picker fix)", async () => {
    // #65: the date input used to be nested inside the <button>, where a native
    // date selection did not reliably fire change, so picking a date never
    // applied. It is now a SIBLING of the button; selecting a date must rewrite
    // ?previewDate on the URL. jsdom cannot navigate on a location write, so we
    // stub window.location with a plain, writable `search`.
    const originalLocation = window.location;
    const locationStub = {
      ...originalLocation,
      search: "?previewDevice=dev-9",
    } as unknown as Location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: locationStub,
    });
    try {
      const isPreviewState = (url: string) =>
        url.includes("/api/display/state?previewDevice=dev-9");
      enqueue(isPreviewState, { status: 200, body: PAYLOAD });
      const { container } = render(<DisplayScreen zone={CLUB_ZONE} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      const input = container.querySelector(
        'input[type="date"]'
      ) as HTMLInputElement | null;
      expect(input).not.toBeNull();
      // The input is a sibling of the picker button, never its descendant.
      expect(input?.closest("button")).toBeNull();

      await act(async () => {
        fireEvent.change(input as HTMLInputElement, {
          target: { value: "2026-09-01" },
        });
      });

      // The apply path wrote the simulated date onto the URL (the reload path a
      // real browser would then follow).
      expect(window.location.search).toContain("previewDate=2026-09-01");
      expect(window.location.search).toContain("previewDevice=dev-9");
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it("renders no date picker and no simulated state in real (non-preview) mode", async () => {
    enqueue(isState, { status: 200, body: PAYLOAD });
    const { container } = render(<DisplayScreen zone={CLUB_ZONE} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByText("Silverpeak Lodge")).toBeDefined();
    expect(container.querySelector('input[type="date"]')).toBeNull();
    expect(
      container.querySelector(".display-header-clock[data-simulated]")
    ).toBeNull();
    expect(screen.queryByText(/Simulating/)).toBeNull();
    // No "previewing against" line on a real, unattended wall (LTV-036).
    expect(screen.queryByText(/Previewing against/)).toBeNull();
  });

  it("renders a neutral placeholder for a module with no renderer yet", async () => {
    enqueue(isState, {
      status: 200,
      body: {
        ...PAYLOAD,
        template: {
          key: "future",
          name: "Future",
          // A name with no renderer (defensive path — real templates are
          // validated against the registry server-side).
          regions: [{ key: "main", panels: [{ module: "future-module" }] }],
        },
      },
    });
    const { container } = render(<DisplayScreen zone={CLUB_ZONE} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(
      container.querySelector('.display-module-placeholder[data-module="future-module"]')
    ).not.toBeNull();
  });
});

// LTV-027/LTV-041: the layout engine. A device bound to a v2 Layout+Template
// arrives as a `layoutRender` payload (already validated + sanitised server-side).
// Since LTV-041 (issue #96) the SERVER swaps each `{{area:key}}`/`{{module:name}}`
// token for an inert `<div data-display-*>` marker; the client renders the html
// whole and portals its Area/module into each marker. These tests author the
// readable token form and `markerize` mimics that final server step, so the
// payload matches what the client actually receives.
function markerize(html: string): string {
  return html
    .replace(
      /\{\{area:([a-z0-9][a-z0-9-]{0,63})\}\}/g,
      (_m, key: string) => `<div data-display-area="${key}"></div>`
    )
    .replace(
      /\{\{module:([a-z0-9][a-z0-9-]{0,63})\}\}/g,
      (_m, name: string) => `<div data-display-module="${name}"></div>`
    );
}

function markerizeSlot(value: unknown): unknown {
  if (value && typeof value === "object" && "html" in value) {
    return { ...value, html: markerize(String((value as { html: unknown }).html)) };
  }
  return value;
}

function markerizeLayout(layoutRender: Record<string, unknown>): Record<string, unknown> {
  const out = { ...layoutRender };
  if (typeof out.bodyHtml === "string") out.bodyHtml = markerize(out.bodyHtml);
  if (typeof out.footerHtml === "string") out.footerHtml = markerize(out.footerHtml);
  if (out.slotContent && typeof out.slotContent === "object") {
    const slots: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(out.slotContent as Record<string, unknown>)) {
      slots[key] = markerizeSlot(value);
    }
    out.slotContent = slots;
  }
  if (Array.isArray(out.areas)) {
    out.areas = out.areas.map((area) =>
      area && typeof area === "object" && "defaultContent" in area
        ? { ...area, defaultContent: markerizeSlot((area as { defaultContent: unknown }).defaultContent) }
        : area
    );
  }
  return out;
}

function layoutPayload(layoutRender: Record<string, unknown>) {
  return { ...PAYLOAD, layoutRender: markerizeLayout(layoutRender) };
}

async function renderLayout(layoutRender: Record<string, unknown>) {
  enqueue(isState, { status: 200, body: layoutPayload(layoutRender) });
  const result = render(<DisplayScreen zone={CLUB_ZONE} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  return result;
}

describe("DisplayScreen layout engine (LTV-027)", () => {
  it("renders html body segments, an html slot, and a module slot inside the fixed shell", async () => {
    const { container } = await renderLayout({
      bodyHtml: "<h2>Board Heading</h2>{{area:info}}{{area:mod}}",
      defaultCss: ".display-layout-body{gap:1rem}",
      cssOverrides: "",
      areas: [
        { key: "info", description: "Intro", kind: "static" },
        { key: "mod", description: "Module", kind: "static" },
      ],
      slotContent: {
        info: { html: "<p>Intro copy here</p>" },
        mod: { module: "welcome" },
      },
      footerHtml: "<span>Footer 5G wifi</span>",
    });

    // Fixed header furniture stays around the editable body.
    expect(screen.getByText("Silverpeak Lodge")).toBeDefined();
    // Literal body html segment.
    expect(screen.getByText("Board Heading")).toBeDefined();
    // An html slot renders its (server-sanitised) content.
    expect(screen.getByText("Intro copy here")).toBeDefined();
    // A module slot renders its component.
    expect(container.querySelector(".display-welcome")).not.toBeNull();
    expect(screen.getByText(/Welcome to Silverpeak Lodge/)).toBeDefined();
    // The editable footer renders the authored footerHtml.
    expect(screen.getByText("Footer 5G wifi")).toBeDefined();
  });

  it("falls back to the built-in InfoFooter when footerHtml is empty", async () => {
    await renderLayout({
      bodyHtml: "{{area:main}}",
      defaultCss: "",
      cssOverrides: "",
      areas: [{ key: "main", description: "Main", kind: "static" }],
      slotContent: { main: { html: "<p>Body</p>" } },
      footerHtml: "",
    });
    // The InfoFooter surfaces the wifi code from config.
    expect(screen.getByText("alpine1234")).toBeDefined();
  });

  it("renders a conditional area only while its condition holds", async () => {
    const layout = {
      bodyHtml: "{{area:notice}}",
      defaultCss: "",
      cssOverrides: "",
      areas: [
        {
          key: "notice",
          description: "Notice",
          kind: "conditional",
          condition: "content:notice",
        },
      ],
      slotContent: { notice: { html: "<p>Committee notice slot</p>" } },
      footerHtml: "",
    };

    // notice === null → the condition is false → the area is omitted.
    await renderLayout(layout);
    expect(screen.queryByText("Committee notice slot")).toBeNull();

    // With a notice set, the same area renders.
    enqueue(isState, {
      status: 200,
      body: { ...layoutPayload(layout), notice: "Meeting Friday" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.getByText("Committee notice slot")).toBeDefined();
  });

  it("rotates a rotator among eligible children on its timer and skips ineligible ones", async () => {
    const { container } = await renderLayout({
      bodyHtml: "{{area:roto}}",
      defaultCss: "",
      cssOverrides: "",
      areas: [
        {
          key: "roto",
          description: "Rotator",
          kind: "rotator",
          rotateSeconds: 5,
          children: [
            { key: "a", description: "A" },
            { key: "b", description: "B", condition: "content:notice" },
            { key: "c", description: "C" },
          ],
        },
      ],
      slotContent: {
        "roto/a": { html: "<p>Slide Alpha</p>" },
        "roto/b": { html: "<p>Slide Bravo</p>" },
        "roto/c": { html: "<p>Slide Charlie</p>" },
      },
      footerHtml: "",
    });

    // First eligible child (Bravo is skipped — its condition is false).
    expect(screen.getByText("Slide Alpha")).toBeDefined();
    expect(screen.queryByText("Slide Bravo")).toBeNull();

    // Advance one rotation → the next eligible child (Charlie, not Bravo).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.queryByText("Slide Alpha")).toBeNull();
    expect(screen.getByText("Slide Charlie")).toBeDefined();
    expect(screen.queryByText("Slide Bravo")).toBeNull();
    // The shell survives the rotation.
    expect(container.querySelector(".display-lodge-header")).not.toBeNull();
  });

  it("renders nothing for a rotator with zero eligible children, without breaking the shell", async () => {
    const { container } = await renderLayout({
      bodyHtml: "{{area:roto}}",
      defaultCss: "",
      cssOverrides: "",
      areas: [
        {
          key: "roto",
          description: "Rotator",
          kind: "rotator",
          rotateSeconds: 5,
          children: [{ key: "a", description: "A", condition: "content:notice" }],
        },
      ],
      slotContent: { "roto/a": { html: "<p>Never eligible</p>" } },
      footerHtml: "",
    });
    expect(screen.queryByText("Never eligible")).toBeNull();
    // Header/footer shell still renders.
    expect(container.querySelector(".display-lodge-header")).not.toBeNull();
    expect(screen.getByText("Silverpeak Lodge")).toBeDefined();
  });

  it("renders the neutral placeholder for a slot naming an unknown module", async () => {
    const { container } = await renderLayout({
      bodyHtml: "{{area:main}}",
      defaultCss: "",
      cssOverrides: "",
      areas: [{ key: "main", description: "Main", kind: "static" }],
      slotContent: { main: { module: "future-module" } },
      footerHtml: "",
    });
    expect(
      container.querySelector('.display-module-placeholder[data-module="future-module"]')
    ).not.toBeNull();
  });

  it("mounts areas INSIDE authored container elements — the 2+1 grid case (issue #96)", async () => {
    // The regression: two placeholders nested two containers deep. Before the
    // marker+portal fix the areas broke out to siblings and the grid was empty.
    const { container } = await renderLayout({
      bodyHtml:
        '<div class="two-plus-one">' +
        '<div class="main-col">{{area:main}}</div>' +
        '<div class="side-col">{{area:rail}}</div></div>',
      defaultCss: "",
      cssOverrides: "",
      areas: [
        { key: "main", description: "Main", kind: "static" },
        { key: "rail", description: "Rail", kind: "static" },
      ],
      slotContent: {
        main: { html: "<p>Main column body</p>" },
        rail: { html: "<p>Side rail body</p>" },
      },
      footerHtml: "",
    });

    const grid = container.querySelector(".two-plus-one");
    expect(grid).not.toBeNull();
    // The grid container is NOT empty — it holds the two authored columns.
    expect(grid?.childElementCount).toBe(2);

    // Each slot's content renders INSIDE its column (parentElement chain), not
    // as a sibling of the grid.
    const mainText = screen.getByText("Main column body");
    const sideText = screen.getByText("Side rail body");
    expect(mainText.closest(".main-col")).not.toBeNull();
    expect(mainText.closest(".two-plus-one")).not.toBeNull();
    expect(sideText.closest(".side-col")).not.toBeNull();
    expect(sideText.closest(".two-plus-one")).not.toBeNull();
    // The main-col content never leaked into the side-col.
    expect(sideText.closest(".main-col")).toBeNull();
  });
});

describe("DisplayScreen layout engine — CSS scoping + theme (LTV-029)", () => {
  const CSS_LAYOUT = {
    bodyHtml: "{{area:main}}",
    // Server ships these already sanitised + scoped; the client only injects.
    themeCss: ":root{--brand-gold:#8fa87c}",
    defaultCss: ".display-authored-root .board{gap:1rem}",
    cssOverrides: ".display-authored-root .board{color:red}",
    areas: [{ key: "main", description: "Main", kind: "static" }],
    slotContent: { main: { html: '<div class="board">Body</div>' } },
    footerHtml: "<span>Authored footer</span>",
  };

  it("injects three ordered style tags: theme → layout → overrides", async () => {
    const { container } = await renderLayout(CSS_LAYOUT);
    const styles = Array.from(
      container.querySelectorAll("style[data-display-style]")
    );
    expect(styles.map((s) => s.getAttribute("data-display-style"))).toEqual([
      "theme",
      "layout",
      "overrides",
    ]);
    // The non-authored theme variables ship in the first tag.
    expect(styles[0].innerHTML).toContain("--brand-gold");
    // The authored (scoped) CSS ships after it.
    expect(styles[2].innerHTML).toContain(".display-authored-root .board");
  });

  it("wraps the editable body in .display-authored-root but keeps the header outside", async () => {
    const { container } = await renderLayout(CSS_LAYOUT);
    // The body is a descendant of the authored root...
    expect(
      container.querySelector(".display-authored-root .display-layout-body")
    ).not.toBeNull();
    // ...but the fixed header chrome is NOT — authored CSS can never reach it.
    expect(container.querySelector(".display-lodge-header")).not.toBeNull();
    expect(
      container.querySelector(".display-authored-root .display-lodge-header")
    ).toBeNull();
  });

  it("renders the authored footer INSIDE the authored root", async () => {
    const { container } = await renderLayout(CSS_LAYOUT);
    expect(screen.getByText("Authored footer")).toBeDefined();
    expect(
      container.querySelector(".display-authored-root .display-info-footer")
    ).not.toBeNull();
  });

  it("keeps the built-in InfoFooter fallback OUTSIDE the authored root", async () => {
    const { container } = await renderLayout({ ...CSS_LAYOUT, footerHtml: "" });
    // The fallback footer surfaces the wifi code (chrome), and stays outside.
    expect(screen.getByText("alpine1234")).toBeDefined();
    expect(container.querySelector(".display-info-footer")).not.toBeNull();
    expect(
      container.querySelector(".display-authored-root .display-info-footer")
    ).toBeNull();
  });
});

describe("DisplayScreen layout engine — embedded module tokens (LTV-028)", () => {
  it("mounts a module embedded in slot html via {{module:…}} between html fragments", async () => {
    const { container } = await renderLayout({
      bodyHtml: "{{area:main}}",
      defaultCss: "",
      cssOverrides: "",
      areas: [{ key: "main", description: "Main", kind: "static" }],
      slotContent: {
        // Server-resolved html: an html fragment, then a module embed token.
        main: { html: "<h3>Board</h3>{{module:arrivals-board}}" },
      },
      footerHtml: "",
    });
    // The html fragment renders...
    expect(screen.getByText("Board")).toBeDefined();
    // ...and the embedded module mounts as a real component.
    expect(container.querySelector(".display-arrivals-board")).not.toBeNull();
  });

  it("renders a server-escaped config value in slot html as literal text, never an element", async () => {
    const { container } = await renderLayout({
      bodyHtml: "{{area:main}}",
      defaultCss: "",
      cssOverrides: "",
      areas: [{ key: "main", description: "Main", kind: "static" }],
      slotContent: {
        // buildLayoutRender escapes an injected config value to this before it
        // ever reaches the client (see lodge-display-layout-render.test.ts).
        main: { html: "<p>&lt;img src=x onerror=alert(1)&gt;</p>" },
      },
      footerHtml: "",
    });
    // The browser decodes the entities to visible text — but no live element.
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeDefined();
    expect(container.querySelector("img")).toBeNull();
  });

  it("mounts a module embedded in the footer html", async () => {
    const { container } = await renderLayout({
      bodyHtml: "{{area:main}}",
      defaultCss: "",
      cssOverrides: "",
      areas: [{ key: "main", description: "Main", kind: "static" }],
      slotContent: { main: { html: "<p>Body</p>" } },
      footerHtml: "<span>Info</span>{{module:welcome}}",
    });
    expect(screen.getByText("Info")).toBeDefined();
    expect(container.querySelector(".display-welcome")).not.toBeNull();
  });

  it("degrades an unknown module embed to the neutral placeholder (defensive)", async () => {
    const { container } = await renderLayout({
      bodyHtml: "{{area:main}}",
      defaultCss: "",
      cssOverrides: "",
      areas: [{ key: "main", description: "Main", kind: "static" }],
      slotContent: { main: { html: "{{module:future-thing}}" } },
      footerHtml: "",
    });
    expect(
      container.querySelector('.display-module-placeholder[data-module="future-thing"]')
    ).not.toBeNull();
  });
});

// Issue #176 (ADR-003 §5 "Unattended surface"): a throwing module/board must
// NEVER blank the wall. Every render branch (authored LayoutScreen, legacy
// ActiveScreen, layoutRenderError→FallbackBoard) is wrapped so a render-time
// throw drops to a fallback shell, and `error.tsx` is the framework-level last
// resort. React logs a caught render error to console.error; that is expected
// here, so silence it to keep the run readable.
describe("DisplayScreen render-branch error boundaries (issue #176)", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("authored branch: a throwing LayoutScreen drops to the known-good FallbackBoard, never blank", async () => {
    // areas:null forces LayoutScreen's `layoutRender.areas.map` to throw during
    // render (bypassing markerize, which would coerce a valid shape).
    enqueue(isState, {
      status: 200,
      body: {
        ...PAYLOAD,
        layoutRender: {
          bodyHtml: '<div data-display-area="main"></div>',
          themeCss: "",
          defaultCss: "",
          cssOverrides: "",
          areas: null,
          slotContent: {},
          footerHtml: "",
        },
      },
    });
    const { container } = render(<DisplayScreen zone={CLUB_ZONE} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    // The degraded FallbackBoard renders (its own boundary caught the throw)...
    expect(container.querySelector(".display-fallback-board")).not.toBeNull();
    // ...with real chrome, proving the wall is not blank.
    expect(screen.getByText("Silverpeak Lodge")).toBeDefined();
    // It did NOT fall all the way to the minimal shell.
    expect(
      container.querySelector('[data-display-fallback="minimal"]')
    ).toBeNull();
  });

  it("legacy branch: a throwing ActiveScreen drops to the minimal zero-data shell, never blank", async () => {
    // regions:null forces ActiveScreen's `definition.regions.map` to throw; no
    // layoutRender and no layoutRenderError → the legacy branch renders it.
    enqueue(isState, {
      status: 200,
      body: {
        ...PAYLOAD,
        template: { key: "legacy", name: "Legacy", regions: null },
      },
    });
    const { container } = render(<DisplayScreen zone={CLUB_ZONE} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    const shell = container.querySelector<HTMLElement>(
      '[data-display-fallback="minimal"]'
    );
    expect(shell).not.toBeNull();
    // Not blank: the shell element is actually mounted as the render root.
    expect(container.firstElementChild).toBe(shell);
    // jsdom computes no CSS, so we cannot assert the painted pixels — instead
    // assert the properties that make the shell non-blank in a real browser:
    // the branded `.display-shell` class and the inlined background gradient
    // pinned full-viewport (position:fixed + inset:0). Without these the
    // boundary would mount an unstyled, effectively blank div (issue #186 F1).
    expect(shell!.className).toContain("display-shell");
    expect(shell!.style.background).toContain("linear-gradient");
    expect(shell!.style.position).toBe("fixed");
    expect(shell!.style.inset).toBe("0px");
  });

  it("fallback branch: a FallbackBoard that itself throws drops to the minimal shell, never blank", async () => {
    // window:null makes the fallback board's LodgeHeader throw on
    // `state.window.start`; layoutRenderError routes straight to FallbackBoard,
    // so the outer boundary is the only net left.
    enqueue(isState, {
      status: 200,
      body: { ...PAYLOAD, window: null, layoutRenderError: true },
    });
    const { container } = render(<DisplayScreen zone={CLUB_ZONE} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(
      container.querySelector('[data-display-fallback="minimal"]')
    ).not.toBeNull();
  });

  it("ships a route-segment error.tsx as the framework-level last-resort shell", async () => {
    // The unattended-safety contract requires a segment error boundary beyond
    // the in-tree React boundaries; assert it exists and is a client component.
    const mod = await import("@/app/display/error");
    expect(typeof mod.default).toBe("function");
  });
});

// #2286: the custodian slot in the built-in info footer. The role word on the
// lobby TV is the FIXED string "Custodian"/"Custodians" for every club (owner
// decision, 29 Jul) — deliberately NOT the configurable `hutLeaderLabel` that
// every admin surface uses. Pinned here because the decision is invisible in the
// code otherwise: it looks exactly like a place someone forgot to thread the
// label through.
describe("InfoFooter custodian slot (#2286)", () => {
  async function renderWithCustodian(
    custodian: { label: string | null; count: number } | null,
  ) {
    enqueue(isState, { status: 200, body: { ...PAYLOAD, custodian } });
    const result = render(<DisplayScreen zone={CLUB_ZONE} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    return result;
  }

  it("uses the FIXED role word, never the club's configurable hut-leader label", async () => {
    const { container } = await renderWithCustodian({
      label: "Sam R",
      count: 1,
    });

    const slot = container.querySelector<HTMLElement>(
      '[data-testid="display-custodian"]',
    );
    expect(slot).not.toBeNull();
    expect(slot!.textContent).toContain("Custodian");
    expect(slot!.textContent).toContain("Sam R");
    // The club's own word must not appear anywhere on the wall's footer.
    expect(container.textContent).not.toContain(clubIdentity.hutLeaderLabel);
  });

  it("renders the role word alone when the person must not be named", async () => {
    // label null = counts-only granularity, or a minor-age custodian at any
    // granularity. The slot still appears: that somebody is on site is the
    // useful part.
    const { container } = await renderWithCustodian({ label: null, count: 1 });

    const slot = container.querySelector<HTMLElement>(
      '[data-testid="display-custodian"]',
    );
    expect(slot!.textContent?.replace(/\s+/g, " ").trim()).toBe("🛎Custodian");
  });

  it("says Custodians and shows the count on an un-named handover night", async () => {
    const { container } = await renderWithCustodian({ label: null, count: 2 });

    const slot = container.querySelector<HTMLElement>(
      '[data-testid="display-custodian"]',
    );
    expect(slot!.textContent).toContain("Custodians");
    // Never "Custodian" alone when two people hold two beds tonight.
    expect(slot!.textContent).toContain("2");
  });

  it("shows no slot at all when nobody is in residence", async () => {
    const { container } = await renderWithCustodian(null);

    expect(
      container.querySelector('[data-testid="display-custodian"]'),
    ).toBeNull();
  });
});
