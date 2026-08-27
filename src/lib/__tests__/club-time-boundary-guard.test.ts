import fs from "node:fs";
import path from "node:path";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

import { stripComments } from "./support/strip-comments";

import {
  CLUB_TIME_GUARD_ARMS,
  DATE_FNS_ADAPTERS,
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
 * by somebody who did not know a rule existed. THREE of the classes were
 * guarded by nothing at all until this issue:
 *
 * - **the HOST's clock face** — `.getDate()` and its family, which answer in
 *   whatever zone the container runs in. A `@db.Date` lodge night is UTC
 *   midnight, so west of Greenwich reading one back this way returns the
 *   PREVIOUS day. #3082 priced a boundary birthday a year young that way and
 *   #3100 built a stay expander that never terminated;
 * - **the ENVIRONMENT's zone** — `process.env.TZ`, `NEXT_PUBLIC_TZ`, and the
 *   `APP_TIME_ZONE` those two feed. Since CT-1 (#2989) the club's civil time is
 *   the persisted `ClubTimeSettings.timeZone` row (`INV-CONFIG-002`); the
 *   environment SEEDS that row at setup and has no say afterwards;
 * - **a library doing the first of those on your behalf** — every `date-fns`
 *   calendar helper reads the host's clock face inside `node_modules`, where
 *   no selector in this repository can see it. Measured rather than assumed;
 *   the numbers are on that block below.
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

/** The same derivation for the `date-fns` group. */
const DATE_FNS_EXEMPT_FILES = new Set(
  SRC_RESTRICTION_EXEMPTIONS.filter((exemption) =>
    exemption.omits.some((restriction) =>
      CLUB_TIME_GUARD_ARMS.dateFns.includes(restriction.selector),
    ),
  ).flatMap((exemption) => exemption.files),
);

const isDateFnsExempt = (file: string): boolean =>
  DATE_FNS_EXEMPT_FILES.has(file);

/** A host-local calendar helper reached through the library instead of by hand. */
const DATE_FNS_VIOLATION = `
import { startOfMonth } from "date-fns";
const lodgeNight = new Date("2026-09-01T00:00:00.000Z");
export const bucket = startOfMonth(lodgeNight);
`;

/** Its control: an ordinary import of anything else must stay clean. */
const DATE_FNS_CONTROL = `
import { z } from "zod";
export const schema = z.string();
`;

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

  it("catches the computed and destructured env reads too", async () => {
    // Measured against the shipped config by a review lens: `process.env.TZ`
    // was blocked and both of these were allowed, while the census beside this
    // suite looked for `APP_TIME_ZONE` and could not see them either — so for
    // these two spellings there was only ONE instrument, not two.
    const spellings: Array<[string, string]> = [
      ["computed member access", 'export const zone = process.env["TZ"];'],
      ["destructuring", "const { TZ } = process.env;\nexport const zone = TZ;"],
      [
        "destructuring with a quoted key",
        'const { "NEXT_PUBLIC_TZ": zone } = process.env;\nexport const z = zone;',
      ],
    ];
    for (const [label, code] of spellings) {
      expect(
        await messagesFor(code, "src/lib/x.ts", ENVIRONMENT_ZONE_PREFIX),
        label + " is not reported, so the ban has a documented way round it",
      ).toHaveLength(1);
    }
  });

  it("still leaves an unrelated destructure of process.env alone", async () => {
    // The control for the arm above: destructuring is not itself the defect.
    expect(
      await messagesFor(
        "const { LOCALE, NODE_ENV } = process.env;\nexport const l = LOCALE ?? NODE_ENV;",
        "src/lib/x.ts",
        ENVIRONMENT_ZONE_PREFIX,
      ),
    ).toEqual([]);
  });

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
  it("only ever shrinks, and holds no more entries than it holds today", () => {
    /*
      A COUNT, not a shape check, and THE ONLY PLACE THE NUMBER IS WRITTEN DOWN.
      The list may shrink as callers migrate; it may not grow. If this fails
      because an entry was REMOVED, lower the number in the same commit and say
      which caller moved — that is the whole point of the ratchet. Nothing else
      states the figure: the config's exemption reason used to restate it, drifted
      to a number its own list contradicted, and #3123 deleted the restatement
      rather than re-measure it into a second place.

      HOW IT REACHED FIVE. The route matters more than the arithmetic, because
      only one of the four departures was a deletion:

      - NINE until #3123 took `src/lib/nzst-date.ts` off it by DELETING the
        rendering adapter, once its last production caller reached the kernel.
        That is the ratchet's terminus for a module with nothing left to do, not
        an exception to it.
      - EIGHT until the same issue's group F took
        `src/lib/member-guest-consent-labels.ts` off it the other way, by
        MIGRATING. Its three module-level formatters now take the club's persisted
        zone, so the entry excusing them would have been stale — which the "still
        reads the environment" assertion below refuses.
      - SEVEN until `src/lib/member-guest-delegate-page.ts` went the same way,
        once that assertion's method was fixed. It read RAW source, so a DOCBLOCK
        naming `APP_TIME_ZONE` was enough to keep an exemption alive, and that
        file had exactly one: a postmortem explaining the defect it no longer
        commits. Stripping comments first, the way the escape-hatch census always
        has, made the entry visibly stale and it was deleted. This repository
        documents each defect at the site where it removed it, so any guard
        reading raw text is densest in false positives exactly where the code is
        cleanest.
      - SIX until #3126 took `src/lib/member-merge-field-kinds.ts` off it, and
        that departure named a hole rather than closing a caller. The entry
        excused a client component for READING the environment's zone; what it
        was actually covering was a `= APP_TIME_ZONE` DEFAULT on
        `formatMergeFieldValue`, which handed the environment's answer to any
        caller that passed none. Production passed one at all three call sites,
        so deleting the default (`INV-SSOT-003`) cost nothing, left the file
        naming the environment nowhere, and made the entry visibly stale. The
        arm that replaces it, `AUTHORITY_DEFAULT_RESTRICTIONS`, is on the
        mandatory set that no block lifts — so a future entry here can excuse a
        read and can never again excuse a default.
      - FIVE today. Of the four that have left, TWO migrated
        (`member-guest-consent-labels.ts`, `member-guest-delegate-page.ts`), one
        was DELETED outright (`nzst-date.ts`) and one left by having its DEFAULT
        deleted (`member-merge-field-kinds.ts`, #3126) while still naming the
        zone in prose. Three routes off, not one — and migration is the intended
        one. An earlier version of this note said "three of the four MIGRATED",
        which counted the default deletion as a migration two lines after saying
        it was not.

      THIS NUMBER IS TIGHT AND DELIBERATELY SO. It equals the live count; there
      is no headroom, no rounding and no allowance for work in flight. A ratchet
      with slack in it is not a ratchet — the slack is simply room to regrow in
      without anything failing.
    */
    expect(ENVIRONMENT_ZONE_ADAPTERS.length).toBeLessThanOrEqual(5);
  });

  it("excuses exactly the files it gives reasons for", () => {
    // The hole the count above does NOT close. The reasons list and the config
    // block's `files` are two different arrays, so adding a path to the block
    // alone widens the exemption while every assertion above stays green — the
    // cheapest possible way past both guards, and invisible in review.
    //
    // `src/lib/date-only.ts` USED TO BE NAMED HERE TOO, as the one file excused
    // by a block of its own. #3123 deleted the six `= APP_TIME_ZONE` defaults and
    // the import from that adapter, so its block stopped dropping this group and
    // the exception went with them. If some file needs a block of its own again,
    // name it here rather than adding it to the reasons list, where a second
    // matching block would silently win.
    const excused = [...ENVIRONMENT_ZONE_EXEMPT_FILES].sort();
    const explained = ENVIRONMENT_ZONE_ADAPTERS.map((entry) => entry.file).sort();
    expect(excused).toEqual(explained);
  });

  it("names a real file for every file the config excuses", () => {
    // Read from the CONFIG's exempt set rather than from the reasons list, so a
    // file excused by a block of its own is checked too — the staleness leg below
    // records what that distinction already cost.
    //
    // An exemption naming a file that no longer exists is one nobody is using and
    // nobody can see is unused — and it would silently cover a NEW file created
    // at that path later.
    const missing = [...ENVIRONMENT_ZONE_EXEMPT_FILES].filter(
      (file) => !fs.existsSync(path.join(ROOT, file)),
    );
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

  it("still reads the environment in every file the config excuses", () => {
    // The other direction, and the one that catches a stale exemption: one for a
    // file that no longer names the environment's zone has outlived its cause,
    // and it will quietly re-admit the defect the day somebody edits that file.
    //
    // IT READS THE CONFIG'S EXEMPT SET, NOT THE REASONS LIST, and #3123 widened
    // it for a measured reason. It used to iterate `ENVIRONMENT_ZONE_ADAPTERS`,
    // which is only the files excused by the SHARED block — so
    // `src/lib/date-only.ts`, excused by a block of its own, sat outside the one
    // leg that would have noticed anything. It duly kept its environment-zone
    // exemption straight through the commit that deleted the last
    // `= APP_TIME_ZONE` default and the import from it, with every assertion in
    // this file green. Deriving the set from `SRC_RESTRICTION_EXEMPTIONS` closes
    // that by construction: the next block written the same way is covered the
    // day it is added, and there is no second list to remember.
    //
    // COMMENTS ARE STRIPPED FIRST, and that is a correction rather than a
    // refinement (#3123). This leg used to read RAW source, while the census in
    // `club-time-escape-hatch-census.test.ts` — the instrument it is supposed to
    // be independent of, measuring the same property — strips them. Two
    // instruments that disagree about what counts are one instrument and a
    // rubber stamp.
    //
    // The cost was measured, not hypothesised: `member-guest-delegate-page.ts`
    // kept this exemption after its defect was fixed, because the only
    // `APP_TIME_ZONE` left in it was a DOCBLOCK explaining the fix. This
    // repository deliberately documents each defect at the site where it removed
    // it, so postmortems are densest in exactly the files that no longer commit
    // the defect — which makes a raw-text guard here strictly worse than no
    // guard, since it reads as green while excusing the wrong set.
    const stale = [...ENVIRONMENT_ZONE_EXEMPT_FILES].filter((file) => {
      const full = path.join(ROOT, file);
      // A glob cannot be read, so it cannot be checked. Fail closed rather than
      // skip it: an exemption this leg cannot measure is exactly the shape it
      // exists to refuse.
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return true;
      const source = stripComments(fs.readFileSync(full, "utf8"));
      return !/APP_TIME_ZONE|process\.env\.(TZ|NEXT_PUBLIC_TZ)/.test(source);
    });
    expect(
      stale,
      "these files are excused from the environment-zone guard but no longer name " +
        "the environment zone in CODE (or are not a readable file) — delete the " +
        "exemption:\n" + stale.join("\n"),
    ).toEqual([]);
  });
});

/**
 * The third arm, and the one that exists because the first two cannot see it.
 *
 * `date-fns` performs the identical host-clock reads the arm above bans, inside
 * `node_modules` where no selector can reach them. Measured on this runtime with
 * a `@db.Date` lodge night at `2026-09-01T00:00:00.000Z`: `format(night,
 * "yyyy-MM-dd")` answers `"2026-08-31"` in `America/Denver`, and
 * `startOfMonth(night)` lands in AUGUST. So a guard that stops at what the
 * source spells would report a clean tree while a report bucket sat in the wrong
 * month.
 */
describe("the date-fns guard closes the class no selector can see", () => {
  it("resolves with all three arms wherever production code lives", async () => {
    const problems = await auditResolvedGuardCoverage({
      eslint,
      repoRoot: ROOT,
      requiredSelectorsFor: (file) =>
        isDateFnsExempt(file) ? [] : CLUB_TIME_GUARD_ARMS.dateFns,
    });
    expect(problems).toEqual([]);
  }, 120_000);

  it("reports a date-fns import at every one of them", async () => {
    const problems = await auditEnforcedGuardCoverage({
      eslint,
      repoRoot: ROOT,
      violatingCode: DATE_FNS_VIOLATION,
      messagePrefix: HOST_CLOCK_PREFIX,
      isExempt: isDateFnsExempt,
    });
    expect(problems).toEqual([]);
  }, 120_000);

  it("catches every spelling a review lens found walking past", async () => {
    // Each of these was measured clean against the FIRST version of this arm.
    // The re-export is the sharpest: one file writing it makes every downstream
    // importer clean under every selector in the config.
    const spellings: Array<[string, string]> = [
      ["named re-export", 'export { addDays } from "date-fns";'],
      ["star re-export", 'export * from "date-fns";'],
      ["subpath re-export", 'export { addDays } from "date-fns/addDays";'],
      [
        "dynamic import",
        'export const f = async () => (await import("date-fns")).addDays;',
      ],
      [
        "subpath require",
        'const { addDays } = require("date-fns/addDays");\nexport const f = addDays;',
      ],
    ];
    for (const [label, code] of spellings) {
      expect(
        await messagesFor(code, "src/lib/x.ts", HOST_CLOCK_PREFIX),
        label + " is not reported, so the ban has a documented way round it",
      ).toHaveLength(1);
    }
  });

  it("catches a deep subpath import too", async () => {
    const messages = await messagesFor(
      'import { addDays } from "date-fns/addDays";\nexport const f = addDays;\n',
      "src/lib/x.ts",
      HOST_CLOCK_PREFIX,
    );
    expect(messages).toHaveLength(1);
  });

  it("leaves every other module import alone", async () => {
    for (const entry of PRODUCTION_GUARD_ROSTER) {
      expect(
        await messagesFor(DATE_FNS_CONTROL, entry.file, HOST_CLOCK_PREFIX),
        `${entry.file} rejected an ordinary import, so this arm bans importing rather than banning date-fns`,
      ).toEqual([]);
    }
  }, 120_000);

  it("tells the reader which date-fns calls are actually safe", async () => {
    const [message] = await messagesFor(
      DATE_FNS_VIOLATION,
      "src/lib/x.ts",
      HOST_CLOCK_PREFIX,
    );
    // Two of the seven remaining callers use only `formatDistanceToNow`, which
    // is a duration and genuinely zone-free. A message that did not say so would
    // send them to rewrite correct code.
    expect(message).toContain("formatDistanceToNow");
    expect(message).toContain("addCalendarDays");
    expect(message).toContain("startOfMonth(night)");
  });

  it("excuses exactly the files it gives reasons for", () => {
    const excused = [...DATE_FNS_EXEMPT_FILES].sort();
    const explained = DATE_FNS_ADAPTERS.map((entry) => entry.file).sort();
    expect(excused).toEqual(explained);
  });

  it("still imports date-fns in every file it excuses", () => {
    const stale = DATE_FNS_ADAPTERS.filter((entry) => {
      const source = fs.readFileSync(path.join(ROOT, entry.file), "utf8");
      return !/from\s+["']date-fns/.test(source);
    }).map((entry) => entry.file);
    expect(stale).toEqual([]);
  });

  it("records what each file uses, so the next lane can start with the cheapest", () => {
    for (const entry of DATE_FNS_ADAPTERS) {
      expect(
        entry.uses.length,
        `${entry.file} must name the symbols it imports`,
      ).toBeGreaterThan(0);
      expect(entry.reason.length).toBeGreaterThan(80);
    }
  });
});
