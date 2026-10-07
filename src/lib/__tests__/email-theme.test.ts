import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWebsiteThemeRenderState: vi.fn(),
  warn: vi.fn(),
}));

// Mock only the theme loader. The real `club-theme-schema` is kept so the
// fallback assertions use the genuine site default palette.
vi.mock("@/lib/club-theme", () => ({
  getWebsiteThemeRenderState: mocks.getWebsiteThemeRenderState,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    warn: mocks.warn,
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  __resetEmailPaletteCacheForTests,
  emailPalette,
  ensureEmailPaletteReady,
  primeEmailPalette,
  renderEmailHtml,
  type EmailPalette,
} from "../email-theme";
import { passwordResetTemplate } from "@/lib/email-templates/account";
import { bookingConfirmedTemplate } from "@/lib/email-templates/booking";
import { membershipCancellationSubmittedTemplate } from "@/lib/email-templates/membership";
import { adminMembershipCancellationRequestTemplate } from "@/lib/email-templates/admin-membership";
import { adminNewBookingTemplate } from "@/lib/email-templates/admin-booking";
import {
  DEFAULT_CLUB_THEME_VALUES,
  deriveBrandShims,
  themeSeedsFromValues,
  type ClubThemeValues,
} from "../club-theme-schema";
import { buildThemeSubstrate } from "@/lib/theme/theme-substrate";
import { frozenTestNow, realElapsedMs } from "./helpers/clock";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

// The email palette is DERIVED from the three seeds via the light substrate
// (#2187 D7): gold/deep pass through, and charcoal/mist/snow/ridge are the
// neutral-ramp light steps (12/3/1/8). Compute the expectation the same way the
// module does, rather than hard-coding derived hexes that would silently drift
// if the generator retunes.
function expectedPalette(values: Pick<ClubThemeValues, "brandGold" | "brandDeep" | "brandSafety">): EmailPalette {
  const s = deriveBrandShims(values as ClubThemeValues);
  return {
    gold: s.gold,
    charcoal: s.charcoal,
    deep: s.deep,
    mist: s.mist,
    snow: s.snow,
    ridge: s.ridge,
  };
}

// Distinctive hex SEEDS that cannot be confused with any default palette entry.
const CUSTOM_THEME_VALUES = {
  brandGold: "#123456",
  brandDeep: "#0a0b0c",
  brandSafety: "#334455",
};

// The legacy hard-coded email gold that emails must no longer fall back to.
const LEGACY_EMAIL_GOLD = "#ffcb05";

/** A theme read that succeeded. */
function themeRead(values: typeof CUSTOM_THEME_VALUES) {
  return { values, readFailed: false };
}

/**
 * A theme read that FAILED. `getWebsiteThemeRenderState` never throws: it
 * swallows the database error and hands back the DEFAULT values with
 * `readFailed: true`. Reproducing that exact shape is the whole point — the
 * pre-#2900 code read only `values` and therefore cached the public default as
 * if the club had chosen it.
 */
function failedThemeRead() {
  return { values: DEFAULT_CLUB_THEME_VALUES, readFailed: true };
}

// Fixture arguments lifted from `support/email-render-cases.ts`, so these
// renders exercise the same shapes the render-coverage gate does.
const BOOKING_FIXTURE = () =>
  bookingConfirmedTemplate(
    "Ada",
    new Date("2026-07-04T00:00:00.000Z"),
    new Date("2026-07-06T00:00:00.000Z"),
    3,
    30000,
    CLUB_FORMAT_TEST,
    { paymentDue: { reference: "TKC-0001", invoiceEmailed: false } },
  );
const MEMBERSHIP_FIXTURE = () =>
  membershipCancellationSubmittedTemplate({
    firstName: "Ada",
    participantSummary: "Ada Lovelace",
    reviewUrl: "https://example.test/review",
  });
const ADMIN_ALERT_FIXTURE = () =>
  adminNewBookingTemplate({
    memberName: "Ada Lovelace",
    checkIn: new Date("2026-07-04T00:00:00.000Z"),
    checkOut: new Date("2026-07-06T00:00:00.000Z"),
    guestCount: 3,
    totalCents: 30000,
    status: "CONFIRMED",
  }, CLUB_FORMAT_TEST);

describe("email-theme palette cache", () => {
  beforeEach(() => {
    __resetEmailPaletteCacheForTests();
    mocks.getWebsiteThemeRenderState.mockReset();
    mocks.warn.mockReset();
  });

  afterEach(() => {
    // Two suites below wind the frozen clock forward to step past a cooldown.
    // Put it back so the next test starts from the shared frozen instant.
    vi.setSystemTime(frozenTestNow());
  });

  it("derives the email palette from the light substrate after priming", async () => {
    mocks.getWebsiteThemeRenderState.mockResolvedValue(
      themeRead(CUSTOM_THEME_VALUES),
    );

    await primeEmailPalette();

    const palette = emailPalette();
    expect(palette).toEqual(expectedPalette(CUSTOM_THEME_VALUES));

    // D7: the neutral roles are the LIGHT-mode generated steps, not literals.
    // `snow` is neutral step 1 (index 0) of the light substrate.
    const lightSnow = buildThemeSubstrate(
      themeSeedsFromValues(CUSTOM_THEME_VALUES as ClubThemeValues),
      "light",
    ).neutralHex[0];
    expect(palette.snow).toBe(lightSnow);
    // The two direct seed roles pass through verbatim.
    expect(palette.gold).toBe("#123456");
    expect(palette.deep).toBe("#0a0b0c");
  });

  it("renders templates with the custom club-theme colours after priming", async () => {
    mocks.getWebsiteThemeRenderState.mockResolvedValue(
      themeRead(CUSTOM_THEME_VALUES),
    );

    await primeEmailPalette();

    const p = expectedPalette(CUSTOM_THEME_VALUES);
    const html = passwordResetTemplate("Jo");
    // Header bar (charcoal) + accent/button (gold) prove the theme drives the email.
    expect(html).toContain(p.charcoal);
    expect(html).toContain(p.gold);
    // The default gold must not leak through when a custom theme is loaded.
    expect(html).not.toContain(DEFAULT_CLUB_THEME_VALUES.brandGold);
    expect(html).not.toContain(LEGACY_EMAIL_GOLD);
  });

  it("reflects a colour-scheme change on the next prime so emails drop the old colours (#1912)", async () => {
    // Cache warmed with an initial custom scheme (as a running server would be).
    mocks.getWebsiteThemeRenderState.mockResolvedValueOnce(
      themeRead(CUSTOM_THEME_VALUES),
    );
    await primeEmailPalette();
    expect(passwordResetTemplate("Jo")).toContain("#123456");

    // Admin saves a new scheme; the save path re-primes the palette.
    const NEXT_THEME_VALUES = {
      ...CUSTOM_THEME_VALUES,
      brandGold: "#0f9d58",
      brandDeep: "#202124",
    };
    mocks.getWebsiteThemeRenderState.mockResolvedValueOnce(
      themeRead(NEXT_THEME_VALUES),
    );
    await primeEmailPalette();

    const html = passwordResetTemplate("Jo");
    expect(html).toContain("#0f9d58"); // new accent/button colour (gold seed)
    expect(html).toContain("#202124"); // new body-text colour (deep seed)
    expect(html).not.toContain("#123456"); // previous scheme's gold is gone
    expect(html).not.toContain(DEFAULT_CLUB_THEME_VALUES.brandGold);
  });

  it("does not let a stale in-flight background refresh clobber a save-time prime (#1912)", async () => {
    const OLD_THEME_VALUES = CUSTOM_THEME_VALUES; // gold #123456
    const NEW_THEME_VALUES = {
      ...CUSTOM_THEME_VALUES,
      brandGold: "#0f9d58",
      brandDeep: "#202124",
    };

    // A deferred result so we control exactly when the background refresh's OLD
    // read resolves (i.e. keep it in flight while the prime lands).
    let releaseOldRefresh!: () => void;
    const oldRefreshResult = new Promise<ReturnType<typeof themeRead>>(
      (resolve) => {
        releaseOldRefresh = () => resolve(themeRead(OLD_THEME_VALUES));
      },
    );

    mocks.getWebsiteThemeRenderState
      // 1st call: the TTL-triggered background refresh reads the OLD scheme, but
      // its promise stays pending until we release it below.
      .mockReturnValueOnce(oldRefreshResult)
      // 2nd call: the save-time prime reads the NEW scheme and resolves at once.
      .mockResolvedValueOnce(themeRead(NEW_THEME_VALUES));

    // Cold cache (cachedAt = 0) => this trips the TTL and starts a background
    // refresh, which is now parked awaiting the deferred OLD read.
    emailPalette();

    // The admin save re-primes with the NEW scheme while the OLD refresh is
    // still in flight. The prime reads NEW and writes the cache.
    await primeEmailPalette();
    expect(emailPalette().gold).toBe("#0f9d58");

    // Now the stale background refresh finally resolves with the OLD scheme. It
    // started BEFORE the prime, so it must not overwrite the prime's palette.
    releaseOldRefresh();
    await oldRefreshResult;
    await Promise.resolve(); // flush the refresh's post-await continuation

    const html = passwordResetTemplate("Jo");
    expect(html).toContain("#0f9d58"); // NEW accent/button preserved
    expect(html).toContain("#202124"); // NEW body-text colour preserved
    expect(html).not.toContain("#123456"); // stale OLD gold did NOT clobber
    expect(emailPalette().gold).toBe("#0f9d58");
  });

  it("serves cached values within the TTL without re-hitting the loader", async () => {
    mocks.getWebsiteThemeRenderState.mockResolvedValue(
      themeRead(CUSTOM_THEME_VALUES),
    );

    await primeEmailPalette();
    expect(mocks.getWebsiteThemeRenderState).toHaveBeenCalledTimes(1);

    // Repeated reads inside the TTL window return the cached palette and must
    // not trigger another loader call.
    expect(emailPalette().gold).toBe("#123456");
    expect(emailPalette().gold).toBe("#123456");
    expect(mocks.getWebsiteThemeRenderState).toHaveBeenCalledTimes(1);
  });
});

describe("email render gate (#2900)", () => {
  beforeEach(() => {
    // A short load timeout so the timeout case does not cost five real seconds.
    // Only `Date` is faked in this repo's frozen clock, so `setTimeout` is real.
    __resetEmailPaletteCacheForTests({ loadTimeoutMs: 50 });
    mocks.getWebsiteThemeRenderState.mockReset();
    mocks.warn.mockReset();
  });

  afterEach(() => {
    vi.setSystemTime(frozenTestNow());
  });

  it("renders the FIRST email of a cold process with the club's saved theme", async () => {
    // This is the deliberate reversal of the pre-#2900 expectation. The old
    // test asserted that a cold render uses the public default palette, which
    // pinned the bug this issue reports: a fresh process or replica sent its
    // first email in the wrong brand and the next one, a minute later, in the
    // right one. Nothing primes the palette here — the gate loads it.
    mocks.getWebsiteThemeRenderState.mockResolvedValue(
      themeRead(CUSTOM_THEME_VALUES),
    );

    const html = await renderEmailHtml(() => passwordResetTemplate("Jo"));

    const p = expectedPalette(CUSTOM_THEME_VALUES);
    expect(html).toContain(p.gold);
    expect(html).toContain(p.charcoal);
    expect(html).not.toContain(DEFAULT_CLUB_THEME_VALUES.brandGold);
    expect(html).not.toContain(LEGACY_EMAIL_GOLD);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("loads the theme at render time after the boot prime failed", async () => {
    mocks.getWebsiteThemeRenderState
      // Boot instrumentation primes while the database is still unreachable.
      .mockResolvedValueOnce(failedThemeRead())
      // By the time the first email is rendered the read succeeds.
      .mockResolvedValue(themeRead(CUSTOM_THEME_VALUES));

    await primeEmailPalette();
    // A failed prime must NOT be mistaken for a loaded palette, and must not
    // arm the cooldown either — the very next render still tries.
    expect(emailPalette().gold).toBe(DEFAULT_CLUB_THEME_VALUES.brandGold);

    const html = await renderEmailHtml(() => passwordResetTemplate("Jo"));
    expect(html).toContain(expectedPalette(CUSTOM_THEME_VALUES).gold);
    expect(html).not.toContain(DEFAULT_CLUB_THEME_VALUES.brandGold);
  });

  it("gives two messages from one workflow the same palette", async () => {
    // The reported symptom: a membership cancellation sends the member's
    // confirmation and the officer's alert about a minute apart, and the two
    // arrived in different brands.
    mocks.getWebsiteThemeRenderState.mockResolvedValue(
      themeRead(CUSTOM_THEME_VALUES),
    );

    const memberHtml = await renderEmailHtml(MEMBERSHIP_FIXTURE);
    const officerHtml = await renderEmailHtml(() =>
      adminMembershipCancellationRequestTemplate({
        requesterName: "Ada Lovelace",
        participantSummary: "Ada Lovelace",
        reviewUrl: "https://example.test/review",
      }),
    );

    const p = expectedPalette(CUSTOM_THEME_VALUES);
    expect(memberHtml).toContain(p.gold);
    expect(officerHtml).toContain(p.gold);
    expect(memberHtml).not.toContain(DEFAULT_CLUB_THEME_VALUES.brandGold);
    expect(officerHtml).not.toContain(DEFAULT_CLUB_THEME_VALUES.brandGold);
  });

  it("colours a cold booking, membership and admin-alert render from the saved theme", async () => {
    mocks.getWebsiteThemeRenderState.mockResolvedValue(
      themeRead(CUSTOM_THEME_VALUES),
    );
    const p = expectedPalette(CUSTOM_THEME_VALUES);

    for (const build of [BOOKING_FIXTURE, MEMBERSHIP_FIXTURE, ADMIN_ALERT_FIXTURE]) {
      __resetEmailPaletteCacheForTests({ loadTimeoutMs: 50 });
      const html = await renderEmailHtml(build);
      // All three go through the shared standard layout, so the header bar and
      // the accent prove the shell itself was themed.
      expect(html).toContain(p.charcoal);
      expect(html).toContain(p.gold);
      expect(html).not.toContain(DEFAULT_CLUB_THEME_VALUES.brandGold);
    }
  });

  it("collapses concurrent cold renders onto ONE theme read", async () => {
    let release!: () => void;
    const deferred = new Promise<ReturnType<typeof themeRead>>((resolve) => {
      release = () => resolve(themeRead(CUSTOM_THEME_VALUES));
    });
    mocks.getWebsiteThemeRenderState.mockReturnValue(deferred);

    const first = renderEmailHtml(() => passwordResetTemplate("A"));
    const second = renderEmailHtml(() => passwordResetTemplate("B"));
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(mocks.getWebsiteThemeRenderState).toHaveBeenCalledTimes(1);
    const p = expectedPalette(CUSTOM_THEME_VALUES);
    expect(a).toContain(p.gold);
    expect(b).toContain(p.gold);
  });

  it("reports the built-in default honestly when the theme store cannot be read", async () => {
    mocks.getWebsiteThemeRenderState.mockResolvedValue(failedThemeRead());

    const readiness = await ensureEmailPaletteReady();
    expect(readiness.source).toBe("built-in-default");

    const html = await renderEmailHtml(() => passwordResetTemplate("Jo"));
    // The fallback is the SITE default, never the legacy hard-coded email gold.
    expect(html).toContain(DEFAULT_CLUB_THEME_VALUES.brandGold);
    expect(html).toContain("#57b3ab");
    expect(html).not.toContain(LEGACY_EMAIL_GOLD);

    // And it says so, rather than passing the default off as the club's choice.
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(mocks.warn.mock.calls[0][1]).toContain(
      "could not be read",
    );
  });

  it("does not cache the built-in default as if it were the club's theme", async () => {
    mocks.getWebsiteThemeRenderState.mockResolvedValue(failedThemeRead());
    await renderEmailHtml(() => passwordResetTemplate("Jo"));

    // The failed read must not have warmed the cache: once the store comes back
    // the very next attempt applies the real theme, rather than serving the
    // default for a whole TTL.
    vi.setSystemTime(new Date(frozenTestNow().getTime() + 31_000));
    mocks.getWebsiteThemeRenderState.mockResolvedValue(
      themeRead(CUSTOM_THEME_VALUES),
    );

    const html = await renderEmailHtml(() => passwordResetTemplate("Jo"));
    expect(html).toContain(expectedPalette(CUSTOM_THEME_VALUES).gold);
    expect(html).not.toContain(DEFAULT_CLUB_THEME_VALUES.brandGold);
  });

  it("does not re-read the theme for every email while the store is down", async () => {
    mocks.getWebsiteThemeRenderState.mockResolvedValue(failedThemeRead());

    await renderEmailHtml(() => passwordResetTemplate("1"));
    await renderEmailHtml(() => passwordResetTemplate("2"));
    await renderEmailHtml(() => passwordResetTemplate("3"));

    // One attempt for the burst, not one per message, and one warning rather
    // than a log flood.
    expect(mocks.getWebsiteThemeRenderState).toHaveBeenCalledTimes(1);
    expect(mocks.warn).toHaveBeenCalledTimes(1);

    // Past the cooldown it tries again.
    vi.setSystemTime(new Date(frozenTestNow().getTime() + 31_000));
    await renderEmailHtml(() => passwordResetTemplate("4"));
    expect(mocks.getWebsiteThemeRenderState).toHaveBeenCalledTimes(2);
  });

  it("does not let a wedged theme read hold an email open forever", async () => {
    // A read that never settles: email must still go out, bounded by the gate's
    // own timeout, on the built-in default.
    mocks.getWebsiteThemeRenderState.mockReturnValue(new Promise(() => {}));

    const html = await renderEmailHtml(() => passwordResetTemplate("Jo"));

    expect(html).toContain(DEFAULT_CLUB_THEME_VALUES.brandGold);
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(mocks.warn.mock.calls[0][0]).toEqual({ reason: "read-timeout" });
  });

  it("charges only the FIRST email of a cooldown window the wait, even when the read is wedged", async () => {
    // The case the cooldown exists for, and the one it used to miss. A read that
    // TIMED OUT has by definition not settled, so it is still in flight — a
    // cooldown that only engaged once `inFlightLoad` was null therefore skipped
    // itself in exactly this scenario and charged every email a fresh full
    // timeout. `notices-email.ts` awaits the gate inside a sequential
    // per-recipient loop, so on a 300-member notice publish that is the
    // difference between one 5s wait and most of an hour.
    //
    // A LONGER load timeout than the rest of this suite, deliberately: the
    // measurement has to separate "waited a full timeout" from "did not wait",
    // and at 50ms the two are only 50ms apart — close enough that a busy Windows
    // CI box can put the fast case over the line. At 300ms each verdict has
    // roughly a 3x margin, and only the first email pays it, so the test costs
    // 300ms once rather than per assertion.
    __resetEmailPaletteCacheForTests({ loadTimeoutMs: 300 });
    mocks.getWebsiteThemeRenderState.mockReturnValue(new Promise(() => {}));

    const firstStartedNs = process.hrtime.bigint();
    await renderEmailHtml(() => passwordResetTemplate("1"));
    const firstWaitMs = realElapsedMs(firstStartedNs);

    const secondStartedNs = process.hrtime.bigint();
    await renderEmailHtml(() => passwordResetTemplate("2"));
    const secondWaitMs = realElapsedMs(secondStartedNs);
    const thirdStartedNs = process.hrtime.bigint();
    await renderEmailHtml(() => passwordResetTemplate("3"));
    const thirdWaitMs = realElapsedMs(thirdStartedNs);

    // The first email really did wait (otherwise the assertions below would pass
    // vacuously off a gate that never waits at all).
    expect(firstWaitMs).toBeGreaterThanOrEqual(250);
    // The next two did not.
    expect(secondWaitMs).toBeLessThan(100);
    expect(thirdWaitMs).toBeLessThan(100);

    // Still one read for the whole burst, and one warning rather than a flood.
    expect(mocks.getWebsiteThemeRenderState).toHaveBeenCalledTimes(1);
    expect(mocks.warn).toHaveBeenCalledTimes(1);
  });

  it("lets a wedged read that finally lands lift the cooldown and brand the next email", async () => {
    // The cooldown must not outlive the outage. The read is never cancelled, so
    // when it settles late it still commits — and the next email is correctly
    // branded immediately, not thirty seconds later.
    let release!: () => void;
    const wedged = new Promise<ReturnType<typeof themeRead>>((resolve) => {
      release = () => resolve(themeRead(CUSTOM_THEME_VALUES));
    });
    mocks.getWebsiteThemeRenderState.mockReturnValue(wedged);

    const timedOutHtml = await renderEmailHtml(() => passwordResetTemplate("1"));
    expect(timedOutHtml).toContain(DEFAULT_CLUB_THEME_VALUES.brandGold);

    // Second email during the cooldown: still the default, and no new read.
    const cooledHtml = await renderEmailHtml(() => passwordResetTemplate("2"));
    expect(cooledHtml).toContain(DEFAULT_CLUB_THEME_VALUES.brandGold);
    expect(mocks.getWebsiteThemeRenderState).toHaveBeenCalledTimes(1);

    // The parked read lands. The clock has NOT moved, so nothing but the late
    // commit can be what unblocks the next email.
    release();
    await wedged;
    await Promise.resolve();
    await Promise.resolve();

    const brandedHtml = await renderEmailHtml(() => passwordResetTemplate("3"));
    expect(brandedHtml).toContain(expectedPalette(CUSTOM_THEME_VALUES).gold);
    expect(brandedHtml).not.toContain(DEFAULT_CLUB_THEME_VALUES.brandGold);
    expect((await ensureEmailPaletteReady()).source).toBe("club-theme");
  });

  it("still sends when the logger itself throws on the unreadable-theme path", async () => {
    // `ensureEmailPaletteReady` is documented as never throwing, and it is now
    // awaited on every send path — `sendEmail()` awaits it as its first
    // statement, before any EmailLog row exists. So a logger fault here would
    // lose the email outright, and a per-recipient `catch` (notices-email.ts)
    // would swallow it, leaving nothing for the retry cron. This lane already met
    // that shape for real: a logger mock without a `warn` member made the
    // warning throw and a notice silently emailed nobody.
    mocks.getWebsiteThemeRenderState.mockResolvedValue(failedThemeRead());
    mocks.warn.mockImplementation(() => {
      throw new Error("log transport is down");
    });

    const readiness = await ensureEmailPaletteReady();
    expect(readiness.source).toBe("built-in-default");

    const html = await renderEmailHtml(() => passwordResetTemplate("Jo"));
    expect(html).toContain(DEFAULT_CLUB_THEME_VALUES.brandGold);

    // And the throttle stamp was taken before the throwing call, so a broken
    // logger cannot turn into one attempted warning per email either.
    expect(mocks.warn).toHaveBeenCalledTimes(1);
  });

  it("does not report a read failure for a read a NEWER read overtook", async () => {
    // Cold process. The gate's own read gets valid club values, but a Site Style
    // save primes in the meantime. Discarding the gate's result on the grounds
    // that a newer read had STARTED left the palette unloaded, so the gate
    // reported `built-in-default`, warned that the theme was unreadable — which
    // the operator guide tells clubs to read as a database fault — and sent that
    // email in the shipped default brand, from a read that succeeded.
    let releaseGateRead!: () => void;
    const gateRead = new Promise<ReturnType<typeof themeRead>>((resolve) => {
      releaseGateRead = () => resolve(themeRead(CUSTOM_THEME_VALUES));
    });
    const NEXT_THEME_VALUES = {
      ...CUSTOM_THEME_VALUES,
      brandGold: "#0f9d58",
      brandDeep: "#202124",
    };
    let releasePrimeRead!: () => void;
    const primeRead = new Promise<ReturnType<typeof themeRead>>((resolve) => {
      releasePrimeRead = () => resolve(themeRead(NEXT_THEME_VALUES));
    });
    mocks.getWebsiteThemeRenderState
      .mockReturnValueOnce(gateRead)
      .mockReturnValueOnce(primeRead);

    const emailPromise = renderEmailHtml(() => passwordResetTemplate("Jo"));
    // The save's prime starts while the gate's read is still parked, so it takes
    // the higher write token.
    const primePromise = primeEmailPalette();

    releaseGateRead();
    const html = await emailPromise;

    // The gate's read succeeded, so this email carries the club's colours and no
    // warning was logged.
    expect(html).toContain(expectedPalette(CUSTOM_THEME_VALUES).gold);
    expect(html).not.toContain(DEFAULT_CLUB_THEME_VALUES.brandGold);
    expect(mocks.warn).not.toHaveBeenCalled();

    // The newer read still wins when it lands.
    releasePrimeRead();
    await primePromise;
    expect(emailPalette().gold).toBe("#0f9d58");
  });

  it("does not let a failed TTL refresh suppress the next attempt for a whole TTL", async () => {
    mocks.getWebsiteThemeRenderState.mockResolvedValueOnce(
      themeRead(CUSTOM_THEME_VALUES),
    );
    await renderEmailHtml(() => passwordResetTemplate("1"));
    expect(mocks.getWebsiteThemeRenderState).toHaveBeenCalledTimes(1);

    // The TTL lapses and the background refresh fails. It stamps `cachedAt`
    // up-front to collapse a burst into one read, so on failure it must roll that
    // stamp back — otherwise the next attempt is a full five minutes away rather
    // than the thirty seconds the failure cooldown advertises, and an admin who
    // recoloured the site during a brief blip waits ten minutes for emails.
    mocks.getWebsiteThemeRenderState.mockResolvedValueOnce(failedThemeRead());
    vi.setSystemTime(new Date(frozenTestNow().getTime() + 6 * 60 * 1000));
    await renderEmailHtml(() => passwordResetTemplate("2"));
    expect(mocks.getWebsiteThemeRenderState).toHaveBeenCalledTimes(2);

    // Inside the failure cooldown, no further read: the rollback is only safe
    // because the cooldown is armed with it.
    vi.setSystemTime(new Date(frozenTestNow().getTime() + 6 * 60 * 1000 + 5_000));
    await renderEmailHtml(() => passwordResetTemplate("3"));
    expect(mocks.getWebsiteThemeRenderState).toHaveBeenCalledTimes(2);

    // Past the cooldown — well short of another TTL — it tries again and the
    // club's new colours land.
    const NEXT_THEME_VALUES = {
      ...CUSTOM_THEME_VALUES,
      brandGold: "#0f9d58",
    };
    mocks.getWebsiteThemeRenderState.mockResolvedValue(
      themeRead(NEXT_THEME_VALUES),
    );
    vi.setSystemTime(new Date(frozenTestNow().getTime() + 6 * 60 * 1000 + 31_000));
    await renderEmailHtml(() => passwordResetTemplate("4"));
    expect(mocks.getWebsiteThemeRenderState).toHaveBeenCalledTimes(3);
    expect(emailPalette().gold).toBe("#0f9d58");
  });

  it("does no I/O once the palette has been loaded", async () => {
    mocks.getWebsiteThemeRenderState.mockResolvedValue(
      themeRead(CUSTOM_THEME_VALUES),
    );

    await renderEmailHtml(() => passwordResetTemplate("1"));
    expect(mocks.getWebsiteThemeRenderState).toHaveBeenCalledTimes(1);

    await renderEmailHtml(() => passwordResetTemplate("2"));
    await renderEmailHtml(() => passwordResetTemplate("3"));
    expect(mocks.getWebsiteThemeRenderState).toHaveBeenCalledTimes(1);
    expect((await ensureEmailPaletteReady()).source).toBe("club-theme");
  });

  it("keeps the last-good club palette when a later refresh cannot read the theme", async () => {
    mocks.getWebsiteThemeRenderState.mockResolvedValueOnce(
      themeRead(CUSTOM_THEME_VALUES),
    );
    await renderEmailHtml(() => passwordResetTemplate("1"));

    // The TTL lapses and the background refresh fails. The club's colours must
    // survive: reverting to the shipped default would be a visible rebrand
    // triggered by a transient database fault.
    mocks.getWebsiteThemeRenderState.mockResolvedValue(failedThemeRead());
    vi.setSystemTime(new Date(frozenTestNow().getTime() + 6 * 60 * 1000));

    const html = await renderEmailHtml(() => passwordResetTemplate("2"));
    expect(html).toContain(expectedPalette(CUSTOM_THEME_VALUES).gold);
  });
});
