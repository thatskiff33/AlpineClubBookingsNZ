// @vitest-environment jsdom

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE `Intl.DateTimeFormat` WATCH, INSTALLED BEFORE THIS FILE'S IMPORTS RUN.
 *
 * `vi.hoisted` is lifted above every `import` in this file, so the counting
 * constructor below is in place before `club-time-zone-panel.tsx`, the club-time
 * kernel, or anything else in their graph has been evaluated. That timing is the
 * whole point rather than a detail, and each of the three defects it exists to
 * see survived the previous version of this guard for a different reason:
 *
 *  1. A `beforeEach` spy CANNOT SEE A MODULE-SCOPE CONSTRUCTION. A panel holding
 *     `const HOST_FMT = new Intl.DateTimeFormat();` at module scope — the viewer's
 *     clock, read on every render — builds it at import time, long before any
 *     hook has run. Installed here, that construction is counted.
 *  2. THE KERNEL MEMOISES ITS FORMATTERS (`src/lib/club-time/intl.ts`), so a
 *     counter reset per test sees nothing after the first render in the file: the
 *     cache is module-level and outlives every `beforeEach`. These counters are
 *     therefore CUMULATIVE FOR THE WHOLE FILE and are never reset, which is what
 *     makes a kernel that dropped `timeZone` from its one construction visible
 *     here at all.
 *  3. COUNTING IS NOT MEASURING. A zero can mean "nothing was built without a
 *     zone" or "nothing was built"; the previous version's anti-vacuity check was
 *     satisfied by the TEST PROVIDER validating its own zone, so the panel could
 *     have stopped formatting entirely and the guard would still have passed.
 *     `kernelZones` records only constructions raised from inside the club-time
 *     kernel — the panel's one and only formatting path — and records them BY
 *     ZONE, so the guard can require one for a zone nothing else in this file
 *     renders under. Break the panel's formatter into a pass-through and that
 *     zone never appears.
 *
 * WHAT NO CONSTRUCTOR SPY OF ANY SHAPE CAN SEE, and this is a real limit rather
 * than a caveat: `Date.prototype.toLocaleString` and its `toLocaleDateString` /
 * `toLocaleTimeString` siblings do not go through the JS-visible
 * `Intl.DateTimeFormat` constructor in V8, so they render in the VIEWER's zone
 * and are invisible to everything below. That class is closed STATICALLY
 * instead — `eslint.config.mjs` bans all three across `src/` under
 * `INV-DATE-015`, this file carries no exemption from that block, and
 * `src/lib/__tests__/date-only-encoding-guard.test.ts` lints a real violation at
 * every production path to prove the arm still fires. The runtime guard and the
 * lint arm cover different halves; neither is redundant.
 */
const intlWatch = vi.hoisted(() => {
  const RealDateTimeFormat = Intl.DateTimeFormat;

  const state = {
    /** Constructions carrying no explicit `timeZone` — i.e. in the VIEWER's zone. */
    unzoned: 0,
    /**
     * The zones the club-time KERNEL (`src/lib/club-time/intl.ts`) built a
     * formatter for. Recorded by zone rather than counted, because the kernel
     * memoises per zone: a render under a zone nothing else in this file uses is
     * guaranteed to miss that cache, so its presence here is proof that THIS
     * render reached the kernel — where a bare count could have been run up by
     * any earlier test in the file.
     */
    kernelZones: new Set<string>(),
    /** Every construction, so a zero above can be shown to be a measurement. */
    total: 0,
    restore(): void {
      Intl.DateTimeFormat = RealDateTimeFormat;
    },
  };

  /*
    A plain `function`, not an arrow: this stands in for a CONSTRUCTOR and has to
    be callable with `new`. It delegates to the real implementation captured
    above, so every formatter behaves normally and only the construction is
    observed. `Intl.DateTimeFormat` is also callable WITHOUT `new`, which returns
    a formatter just the same, and this form counts that too.
  */
  function WatchedDateTimeFormat(
    locales?: Intl.LocalesArgument,
    options?: Intl.DateTimeFormatOptions,
  ): Intl.DateTimeFormat {
    state.total += 1;
    if (options?.timeZone === undefined) state.unzoned += 1;
    // The kernel is the only sanctioned formatting path in this tree, and its
    // frame is what proves the PANEL — not the scaffolding — reached it. The
    // provider's own zone validation (`normaliseClubTimeZone`) constructs from
    // `src/lib/club-time-zone.ts` and so is deliberately not recorded here.
    if (
      options?.timeZone !== undefined &&
      /club-time[/\\]intl/.test(new Error().stack ?? "")
    ) {
      state.kernelZones.add(options.timeZone);
    }
    return new RealDateTimeFormat(locales, options);
  }

  WatchedDateTimeFormat.prototype = RealDateTimeFormat.prototype;
  WatchedDateTimeFormat.supportedLocalesOf = (
    ...args: Parameters<typeof RealDateTimeFormat.supportedLocalesOf>
  ) => RealDateTimeFormat.supportedLocalesOf(...args);

  Intl.DateTimeFormat =
    WatchedDateTimeFormat as unknown as typeof Intl.DateTimeFormat;

  return state;
});

import type { ReactNode } from "react";

import {
  CLUB_TIME_TEST_ZONE,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render";

import { ClubTimeZonePanel } from "@/components/admin/club-time-zone-panel";
import { ClubTimeProvider } from "@/components/club-time-provider";
import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";

/*
  The club-timezone maintenance panel (CT-1, #2989; epic #2988).

  Four things are being pinned, and only the first is ordinary UI behaviour:

  1. STAGED EDITING. The panel mounts read-only, and choosing a zone from the
     selector persists NOTHING. `docs/ARCHITECTURE.md` -> "Admin/member layer"
     is the rule; the failure it prevents is an operator browsing the list of 418
     zones and changing the club's civil time by scrolling.

  2. THE ACKNOWLEDGEMENT REALLY GATES SAVE, and the consequences it acknowledges
     are on the screen in plain English. A confirmation the operator cannot fail
     to satisfy is decoration.

  3. THE BROWSER NEVER DECIDES THE TIMEZONE. A panel that seeded itself from the
     reader's machine would show a London admin a different club than an Ohakune
     one, and would offer to "correct" the club's setting to the reader's own
     zone.

     WHAT IS SPIED ON CHANGED IN CT-4 (#2870). It used to be
     `Intl.DateTimeFormat.prototype.resolvedOptions`, asserted never to be called
     at all. That was a proxy for the rule rather than the rule:
     `resolvedOptions()` is ALSO how you ask a runtime whether it knows a named
     zone and what it calls it, which is validation, not a viewer read — and CT-4
     put exactly such a validation on the client (`normaliseClubTimeZone`, which
     the provider above this panel runs on its own zone), where the browser's ICU
     may be an older build than the server's and a zone it cannot load must fall
     back rather than throw a RangeError over the whole page. Under the old spy
     that correct, necessary call read as a violation — measured, on unmutated
     code: "called 1 times".

     The ban is now asserted where it actually lives: no `Intl.DateTimeFormat`
     may be CONSTRUCTED without an explicit `timeZone`. That is the same shape
     `eslint.config.mjs` bans statically (`NO_UNZONED_INTL_DATE_TIME_FORMAT`,
     INV-DATE-015), it is the only construction whose `resolvedOptions().timeZone`
     reports the VIEWER's clock, and it also catches an unzoned formatter that
     merely FORMATS — which the old spy could not see at all.

     THE FIRST VERSION OF THAT CHANGE WAS VACUOUS, and the fix is the hoisted
     watch at the top of this file rather than the choice of what to count. See
     its docblock: counting from a `beforeEach` cannot see a module-scope
     construction, is blinded by the kernel's formatter memo after the first
     render, and its anti-vacuity check was being satisfied by the test
     provider's own zone validation rather than by anything the panel did.

  4. THE PANEL SPELLS AN INSTANT IN THE CLUB'S PERSISTED ZONE, and the last test
     in this file proves it with a PAIR — the same fixture under two provider
     zones, asserted to produce two different answers. Nothing in this file reads
     `APP_TIME_ZONE`: a premise written against it changes meaning with the host,
     and on a machine running `TZ=America/Denver` it would equal the zone under
     test and assert nothing at all.
*/

const SERVER_STATE = {
  timeZone: "Pacific/Auckland",
  source: "persisted" as const,
  updatedAt: "2026-06-30T21:30:00.000Z",
  updatedByName: "Ada Lovelace",
  unusableStoredValue: null,
};

/**
 * The same instant spelled in a named zone, through the club-time kernel.
 *
 * The KERNEL rather than a hand-rolled `Intl.DateTimeFormat`, because that is
 * what the panel renders through: an expectation built any other way pins the
 * house shape twice and drifts the moment one of the two copies is edited.
 */
function spelledIn(timeZone: string, iso: string): string {
  return bindClubTime(requireClubTimeZone(timeZone)).instantDateTime(
    new Date(iso),
  );
}

/** A provider pinned to one named zone, replacing the harness's default. */
function providerFor(zone: string) {
  return function PinnedClubTime({ children }: { children: ReactNode }) {
    return <ClubTimeProvider zone={zone}>{children}</ClubTimeProvider>;
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

function respondWith(state: unknown) {
  return {
    ok: true,
    json: async () => ({ state, changed: true }),
    text: async () => JSON.stringify({ state }),
  };
}

beforeEach(() => {
  fetchMock = vi.fn(async (_url: unknown, init?: { method?: string }) =>
    init?.method === "PUT"
      ? respondWith({ ...SERVER_STATE, timeZone: "Pacific/Chatham" })
      : respondWith(SERVER_STATE),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/*
  `Intl` is a realm global rather than a jsdom one, so the watch is handed back
  explicitly on the way out rather than left for the environment teardown.
*/
afterAll(() => {
  intlWatch.restore();
});

/** Render and wait for the server-supplied state to arrive. */
async function renderPanel(zone?: string) {
  render(
    <ClubTimeZonePanel />,
    zone === undefined ? undefined : { wrapper: providerFor(zone) },
  );
  await screen.findByTestId("current-club-time-zone");
}

function putCalls() {
  return fetchMock.mock.calls.filter(
    (call) => (call[1] as { method?: string } | undefined)?.method === "PUT",
  );
}

function saveButton() {
  return screen.getByRole("button", { name: /Save time zone/ });
}

/**
 * The zones the selector is offering, read straight off the `<select>`.
 *
 * NOT `getAllByRole("option")`, and the difference is measurable rather than
 * stylistic (#2989 fix round). The unfiltered list holds 418 options, and the
 * role query runs jsdom's accessibility check — a `getComputedStyle` walk up
 * each element's ancestors — over every one of them, twice per assertion. That
 * is what took the filter test below past the 5000 ms default timeout under
 * parallel load while it passed in about a second on its own. A `<select>`'s
 * `options` collection is the same set by construction, so nothing is weakened.
 */
function zoneOptions(): string[] {
  const select = screen.getByLabelText("Time zone") as HTMLSelectElement;
  return [...select.options].map((option) => option.textContent ?? "");
}

describe("ClubTimeZonePanel", () => {
  it("renders the zone the server supplied, and asks the server for it", async () => {
    await renderPanel();

    expect(screen.getByTestId("current-club-time-zone").textContent).toBe(
      "Pacific/Auckland",
    );
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "/api/admin/club-time-zone",
    );
    // Who changed it, and when — spelled in the club's own configured zone.
    expect(screen.getByText(/Ada Lovelace/)).not.toBeNull();
  });

  it("says so when the club has not chosen a zone yet", async () => {
    fetchMock.mockImplementation(async () =>
      respondWith({
        timeZone: "Pacific/Auckland",
        source: "default",
        updatedAt: null,
        updatedByName: null,
        unusableStoredValue: null,
      }),
    );
    await renderPanel();

    // The provenance word the operator guide uses, verbatim.
    expect(screen.getByText("Default")).not.toBeNull();
    expect(
      screen.getByText(/Saving below records the club's own choice/),
    ).not.toBeNull();
    expect(screen.queryByText(/Last changed/)).toBeNull();
  });

  /**
   * A zone no other test in this file renders under, so the club-time kernel's
   * per-zone formatter memo is guaranteed to MISS on the render below. That miss
   * is what makes the anti-vacuity assertion a measurement of this render rather
   * than a tally some earlier test could have run up.
   */
  const CACHE_MISS_ZONE = "Pacific/Kiritimati";

  it("never asks the viewer's own clock what the timezone is", async () => {
    await renderPanel(CACHE_MISS_ZONE);
    fireEvent.click(screen.getByRole("button", { name: /Change time zone/ }));

    // The list of CHOICES may come from this runtime. The DECISION may not: a
    // formatter built with no `timeZone` renders in the browser's own zone, and
    // reading its `resolvedOptions().timeZone` is how a page would learn that
    // zone. Nothing in the panel, in the club-time kernel beneath it, or in the
    // binding above it is allowed to build one — and because the watch was
    // installed before this file's imports, that covers a formatter frozen at
    // module scope as well as one built during a render.
    expect(
      intlWatch.unzoned,
      "INV-DATE-015: something in this panel's graph built an Intl.DateTimeFormat " +
        "with no explicit timeZone. That formatter renders in the VIEWER's clock, " +
        "and its resolvedOptions().timeZone is how a page learns the viewer's zone.",
    ).toBe(0);

    /*
      THE ANTI-VACUITY, AND IT MEASURES THE PANEL. `unzoned === 0` is also what a
      panel that formats NOTHING scores, and a watch installed but never reached
      scores it too — which is precisely how the previous version of this guard
      passed while counting nothing but the test provider validating its own zone.
      The club-time kernel is the panel's only formatting path, and the render
      above used a zone no other test here touches, so a kernel formatter for THAT
      zone can only have come from this screen, on this render, through the
      counted constructor. Break `useChangedAtFormatter` into a pass-through and
      this is what fails.
    */
    expect(
      [...intlWatch.kernelZones],
      "The panel rendered without the club-time kernel building a formatter for " +
        `${CACHE_MISS_ZONE}, so the zero above is an accident of never being ` +
        `reached rather than a measurement (${intlWatch.total} construction(s) ` +
        "seen in total).",
    ).toContain(CACHE_MISS_ZONE);

    // …and the panel is genuinely rendering, so the assertion is not vacuous.
    expect(screen.getByLabelText("Time zone")).not.toBeNull();
  });

  it("persists nothing when a zone is merely selected", async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Change time zone/ }));

    fireEvent.change(screen.getByLabelText("Time zone"), {
      target: { value: "Pacific/Chatham" },
    });

    expect(putCalls()).toHaveLength(0);
    // The read-only heading still shows the SAVED zone, not the selection.
    expect(screen.getByTestId("current-club-time-zone").textContent).toBe(
      "Pacific/Auckland",
    );
  });

  it("keeps Save disabled until the acknowledgement is ticked", async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Change time zone/ }));
    fireEvent.change(screen.getByLabelText("Time zone"), {
      target: { value: "Pacific/Chatham" },
    });

    expect(saveButton().hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("checkbox"));

    expect(saveButton().hasAttribute("disabled")).toBe(false);
  });

  it("lets the club RECORD the zone it is already effectively on", async () => {
    // The state a fresh install and an upgraded one both arrive in: the answer is
    // coming from `TZ` or the shipped default, and recording it is the whole
    // point of CT-1 — so Save must not be disabled just because the zone on
    // screen is the one already displayed.
    fetchMock.mockImplementation(async (_u: unknown, init?: { method?: string }) =>
      init?.method === "PUT"
        ? respondWith({ ...SERVER_STATE, source: "persisted" })
        : respondWith({
            timeZone: "Pacific/Auckland",
            source: "environment",
            updatedAt: null,
            updatedByName: null,
            unusableStoredValue: null,
          }),
    );
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Change time zone/ }));
    fireEvent.click(screen.getByRole("checkbox"));

    expect(screen.queryByText(/is already the club time zone/)).toBeNull();
    expect(saveButton().hasAttribute("disabled")).toBe(false);

    fireEvent.click(saveButton());
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(JSON.parse(String(putCalls()[0][1].body))).toEqual({
      timeZone: "Pacific/Auckland",
      confirmed: true,
    });
  });

  it("always offers the configured zone, even when the filter excludes it", async () => {
    // ICU disagrees with itself across versions about canonical spellings, so a
    // stored zone can be missing from this runtime's list — and a filter can hide
    // it. Either way the <select> must still carry an option for its own value,
    // or it displays a zone the club is not on.
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Change time zone/ }));
    fireEvent.change(screen.getByLabelText("Find a time zone"), {
      target: { value: "reykjavik" },
    });

    const options = zoneOptions();
    expect(options).toContain("Pacific/Auckland");
    expect(options).toContain("Atlantic/Reykjavik");
    expect(
      (screen.getByLabelText("Time zone") as HTMLSelectElement).value,
    ).toBe("Pacific/Auckland");
  });

  it("keeps Save disabled when the chosen zone is the one already stored", async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Change time zone/ }));
    fireEvent.click(screen.getByRole("checkbox"));

    expect(saveButton().hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/is already the club time zone/)).not.toBeNull();
  });

  it("shows the current and chosen zone side by side, and what changing does", async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Change time zone/ }));
    fireEvent.change(screen.getByLabelText("Time zone"), {
      target: { value: "Pacific/Chatham" },
    });

    expect(screen.getByTestId("confirm-current-zone").textContent).toBe(
      "Pacific/Auckland",
    );
    expect(screen.getByTestId("confirm-chosen-zone").textContent).toBe(
      "Pacific/Chatham",
    );

    // The three consequences the acknowledgement is about, in plain English.
    expect(
      screen.getByText(/already recorded are not rewritten or moved/),
    ).not.toBeNull();
    expect(
      screen.getByText(/keep the calendar dates they already have/),
    ).not.toBeNull();
    /*
      AND CT-5 (#2869) MADE THE SECOND ONE TRUE. CT-1's version of this test
      asserted the opposite — that the panel says displayed times and scheduled
      jobs still follow the deployment's `TZ` — because at that point nothing
      read the setting. Emails, Xero document dates, the finance exports and
      every scheduled job now do, so the honest copy changed and so does this.

      Both legs are asserted the same way CT-1's were: the true sentence is
      present, and the sentence that is now an UNDERclaim is gone, so restoring
      the old "still follows TZ" wording reddens this test rather than passing.
    */
    expect(
      screen.getByText(/move to this zone straight away/),
    ).not.toBeNull();
    expect(
      screen.queryByText(
        /still follow the TZ setting this deployment starts with/,
      ),
    ).toBeNull();

    /*
      THE ONE THING THAT IS STILL TRUE, and was nowhere in the product before
      (#2869 review). `node-cron` reads a job's zone when the job is REGISTERED
      and never re-reads it, so a running job keeps the old zone until the
      application restarts. The documentation says so; this screen has to as
      well, because this is the screen where somebody makes that happen.
    */
    expect(screen.getByText(/until it is/)).not.toBeNull();
    expect(screen.getByText("restarted")).not.toBeNull();

    // And the changeover-hour warning, which a settable zone makes reachable.
    expect(
      screen.getByText(/one hour is skipped and one hour happens twice/),
    ).not.toBeNull();

    // The acknowledgement itself says what it is acknowledging.
    expect(
      screen.getByText(
        /does not move any date or time already recorded/,
      ),
    ).not.toBeNull();
    expect(
      screen.getByText(
        /scheduled jobs keep their current zone until the application is restarted/,
      ),
    ).not.toBeNull();
  });

  it("tells the truth about a stored value it cannot use, with the fix that works", async () => {
    /*
      The state this panel used to describe WRONGLY. A row exists whose zone does
      not validate, which the API reported as "environment", so the panel read
      "Nothing has been recorded yet... Restarting the app records it" directly
      above "Last changed 1 Jul 2026 by Ada Lovelace". Restarting can never
      record it: the boot backfill's presence check is row-level, so the bad row
      counts as present and the backfill is skipped for good. Saving here is the
      only repair, so that is what the screen has to say.
    */
    fetchMock.mockImplementation(async () =>
      respondWith({
        timeZone: "Pacific/Auckland",
        source: "persisted-unusable",
        updatedAt: SERVER_STATE.updatedAt,
        updatedByName: "Ada Lovelace",
        // A control character, because nothing validated this text on the way in.
        unusableStoredValue: "NZT\u0007",
      }),
    );
    await renderPanel();

    expect(screen.getByText("Not usable")).not.toBeNull();
    // It NAMES the value, made printable: "not usable" without saying WHICH
    // value is an instruction the operator cannot act on.
    expect(screen.getByText(/"NZT\?"/)).not.toBeNull();
    expect(
      screen.getByText(/Set the club's time zone again below/),
    ).not.toBeNull();
    expect(screen.queryByText(/Restarting the app records it/)).toBeNull();

    // And the repair is reachable: Save must not be disabled merely because the
    // fallback zone on screen is the one already selected.
    fireEvent.click(screen.getByRole("button", { name: /Change time zone/ }));
    fireEvent.click(screen.getByRole("checkbox"));
    expect(saveButton().hasAttribute("disabled")).toBe(false);
  });

  /*
    LAST CHANGED IS SPELLED IN THE ZONE THE SESSION IS RENDERING IN, which since
    CT-4 (#2870) is the club's PERSISTED zone carried by `ClubTimeProvider` — not
    the deployment's `TZ`, not the viewer's clock, and deliberately not the zone
    this panel's own fetch just returned.

    IT IS A PAIR, and the pair is the whole assertion. CT-1's version of this test
    compared the rendered line against `spelledIn(APP_TIME_ZONE, …)`, which was
    fine while both sides read the same environment constant and became a trap the
    moment the panel started reading the provider: on a host running
    `TZ=America/Denver` the expectation moved and the component did not, so the
    test failed against CORRECT code. Nothing here references `APP_TIME_ZONE` any
    more. Two provider zones, two answers, and an implementation that ignored the
    provider — reading the environment, the viewer's clock, the panel's own
    `state.timeZone`, or a hard-coded zone — gives one answer to both halves and
    fails whichever half disagrees with it.

    Denver, and behind UTC specifically, for the reason
    `club-time-client-boundary.test.tsx` sets out: `TZ` is unset on CI, so the host
    resolves UTC while `APP_TIME_ZONE` falls back to `Pacific/Auckland`, and a club
    zone AHEAD of UTC agrees with one or the other for most of the day.
  */
  const DENVER = "America/Denver";

  it("spells Last changed in the club's PERSISTED zone", async () => {
    // PREMISE, as an ANSWER rather than an identifier: the two zones really do
    // disagree about this instant. `expect(zone).not.toBe(DENVER)` would pass
    // happily under America/Chicago while the assertion beneath went vacuous.
    const inDenver = spelledIn(DENVER, SERVER_STATE.updatedAt);
    const inHarnessZone = spelledIn(CLUB_TIME_TEST_ZONE, SERVER_STATE.updatedAt);
    expect(inDenver).toBe("30 Jun 2026, 3:30 pm");
    expect(inHarnessZone).toBe("1 Jul 2026, 9:30 am");

    /*
      And the panel's OWN fetched value is a third answer again, so this half also
      refuses the tempting implementation where the screen spells its stamp in the
      zone it just loaded. `club-time-zone-panel.tsx` explains why it must not:
      that would make this one line jump ahead of every other admin screen for the
      rest of the session after a save.
    */
    fetchMock.mockImplementation(async () =>
      respondWith({ ...SERVER_STATE, timeZone: "Pacific/Honolulu" }),
    );
    await renderPanel(DENVER);

    const line = screen.getByText(/Last changed/);
    expect(line.textContent).toContain(inDenver);
    expect(line.textContent).not.toContain(inHarnessZone);
    expect(line.textContent).not.toContain(
      spelledIn("Pacific/Honolulu", SERVER_STATE.updatedAt),
    );
  });

  it("follows a DIFFERENT club zone for the same stamp", async () => {
    // The mirror image, and it is what makes the case above about the PROVIDER
    // rather than about a hard-coded June: the panel is not producing "30 Jun"
    // for some reason of its own.
    await renderPanel(CLUB_TIME_TEST_ZONE);

    const line = screen.getByText(/Last changed/);
    expect(line.textContent).toContain(
      spelledIn(CLUB_TIME_TEST_ZONE, SERVER_STATE.updatedAt),
    );
    expect(line.textContent).not.toContain(
      spelledIn(DENVER, SERVER_STATE.updatedAt),
    );
  });

  it("sends the chosen zone with an explicit confirmation, and shows the result", async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Change time zone/ }));
    fireEvent.change(screen.getByLabelText("Time zone"), {
      target: { value: "Pacific/Chatham" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(saveButton());

    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(JSON.parse(String(putCalls()[0][1].body))).toEqual({
      timeZone: "Pacific/Chatham",
      confirmed: true,
    });
    await waitFor(() =>
      expect(screen.getByTestId("current-club-time-zone").textContent).toBe(
        "Pacific/Chatham",
      ),
    );
    // Back to read-only, with the acknowledgement cleared for next time.
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("shows the server's refusal rather than pretending the change landed", async () => {
    fetchMock.mockImplementation(async (_url: unknown, init?: { method?: string }) =>
      init?.method === "PUT"
        ? {
            ok: false,
            json: async () => ({ error: "Nope, not a real timezone." }),
          }
        : respondWith(SERVER_STATE),
    );
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Change time zone/ }));
    fireEvent.change(screen.getByLabelText("Time zone"), {
      target: { value: "Pacific/Chatham" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(saveButton());

    await screen.findByText("Nope, not a real timezone.");
    expect(screen.getByTestId("current-club-time-zone").textContent).toBe(
      "Pacific/Auckland",
    );
  });

  it("filters the selector without narrowing what can be saved", async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Change time zone/ }));

    const before = zoneOptions().length;
    expect(before).toBeGreaterThan(300);

    fireEvent.change(screen.getByLabelText("Find a time zone"), {
      target: { value: "auckland" },
    });

    const after = zoneOptions();
    expect(after).toContain("Pacific/Auckland");
    expect(after.length).toBeLessThan(before);
  });
});
