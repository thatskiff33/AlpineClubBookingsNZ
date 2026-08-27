import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODULE_SETTINGS,
  MODULE_DEFINITIONS,
  MODULE_KEYS,
  getEffectiveModuleFlags,
} from "@/config/modules";

/**
 * #2993 (epic #2992) — the member message board's module flag and its
 * migration.
 *
 * The default is the load-bearing part. Sharing a post from this module
 * publishes member-written content to every other connected club, so an upgrade
 * that defaulted it on would start doing that on nothing but a deploy. Decision
 * D-C2 on the epic is that it defaults OFF, deliberately inverting the
 * `memberNotices` precedent it otherwise resembles, and these tests are what
 * stop that being quietly flipped later.
 */

describe("commsPortal module flag", () => {
  it("is a known module key with a definition", () => {
    expect(MODULE_KEYS).toContain("commsPortal");
    expect(MODULE_DEFINITIONS.commsPortal.key).toBe("commsPortal");
    expect(MODULE_DEFINITIONS.commsPortal.label).toBeTruthy();
  });

  it("defaults to OFF (D-C2)", () => {
    expect(DEFAULT_MODULE_SETTINGS.commsPortal).toBe(false);
  });

  it("tells an admin that enabling it can publish posts to other clubs", () => {
    // The card is the only place an operator learns what the switch does before
    // throwing it, so the consequence has to be legible there rather than only
    // in this repository's docs.
    const { description, dependencies } = MODULE_DEFINITIONS.commsPortal;
    const text = [description, ...dependencies].join(" ").toLowerCase();
    expect(text).toContain("club");
    expect(text).toMatch(/shar/);
  });

  it("says the board works without a central-server connection", () => {
    // Children 1-3 of the epic ship a board that never contacts the central
    // server. An admin who thinks the module needs that connection will not
    // turn it on.
    const text = MODULE_DEFINITIONS.commsPortal.dependencies.join(" ");
    expect(text).toMatch(/without|club-only|no central-server/i);
  });

  it("reports disabled through getEffectiveModuleFlags on a fresh install", () => {
    expect(getEffectiveModuleFlags(DEFAULT_MODULE_SETTINGS).commsPortal).toBe(
      false,
    );
  });

  it("reports disabled for a legacy row that predates the column", () => {
    // An existing deployment upgrading has no value for the new column until
    // the migration's DEFAULT supplies one. Whatever reaches the resolver must
    // not read as enabled (INV-CONFIG-001: upgrade without operator action).
    const legacy = { ...DEFAULT_MODULE_SETTINGS } as Record<string, unknown>;
    delete legacy.commsPortal;

    const flags = getEffectiveModuleFlags(
      legacy as typeof DEFAULT_MODULE_SETTINGS,
    );
    expect(flags.commsPortal).toBeFalsy();
  });
});

describe("commsPortal schema and migration", () => {
  const migrationDir = path.join(
    process.cwd(),
    "prisma",
    "migrations",
    "20260822015000_add_comms_portal",
  );
  const sql = fs.readFileSync(path.join(migrationDir, "migration.sql"), "utf8");
  const schema = fs.readFileSync(
    path.join(process.cwd(), "prisma", "schema.prisma"),
    "utf8",
  );

  it("declares the same default in the schema as in the config", () => {
    // Two sources of truth for one default is how a flag ends up on in the
    // database and off in the app, or the reverse.
    expect(schema).toMatch(/commsPortal\s+Boolean\s+@default\(false\)/);
    expect(DEFAULT_MODULE_SETTINGS.commsPortal).toBe(false);
  });

  it("is expand-only, which is what the ledger row claims", () => {
    // docs/BLUE_GREEN_MIGRATION_SAFETY.tsv declares old_code_compatible=yes on
    // the grounds that this migration is purely additive. If a later edit adds
    // a destructive statement, that claim silently becomes false — this pins it
    // to the file rather than to prose.
    const breaking =
      /(^|[^A-Z_])(DROP TABLE|DROP COLUMN|DROP TYPE|DROP CONSTRAINT|ALTER TABLE .* RENAME|RENAME COLUMN|ALTER COLUMN .* TYPE|ALTER COLUMN .* SET NOT NULL)/im;
    expect(sql).not.toMatch(breaking);
  });

  it("carries no DML, so no data-verification fixture is owed", () => {
    expect(sql).not.toMatch(/^\s*(INSERT|UPDATE|DELETE)\b/im);
  });

  it("adds the column with a constant default so an old-colour insert still works", () => {
    // NOT NULL without a default would break the draining old colour, whose
    // omitted-column INSERT into the singleton would fail.
    expect(sql).toMatch(
      /ADD COLUMN\s+"commsPortal"\s+BOOLEAN\s+NOT NULL\s+DEFAULT false/i,
    );
  });

  it("has a ledger row declaring it old-code compatible", () => {
    const ledger = fs.readFileSync(
      path.join(process.cwd(), "docs", "BLUE_GREEN_MIGRATION_SAFETY.tsv"),
      "utf8",
    );
    const row = ledger
      .split("\n")
      .find((line) => line.startsWith("20260822015000_add_comms_portal\t"));

    expect(row).toBeDefined();
    const [, phase, , compatible] = row!.split("\t");
    expect(phase).toBe("expand");
    expect(compatible).toBe("yes");
  });

  it("keeps the board club-wide, with no lodge dimension (D-C1)", () => {
    // docs/multi-lodge/lodge-scoping-contract.md records why: a shared post
    // travels to other CLUBS, which have no concept of this club's buildings.
    const clubPost = schema.slice(
      schema.indexOf("model ClubPost {"),
      schema.indexOf("model ClubPostImage {"),
    );
    expect(clubPost).not.toMatch(/lodgeId/);
  });

  it("caps serverPostId so an over-long value cannot wedge sync", () => {
    // Same trap ServerNzSettings.otherLodgesCursor documents: an over-long
    // value fails after rows are written and before the cursor advances.
    expect(schema).toMatch(/serverPostId\s+String\?\s+@unique\s+@db\.VarChar\(64\)/);
  });
});
