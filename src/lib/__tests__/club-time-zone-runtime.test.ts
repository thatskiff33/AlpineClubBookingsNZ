import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { captureHostTimeZone } from "@/lib/__tests__/helpers/timezone";

/**
 * The club timezone reader a CLI can also reach (CT-5, #2869; epic #2988).
 *
 * The property under test is not "it answers" — it always did — but that it can
 * SAY WHERE ITS ANSWER CAME FROM, and that a read which FAILED is not silently
 * indistinguishable from a club that has never configured a zone. Those calls
 * now date financial records, so a fallback that looks like a choice is the
 * defect (#2869 review).
 */

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    clubTimeSettings: { findUnique: mocks.findUnique },
  },
}));

vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: mocks.warn, error: vi.fn(), debug: vi.fn() },
}));

const hostTimeZone = captureHostTimeZone();

beforeEach(async () => {
  mocks.findUnique.mockReset();
  mocks.warn.mockReset();
  const { __resetClubTimeZoneRuntimeWarningForTests } = await import(
    "@/lib/club-time-zone-runtime"
  );
  __resetClubTimeZoneRuntimeWarningForTests();
});

afterEach(() => {
  hostTimeZone.restore();
});

describe("resolveClubTimeZoneOutsideRequest", () => {
  it("reports a persisted zone as persisted, and it beats the environment", async () => {
    const { resolveClubTimeZoneOutsideRequest } = await import(
      "@/lib/club-time-zone-runtime"
    );
    mocks.findUnique.mockResolvedValue({ timeZone: "Pacific/Chatham" });
    process.env.TZ = "America/Denver";

    const resolution = await resolveClubTimeZoneOutsideRequest();

    expect(resolution).toEqual({
      zone: "Pacific/Chatham",
      source: "persisted",
      readFailed: false,
    });
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("reports the environment seed as a fallback, not as the club's choice", async () => {
    const { resolveClubTimeZoneOutsideRequest } = await import(
      "@/lib/club-time-zone-runtime"
    );
    mocks.findUnique.mockResolvedValue(null);
    process.env.TZ = "America/Denver";

    const resolution = await resolveClubTimeZoneOutsideRequest();

    expect(resolution).toEqual({
      zone: "America/Denver",
      source: "environment-seed",
      readFailed: false,
    });
    // An absent row is a configuration state, not an incident: the setup
    // checklist and the admin panel already say so, and a per-call log line
    // here would be noise on every deployment that has not finished setup.
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("reports the documented default when the seed names no place", async () => {
    // The `TZ=UTC` class: CT-1 refuses to record it, so nothing is persisted and
    // the resolver falls all the way through. This is the one deployment shape
    // whose civil time MOVES on the release that lands CT-5.
    const { resolveClubTimeZoneOutsideRequest } = await import(
      "@/lib/club-time-zone-runtime"
    );
    mocks.findUnique.mockResolvedValue(null);
    process.env.TZ = "UTC";

    const resolution = await resolveClubTimeZoneOutsideRequest();

    expect(resolution).toEqual({
      zone: "Pacific/Auckland",
      source: "default",
      readFailed: false,
    });
  });

  it("distinguishes a FAILED read from an absent row, and logs it", async () => {
    /*
      The case the previous version folded away. `readPersistedClubTimeZoneRow`
      caught its own error and returned `null`, which is also what an absent row
      returns — so a database blip during an invoice write dated the document in
      the fallback zone with nothing anywhere to say so. The zone still answers
      (refusing would take invoicing offline for a blip), but the failure is
      reported.
    */
    const { resolveClubTimeZoneOutsideRequest } = await import(
      "@/lib/club-time-zone-runtime"
    );
    mocks.findUnique.mockRejectedValue(new Error("connection terminated"));
    process.env.TZ = "America/Denver";

    const resolution = await resolveClubTimeZoneOutsideRequest();

    expect(resolution.readFailed).toBe(true);
    expect(resolution.zone).toBe("America/Denver");
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(mocks.warn.mock.calls[0][0]).toMatchObject({
      scope: "club-time-zone",
      fallbackTimeZone: "America/Denver",
    });
  });

  it("throttles the failure warning, so an outage cannot flood the log", async () => {
    // Every Xero document date reads this. One warning per minute is a signal;
    // one per invoice line is a denial of service on the operator's own log.
    const { resolveClubTimeZoneOutsideRequest } = await import(
      "@/lib/club-time-zone-runtime"
    );
    mocks.findUnique.mockRejectedValue(new Error("connection terminated"));

    for (let index = 0; index < 20; index += 1) {
      await resolveClubTimeZoneOutsideRequest();
    }

    expect(mocks.warn).toHaveBeenCalledTimes(1);
  });

  it("never throws, so a cron tick or a CLI cannot die on a database blip", async () => {
    const { readClubTimeZoneOutsideRequest } = await import(
      "@/lib/club-time-zone-runtime"
    );
    mocks.findUnique.mockRejectedValue(new Error("connection terminated"));

    await expect(readClubTimeZoneOutsideRequest()).resolves.toBeTypeOf("string");
  });
});

describe("readPersistedClubTimeZoneOutsideRequest", () => {
  it("answers null rather than substituting the environment seed", async () => {
    // The `readFailed` trap: a caller that must not present a fallback as the
    // club's own choice — the email zone cache — depends on this being `null`.
    const { readPersistedClubTimeZoneOutsideRequest } = await import(
      "@/lib/club-time-zone-runtime"
    );
    process.env.TZ = "America/Denver";

    mocks.findUnique.mockResolvedValue(null);
    await expect(readPersistedClubTimeZoneOutsideRequest()).resolves.toBeNull();

    mocks.findUnique.mockRejectedValue(new Error("db down"));
    await expect(readPersistedClubTimeZoneOutsideRequest()).resolves.toBeNull();

    // And a stored value that is not a usable named zone is equally not one.
    mocks.findUnique.mockResolvedValue({ timeZone: "NZST" });
    await expect(readPersistedClubTimeZoneOutsideRequest()).resolves.toBeNull();
  });
});
