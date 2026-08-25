import fs from "node:fs";
import path from "node:path";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

import {
  CLUB_TIME_GUARD_ARMS,
  ENVIRONMENT_ZONE_ADAPTERS,
  SRC_RESTRICTION_EXEMPTIONS,
} from "../../../eslint.config.mjs";
import {
  auditEnforcedGuardCoverage,
  auditResolvedGuardCoverage,
  PRODUCTION_GUARD_ROSTER,
} from "./support/eslint-guard-coverage";

/**
 * CT-6 (#2991) — the two Club Time recurrence paths, guarded mechanically.
 *
 * ## What this file is for
 *
 * The epic removed a few hundred call sites that took a civil-time answer from
 * somewhere other than the club's persisted timezone. Removing them is only half
 * the job: the epic's own definition of done says "new hand-rolled temporal
 * bypasses fail mechanically", because every one of those call sites was written
 * by somebody who did not know a rule existed. Two of the classes were guarded
 * by nothing at all until this issue:
 *
 * - **the HOST's clock face** — `.getDate()` and its family, which answer in
 *   whatever zone the container runs in. A `@db.Date` lodge night is UTC
 *   midnight, so west of Greenwich reading one back this way returns the
 *   PREVIOUS day. #3082 priced a boundary birthday a year young that way and
 *   #3100 built a stay expander that never terminated;
 * - **the ENVIRONMENT's zone** — `process.env.TZ`, `NEXT_PUBLIC_TZ`, and the
 *   `APP_TIME_ZONE` those two feed. Since CT-1 (#2989) the club's civil time is
 *   the persisted `ClubTimeSettings.timeZone` row (`INV-CONFIG-002`); the
 *   environment SEEDS that row at setup and has no say afterwards.
 *
 * ## Why the assertions are shaped the way they are
 *
 * A guard suite can pass while guarding nothing, and this epic has produced four
 * distinct ways for that to happen. So every claim here is made twice, from
 * opposite directions:
 *
 * 1. **resolved** — ask ESLint what `no-restricted-syntax` IS at a roster of
 *    representative production paths, and check every arm survived. This is what
 *    catches a block that lifts one rule and takes the rest down with it, since
 *    flat config REPLACES a rule's options rather than merging them;
 * 2. **enforced** — actually lint code containing the banned shape at each of
 *    those paths and check an error comes back carrying the intended invariant
 *    id. A selector can resolve correctly and still match nothing.
 *
 * The pair matters because they fail differently. A wrong selector passes (1)
 * and fails (2); a lifted block passes (2) at the paths it does not cover and
 * fails (1) everywhere. Neither alone is evidence.
 *
 * The control that stops (2) from being vacuous is the CLEAN sample: the same
 * lint run over code that does the same job correctly must report nothing. A
 * known-bad that fails proves a rule exists; only a known-good that passes
 * proves the rule is about what it claims to be about.
 */

const ROOT = path.resolve(__dirname, "../../..");

/**
 * Reading a `@db.Date` value back through the host's clock face — the exact
 * shape of #3082 and #3100.
 */
const HOST_CLOCK_VIOLATION = `
const lodgeNight = new Date("2026-08-01T00:00:00.000Z");
export const dayOfMonth = lodgeNight.getDate();
`;

/**
 * The same job done correctly: a calendar day read out of the value's own UTC
 * frame, which is what a `@db.Date` column stores. This must lint CLEAN, or the
 * arm above is banning `Date` rather than banning the host's clock.
 */
const HOST_CLOCK_CONTROL = `
const lodgeNight = new Date("2026-08-01T00:00:00.000Z");
export const dayOfMonth = lodgeNight.getUTCDate();
`;

/** Taking the environment's zone as civil-time authority. */
const ENVIRONMENT_ZONE_VIOLATION = `
export const zone = process.env.TZ ?? "Pacific/Auckland";
`;

/**
 * The control for it. Reading a DIFFERENT environment variable must stay clean:
 * the arm is about the timezone specifically, not about `process.env`.
 */
const ENVIRONMENT_ZONE_CONTROL = `
export const locale = process.env.LOCALE ?? "en-NZ";
`;

/** Importing the environment's zone by name, the second spelling of the same claim. */
const ENVIRONMENT_ZONE_IMPORT_VIOLATION = `
import { APP_TIME_ZONE } from "@/config/operational";
export const zone = APP_TIME_ZONE;
`;

/**
 * Its control: the OTHER exports of that module are ordinary configuration and
 * must stay importable, or the arm is banning a module instead of banning the
 * environment's claim about civil time.
 */
const ENVIRONMENT_ZONE_IMPORT_CONTROL = `
import { APP_CURRENCY, APP_LOCALE } from "@/config/operational";
export const money = APP_CURRENCY + APP_LOCALE;
`;

const HOST_CLOCK_PREFIX = "INV-DATE-014 / INV-CONFIG-002";
const ENVIRONMENT_ZONE_PREFIX = "INV-CONFIG-002";

/**
 * The files the shipped config lifts the environment-zone group from, read out
 * of `SRC_RESTRICTION_EXEMPTIONS` itself.
 *
 * Derived rather than listed, so the audits below cannot disagree with the
 * config about who is exempt. A hand-written copy here would go stale the first
 * time a block's `files` changed, and the audit would then either demand a guard
 * of a file that has none (a false red) or excuse a file that should be guarded
 * (a false green) — and the second is the one nobody would notice.
 */
const ENVIRONMENT_ZONE_EXEMPT_FILES = new Set(
  SRC_RESTRICTION_EXEMPTIONS.filter((exemption) =>
    exemption.omits.some((restriction) =>
      CLUB_TIME_GUARD_ARMS.environmentZone.includes(restriction.selector),
    ),
  ).flatMap((exemption) => exemption.files),
);

const isEnvironmentZoneExempt = (file: string): boolean =>
  ENVIRONMENT_ZONE_EXEMPT_FILES.has(file);

let eslint: ESLint;

beforeAll(async () => {
  eslint = new ESLint({ cwd: ROOT, warnIgnored: false });
  // ESLint's first `lintText` pays for config resolution and parser load. Pay it
  // here so the per-path audits below stay inside the default timeout.
  await eslint.lintText(HOST_CLOCK_CONTROL, {
    filePath: path.join(ROOT, "src/lib/warmup.ts"),
  });
}, 120_000);

/** Messages a given guard raised for one snippet at one path. */
async function messagesFor(
  code: string,
  file: string,
  prefix: string,
): Promise<string[]> {
  const results = await eslint.lintText(code, {
    filePath: path.join(ROOT, file),
  });
  return results
    .flatMap((result) => result.messages)
    .filter(
      (message) =>
        message.ruleId === "no-restricted-syntax" &&
        (message.message ?? "").startsWith(prefix),
    )
    .map((message) => message.message ?? "");
}

describe("the host clock-face guard is present at every production path", () => {
  it("resolves with all four arms wherever production code lives", async () => {
    const problems = await auditResolvedGuardCoverage({
      eslint,
      repoRoot: ROOT,
      requiredSelectorsFor: () => CLUB_TIME_GUARD_ARMS.hostClock,
    });
    expect(problems).toEqual([]);
  }, 120_000);

  it("actually reports the violation at every one of them", async () => {
    const problems = await auditEnforcedGuardCoverage({
      eslint,
      repoRoot: ROOT,
      violatingCode: HOST_CLOCK_VIOLATION,
      messagePrefix: HOST_CLOCK_PREFIX,
    });
    expect(problems).toEqual([]);
  }, 120_000);

  it("leaves the UTC readers alone — the control that makes the ban meaningful", async () => {
    for (const entry of PRODUCTION_GUARD_ROSTER) {
      const messages = await messagesFor(
        HOST_CLOCK_CONTROL,
        entry.file,
        HOST_CLOCK_PREFIX,
      );
      expect(
        messages,
        `${entry.file} (${entry.why}) rejected getUTCDate(), so this arm bans reading a Date rather than banning the HOST's clock face — every correct migration target would trip it`,
      ).toEqual([]);
    }
  }, 120_000);

  it("names the defect and the replacement, not just the rule", async () => {
    const [message] = await messagesFor(
      HOST_CLOCK_VIOLATION,
      "src/lib/x.ts",
      HOST_CLOCK_PREFIX,
    );
    // The reader is handed the invariant, the measured consequence and the
    // helper to use instead. A guard whose message is only a prohibition sends
    // whoever trips it looking for a workaround.
    expect(message).toContain("INV-DATE-014");
    expect(message).toContain("addDaysDateOnly");
    expect(message).toContain("clubCalendarDateOf");
    expect(message).toContain("getUTC");
  });

  it("catches the computed spelling the older arms record as a known escape", async () => {
    const messages = await messagesFor(
      `
const lodgeNight = new Date("2026-08-01T00:00:00.000Z");
export const dayOfMonth = lodgeNight["getDate"]();
`,
      "src/lib/x.ts",
      HOST_CLOCK_PREFIX,
    );
    expect(messages).toHaveLength(1);
  });
});

describe("the environment-zone guard is present at every production path", () => {
  it("resolves with all three arms wherever production code lives", async () => {
    const problems = await auditResolvedGuardCoverage({
      eslint,
      repoRoot: ROOT,
      requiredSelectorsFor: (file) =>
        isEnvironmentZoneExempt(file) ? [] : CLUB_TIME_GUARD_ARMS.environmentZone,
    });
    expect(problems).toEqual([]);
  }, 120_000);

  it("reports a direct process.env.TZ read at every one of them", async () => {
    const problems = await auditEnforcedGuardCoverage({
      eslint,
      repoRoot: ROOT,
      violatingCode: ENVIRONMENT_ZONE_VIOLATION,
      messagePrefix: ENVIRONMENT_ZONE_PREFIX,
      isExempt: isEnvironmentZoneExempt,
    });
    expect(problems).toEqual([]);
  }, 120_000);

  it("reports the APP_TIME_ZONE import at every one of them", async () => {
    const problems = await auditEnforcedGuardCoverage({
      eslint,
      repoRoot: ROOT,
      violatingCode: ENVIRONMENT_ZONE_IMPORT_VIOLATION,
      messagePrefix: ENVIRONMENT_ZONE_PREFIX,
      isExempt: isEnvironmentZoneExempt,
    });
    expect(problems).toEqual([]);
  }, 120_000);

  it("leaves the other environment values and the other config exports alone", async () => {
    for (const entry of PRODUCTION_GUARD_ROSTER) {
      expect(
        await messagesFor(
          ENVIRONMENT_ZONE_CONTROL,
          entry.file,
          ENVIRONMENT_ZONE_PREFIX,
        ),
        `${entry.file} rejected process.env.LOCALE, so this arm bans process.env rather than banning the environment's TIMEZONE`,
      ).toEqual([]);
      expect(
        await messagesFor(
          ENVIRONMENT_ZONE_IMPORT_CONTROL,
          entry.file,
          ENVIRONMENT_ZONE_PREFIX,
        ),
        `${entry.file} rejected APP_CURRENCY/APP_LOCALE, so this arm bans a module rather than banning the environment's claim about civil time`,
      ).toEqual([]);
    }
  }, 120_000);

  it("sends the reader to the right replacement for their runtime", async () => {
    const [message] = await messagesFor(
      ENVIRONMENT_ZONE_VIOLATION,
      "src/lib/x.ts",
      ENVIRONMENT_ZONE_PREFIX,
    );
    // Three runtimes, three different answers, and getting this wrong is how a
    // CLI acquires a `server-only` edge that breaks it at import.
    expect(message).toContain("clubTimeZone()");
    expect(message).toContain("readClubTimeZoneOutsideRequest()");
    expect(message).toContain("ClubTimeProvider");
  });
});

/**
 * The allowlist is the part most likely to rot, because the cheapest way past
 * either guard above is to add one line to it. These assertions are what make
 * that line a deliberate, visible act.
 */
describe("the environment-zone allowlist is a ratchet", () => {
  it("holds exactly the nine files CT-6 measured, and no more", () => {
    // A COUNT, not a shape check. The list may shrink as callers migrate; it may
    // not grow. If this fails because an entry was REMOVED, lower the number in
    // the same commit and say which caller moved — that is the whole point of
    // the ratchet.
    expect(ENVIRONMENT_ZONE_ADAPTERS.length).toBeLessThanOrEqual(9);
  });

  it("excuses exactly the files it gives reasons for", () => {
    // The hole the count above does NOT close. The reasons list and the config
    // block's `files` are two different arrays, so adding a path to the block
    // alone widens the exemption while every assertion above stays green — the
    // cheapest possible way past both guards, and invisible in review.
    //
    // `src/lib/date-only.ts` is the one file excused by a different block (its
    // own, which also drops the encoding group), so it is named here rather than
    // duplicated into the reasons list, where a second matching block would
    // silently win.
    const excused = [...ENVIRONMENT_ZONE_EXEMPT_FILES].sort();
    const explained = [
      ...ENVIRONMENT_ZONE_ADAPTERS.map((entry) => entry.file),
      "src/lib/date-only.ts",
    ].sort();
    expect(excused).toEqual(explained);
  });

  it("names a real file for every entry", () => {
    const missing = ENVIRONMENT_ZONE_ADAPTERS.filter(
      (entry) => !fs.existsSync(path.join(ROOT, entry.file)),
    ).map((entry) => entry.file);
    // An entry naming a file that no longer exists is an exemption nobody is
    // using and nobody can see is unused — and it would silently cover a NEW
    // file created at that path later.
    expect(missing).toEqual([]);
  });

  it("gives every entry a reason a reader can act on", () => {
    for (const entry of ENVIRONMENT_ZONE_ADAPTERS) {
      expect(
        entry.reason.length,
        `${entry.file} needs a written reason, not a placeholder`,
      ).toBeGreaterThan(80);
    }
  });

  it("still reads the environment in every file it excuses", () => {
    // The other direction, and the one that catches a stale entry: an allowlist
    // row for a file that no longer names the environment's zone is an exemption
    // that has outlived its cause, and it will quietly re-admit the defect the
    // day somebody edits that file.
    const stale = ENVIRONMENT_ZONE_ADAPTERS.filter((entry) => {
      const source = fs.readFileSync(path.join(ROOT, entry.file), "utf8");
      return !/APP_TIME_ZONE|process\.env\.(TZ|NEXT_PUBLIC_TZ)/.test(source);
    }).map((entry) => entry.file);
    expect(stale).toEqual([]);
  });
});
