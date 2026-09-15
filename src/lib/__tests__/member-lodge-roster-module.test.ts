import fs from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";

// This suite reads registration facts and files, never the database. The
// roster module imports the Prisma client at module scope, so without these
// two doubles the file dies at IMPORT on any checkout with no DATABASE_URL —
// reported as "no tests" rather than as a failure, which is the shape of a
// false red.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  DEFAULT_MODULE_SETTINGS,
  MODULE_DEFINITIONS,
  MODULE_KEYS,
  getEffectiveModuleFlags,
} from "@/config/modules";
import { FEATURE_ROUTE_RULES } from "@/config/feature-routes";
import { DEFAULT_ROSTER_NAME_GRANULARITY } from "@/lib/member-lodge-roster";

/**
 * #2942 — the member lodge roster's module flag, its dial and its migration.
 *
 * The default is the load-bearing part. Switching this module on shows one
 * member's stay pattern to every other member who can book that lodge, and
 * there is no per-member opt-out (owner decision D3), so an upgrade that
 * defaulted it ON would start disclosing on nothing but a deploy. It therefore
 * inverts the general-purpose ON rule the way `commsPortal` does, and these
 * tests are what stop that being quietly flipped later.
 */

describe("memberLodgeRoster module flag", () => {
  it("is a known module key with a definition", () => {
    expect(MODULE_KEYS).toContain("memberLodgeRoster");
    expect(MODULE_DEFINITIONS.memberLodgeRoster.key).toBe("memberLodgeRoster");
    expect(MODULE_DEFINITIONS.memberLodgeRoster.label).toBeTruthy();
  });

  it("defaults OFF", () => {
    expect(DEFAULT_MODULE_SETTINGS.memberLodgeRoster).toBe(false);
  });

  it("reports disabled through getEffectiveModuleFlags on a fresh install", () => {
    expect(
      getEffectiveModuleFlags(DEFAULT_MODULE_SETTINGS).memberLodgeRoster,
    ).toBe(false);
  });

  it("reports disabled for a legacy row that predates the column", () => {
    // An existing deployment upgrading has no value for the new column until
    // the migration's DEFAULT supplies one. Whatever reaches the resolver must
    // not read as enabled (INV-CONFIG-001: upgrade without operator action).
    const legacy = { ...DEFAULT_MODULE_SETTINGS } as Record<string, unknown>;
    delete legacy.memberLodgeRoster;

    const flags = getEffectiveModuleFlags(
      legacy as typeof DEFAULT_MODULE_SETTINGS,
    );
    expect(flags.memberLodgeRoster).toBeFalsy();
  });

  it("tells an admin, on the card itself, that members become visible to each other", () => {
    // INV-CONFIG-001 asks that the unconfigured state be visible. For this
    // module the thing that has to be visible is the CONSEQUENCE: an admin
    // deciding whether to switch it on is deciding to disclose their members
    // to one another, and the card is the only place they read before doing
    // it. A card that described the feature without that sentence would be
    // accurate and still leave them uninformed.
    const { description, dependencies } =
      MODULE_DEFINITIONS.memberLodgeRoster;
    const copy = `${description} ${dependencies.join(" ")}`;
    expect(description).toMatch(/SHOWS MEMBERS TO EACH OTHER/i);
    expect(copy).toMatch(/no way for an individual to hide themselves/i);
    expect(copy).toMatch(/child/i);
  });

  it("gates the roster path, and does not gate the whole /lodge tree", () => {
    const rule = FEATURE_ROUTE_RULES.find(
      (candidate) => candidate.flag === "memberLodgeRoster",
    );
    expect(rule).toBeDefined();
    expect(rule!.prefixes).toContain("/lodge-roster");
    // "/lodge/roster" is the kiosk CHORE roster and belongs to a different
    // module. A prefix of "/roster" or "/lodge" here would read as covering
    // it and would switch off an unrelated surface.
    expect(rule!.prefixes).not.toContain("/roster");
    expect(rule!.prefixes).not.toContain("/lodge");
  });
});

describe("memberLodgeRoster schema and migration", () => {
  const migrationDir = path.join(
    process.cwd(),
    "prisma",
    "migrations",
    "20260927010000_add_member_lodge_roster",
  );
  const sql = fs.readFileSync(path.join(migrationDir, "migration.sql"), "utf8");
  const schema = fs.readFileSync(
    path.join(process.cwd(), "prisma", "schema.prisma"),
    "utf8",
  );

  it("declares the same default in the schema as in the config", () => {
    // Two sources of truth for one default is how a flag ends up on in the
    // database and off in the app, or the reverse.
    expect(schema).toMatch(/memberLodgeRoster\s+Boolean\s+@default\(false\)/);
    expect(DEFAULT_MODULE_SETTINGS.memberLodgeRoster).toBe(false);
  });

  it("leaves the roster dial nullable, so the code default is the only default", () => {
    // A database default here would freeze one surface's disclosure policy
    // into the schema and make the roster's default indistinguishable from
    // the lobby display's, which is deliberately different.
    expect(schema).toMatch(/rosterNameGranularity\s+DisplayNameGranularity\?/);
    expect(sql).toMatch(
      /ADD COLUMN\s+"rosterNameGranularity"\s+"DisplayNameGranularity"\s*;/i,
    );
    expect(DEFAULT_ROSTER_NAME_GRANULARITY).toBe("FULL_NAME");
  });

  it("is expand-only, which is what the ledger row claims", () => {
    const breaking =
      /(^|[^A-Z_])(DROP TABLE|DROP COLUMN|DROP TYPE|DROP CONSTRAINT|ALTER TABLE .* RENAME|RENAME COLUMN|ALTER COLUMN .* TYPE|ALTER COLUMN .* SET NOT NULL)/im;
    expect(sql).not.toMatch(breaking);
  });

  it("carries no DML, so no data-verification fixture is owed", () => {
    expect(sql).not.toMatch(/^\s*(INSERT|UPDATE|DELETE)\b/im);
  });

  it("adds the flag with a constant default so an old-colour insert still works", () => {
    expect(sql).toMatch(
      /ADD COLUMN\s+"memberLodgeRoster"\s+BOOLEAN\s+NOT NULL\s+DEFAULT false/i,
    );
  });

  it("creates no enum, because DisplayNameGranularity already exists", () => {
    expect(sql).not.toMatch(/CREATE TYPE/i);
  });

  it("has a ledger row declaring it old-code compatible", () => {
    const ledger = fs.readFileSync(
      path.join(process.cwd(), "docs", "BLUE_GREEN_MIGRATION_SAFETY.tsv"),
      "utf8",
    );
    const row = ledger
      .split("\n")
      .find((line) =>
        line.startsWith("20260927010000_add_member_lodge_roster\t"),
      );

    expect(row).toBeDefined();
    const [, phase, , compatible] = row!.split("\t");
    expect(phase).toBe("expand");
    expect(compatible).toBe("yes");
  });
});
