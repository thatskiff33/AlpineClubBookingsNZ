import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  CLEANED_LITERALS,
  cleanedLiteralWarning,
  detectCleanedLiterals,
  stripCleanedLiterals,
} from "@/lib/config-transfer/cleaned-literals";
import {
  serialisePages,
  serialiseSiteContent,
  siteContentImporter,
} from "@/lib/config-transfer/categories/site-content";
// Side-effect import: registers the `lodge` entity so the wiring contract below
// can read its exported field surface (page-content/site-content are registered
// by the site-content import above).
import "@/lib/config-transfer/categories/lodge-config";
import { getRegisteredEntities } from "@/lib/config-transfer/registry";
import type { ImportMode, ReadDb, TxDb } from "@/lib/config-transfer/import-types";

// #2511 — a config bundle exported BEFORE a cleanup migration still carries the
// removed value (the exporter selects the DB column verbatim; the applier writes
// it straight back), and the boot auto-import runs AFTER migrations. These tests
// prove the runtime guard refuses to re-plant each cleaned literal on BOTH the
// interactive (merge) and boot (overwrite) paths, keeps the preview honest, and
// never blocks a club's own customised value or the other fields in the bundle.

const MIGRATIONS_DIR = join(process.cwd(), "prisma", "migrations");

function migrationSql(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name, "migration.sql"), "utf8");
}

// ---------------------------------------------------------------------------
// Registry: byte-exact against the migrations, no silent drift.
// ---------------------------------------------------------------------------

describe("cleaned-literal registry stays byte-exact with the migrations (#2511)", () => {
  it("the #2431 hero literal matches the WHERE clause of its cleanup migration", () => {
    const entry = CLEANED_LITERALS.find((l) => l.issue === "#2431")!;
    expect(entry).toBeDefined();
    expect(entry.entity).toBe("page-content");
    expect(entry.key).toBe("home");
    expect(entry.field).toBe("headerText");
    // The migration matches the OLD sentence with SQL-doubled apostrophes.
    const sql = migrationSql(entry.migration);
    const sqlLiteral = entry.literal.replaceAll("'", "''");
    expect(sql).toContain(`"headerText" = '${sqlLiteral}'`);
    // And it must NOT equal the replacement the migration writes.
    expect(sql).toContain(`SET "headerText" = '`);
    expect(sql).not.toContain(`SET "headerText" = '${sqlLiteral}'`);
  });

  it("the #2490 footer literal matches the $cms$-quoted WHERE clause", () => {
    const entry = CLEANED_LITERALS.find((l) => l.issue === "#2490")!;
    expect(entry.entity).toBe("site-content");
    expect(entry.key).toBe("FOOTER_AFFILIATIONS");
    expect(entry.field).toBe("contentHtml");
    const sql = migrationSql(entry.migration);
    expect(sql).toContain(`AND "contentHtml" = $cms$${entry.literal}$cms$`);
  });

  it("the #2484 address literal matches its cleanup migration WHERE clause", () => {
    const entry = CLEANED_LITERALS.find((l) => l.issue === "#2484")!;
    expect(entry.entity).toBe("lodge");
    // Value-scoped across every lodge row.
    expect(entry.key).toBeNull();
    expect(entry.field).toBe("address");
    const sql = migrationSql(entry.migration);
    expect(sql).toContain(`WHERE "address" = '${entry.literal}'`);
  });
});

// ---------------------------------------------------------------------------
// Detector / stripper / warning — pure unit behaviour.
// ---------------------------------------------------------------------------

const HERO = CLEANED_LITERALS.find((l) => l.issue === "#2431")!;
const FOOTER = CLEANED_LITERALS.find((l) => l.issue === "#2490")!;
const ADDRESS = CLEANED_LITERALS.find((l) => l.issue === "#2484")!;

describe("detectCleanedLiterals (#2511)", () => {
  it("flags an exact byte-match on the right entity/key/field", () => {
    const hits = detectCleanedLiterals("page-content", "home", {
      headerText: HERO.literal,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].field).toBe("headerText");
    expect(hits[0].migration).toBe(HERO.migration);
  });

  it("does NOT flag a club's own customised value", () => {
    expect(
      detectCleanedLiterals("page-content", "home", {
        headerText: "Welcome to Our Own Club Lodge — members only.",
      }),
    ).toHaveLength(0);
  });

  it("does NOT flag the literal under the wrong key", () => {
    expect(
      detectCleanedLiterals("page-content", "about", {
        headerText: HERO.literal,
      }),
    ).toHaveLength(0);
  });

  it("does NOT flag when the field is absent", () => {
    expect(detectCleanedLiterals("page-content", "home", {})).toHaveLength(0);
  });

  it("is byte-exact: a one-character change no longer matches", () => {
    expect(
      detectCleanedLiterals("page-content", "home", {
        headerText: HERO.literal + " ",
      }),
    ).toHaveLength(0);
  });

  it("matches a value-scoped (key:null) literal on ANY row key", () => {
    // The address is value-scoped across every lodge, so any slug matches.
    for (const slug of ["default", "second-lodge", "whatever"]) {
      expect(
        detectCleanedLiterals("lodge", slug, { address: ADDRESS.literal }),
      ).toHaveLength(1);
    }
  });
});

describe("stripCleanedLiterals (#2511)", () => {
  it("removes only the matched field and returns the hit", () => {
    const { write, hits } = stripCleanedLiterals(
      "page-content",
      "home",
      { headerText: HERO.literal, caption: "Welcome" },
      { headerText: HERO.literal, caption: "Welcome", title: "Home" },
    );
    expect(hits).toHaveLength(1);
    expect(write).toEqual({ caption: "Welcome", title: "Home" });
    expect("headerText" in write).toBe(false);
  });

  it("is a no-op (same reference) when nothing matches", () => {
    const original = { headerText: "custom", title: "Home" };
    const { write, hits } = stripCleanedLiterals(
      "page-content",
      "home",
      { headerText: "custom" },
      original,
    );
    expect(hits).toHaveLength(0);
    expect(write).toBe(original);
  });
});

describe("cleanedLiteralWarning (#2511)", () => {
  it("names what would be restored, the migration and the issue", () => {
    const [hit] = detectCleanedLiterals("site-content", "FOOTER_AFFILIATIONS", {
      contentHtml: FOOTER.literal,
    });
    const warning = cleanedLiteralWarning(hit);
    expect(warning).toContain(FOOTER.describe);
    expect(warning).toContain(FOOTER.migration);
    expect(warning).toContain("#2490");
  });
});

// ---------------------------------------------------------------------------
// Full plan + apply through the importer — interactive (merge) and boot
// (overwrite) paths. The boot auto-import uses BOOTSTRAP_IMPORT_MODE =
// "overwrite" and the SAME importer, so the overwrite cases prove the
// unattended fail-safe at the layer the guard lives.
// ---------------------------------------------------------------------------

const NEW_HERO =
  "Our club lodge welcomes members year-round. Log in to book a stay, or " +
  "apply to join and explore New Zealand's mountains.";

interface PageRow {
  id: string;
  slug: string;
  path: string;
  caption: string;
  menuTitle: string;
  title: string;
  headerText: string;
  sortOrder: number;
  contentHtml: string;
  published: boolean;
}
interface SiteRow {
  id: string;
  key: string;
  contentHtml: string;
}

/** A tx/db double capturing pageContent + siteContent writes. */
function makeStore(pages: PageRow[], siteRows: SiteRow[]) {
  const pageMap = new Map(pages.map((p) => [p.slug, { ...p }]));
  const siteMap = new Map(siteRows.map((s) => [s.key, { ...s }]));
  const db = {
    pageContent: {
      findMany: async ({ where }: { where?: { slug?: { in: string[] } } }) => {
        const slugs = where?.slug?.in;
        return [...pageMap.values()].filter(
          (p) => !slugs || slugs.includes(p.slug),
        );
      },
      create: async ({ data }: { data: PageRow }) => {
        pageMap.set(data.slug, { ...data });
        return data;
      },
      update: async ({
        where,
        data,
      }: {
        where: { slug: string };
        data: Partial<PageRow>;
      }) => {
        const cur = pageMap.get(where.slug)!;
        pageMap.set(where.slug, { ...cur, ...data });
        return pageMap.get(where.slug);
      },
    },
    siteContent: {
      findMany: async ({ where }: { where?: { key?: { in: string[] } } }) => {
        const keys = where?.key?.in;
        return [...siteMap.values()].filter(
          (s) => !keys || keys.includes(s.key),
        );
      },
      create: async ({ data }: { data: SiteRow }) => {
        siteMap.set(data.key, { ...data });
        return data;
      },
      update: async ({
        where,
        data,
      }: {
        where: { key: string };
        data: Partial<SiteRow>;
      }) => {
        const cur = siteMap.get(where.key)!;
        siteMap.set(where.key, { ...cur, ...data });
        return siteMap.get(where.key);
      },
    },
    clubTheme: { findUnique: async () => null, findMany: async () => [] },
    mediaImage: { findMany: async () => [] },
  };
  return {
    db,
    home: () => pageMap.get("home"),
    page: (slug: string) => pageMap.get(slug),
    site: (key: string) => siteMap.get(key),
  };
}

function pageBundleRow(overrides: Partial<PageRow>): Record<string, string> {
  const base = {
    slug: "home",
    path: "/home",
    caption: "Welcome to the Club Lodge",
    menuTitle: "Home",
    title: "Club Lodge",
    headerText: HERO.literal,
    sortOrder: 1,
    contentHtml: "",
    published: true,
  };
  const row = { ...base, ...overrides };
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, String(v)]),
  ) as Record<string, string>;
}

function currentHome(overrides: Partial<PageRow> = {}): PageRow {
  return {
    id: "home",
    slug: "home",
    path: "/home",
    caption: "Welcome to the Club Lodge",
    menuTitle: "Home",
    title: "Club Lodge",
    headerText: NEW_HERO,
    sortOrder: 1,
    contentHtml: "",
    published: true,
    ...overrides,
  };
}

function filesFor(pageRows: Record<string, string>[], siteRows: Record<string, string>[]) {
  const files = new Map<string, Uint8Array>();
  const pageEntry = serialisePages(pageRows as never);
  files.set(pageEntry.path, pageEntry.bytes);
  const siteEntry = serialiseSiteContent(siteRows as never);
  files.set(siteEntry.path, siteEntry.bytes);
  return files;
}

async function runPlan(
  files: Map<string, Uint8Array>,
  store: ReturnType<typeof makeStore>,
  mode: ImportMode,
) {
  return siteContentImporter.plan({
    db: store.db as unknown as ReadDb,
    files,
    manifest: { formatVersion: 2 } as never,
    mode,
    resolutions: new Map<string, string>(),
  } as never);
}

async function runApply(
  files: Map<string, Uint8Array>,
  store: ReturnType<typeof makeStore>,
  mode: ImportMode,
) {
  return siteContentImporter.apply({
    tx: store.db as unknown as TxDb,
    files,
    manifest: { formatVersion: 2 } as never,
    mode,
    resolutions: new Map<string, string>(),
    actorMemberId: "admin-1",
    imageRemap: new Map<string, string>(),
    notes: { doorCodesWritten: [] as string[] },
  });
}

describe.each(["overwrite", "merge"] as const)(
  "the cleaned-literal guard on the %s path (#2511)",
  (mode) => {
    it("does NOT re-plant the guest-booking hero, and keeps the cleaned copy", async () => {
      // The bundle carries the OLD hero for the always-seeded "home" row.
      const store = makeStore([currentHome()], []);
      const files = filesFor([pageBundleRow({ headerText: HERO.literal })], []);

      await runApply(files, store, mode);

      // The migration's replacement survives; the old sentence is NOT written.
      expect(store.home()!.headerText).toBe(NEW_HERO);
      expect(store.home()!.headerText).not.toBe(HERO.literal);
    });

    it("surfaces a named preview warning and does NOT claim a headerText change", async () => {
      const store = makeStore([currentHome()], []);
      const files = filesFor([pageBundleRow({ headerText: HERO.literal })], []);

      const plan = await runPlan(files, store, mode);

      expect(
        plan.warnings.some((w) => w.includes(HERO.migration) && w.includes("#2431")),
      ).toBe(true);
      const item = plan.items.find((i) => i.entity === "page-content" && i.key === "home");
      expect(item?.changedFields ?? []).not.toContain("headerText");
      // Pure re-plant (nothing else differs) reads as unchanged, not update.
      expect(item?.action).toBe("unchanged");
    });

    it("still imports OTHER fields of the same guarded row", async () => {
      // Same bundle re-plants the hero but genuinely changes the caption.
      const store = makeStore([currentHome()], []);
      const files = filesFor(
        [pageBundleRow({ headerText: HERO.literal, caption: "A brand new caption" })],
        [],
      );

      await runApply(files, store, mode);

      expect(store.home()!.caption).toBe("A brand new caption");
      expect(store.home()!.headerText).toBe(NEW_HERO); // hero still not re-planted
    });

    it("imports a club's OWN customised hero unchanged", async () => {
      const OWN = "Our alpine club — a members' lodge in the Southern Alps.";
      const store = makeStore([currentHome()], []);
      const files = filesFor([pageBundleRow({ headerText: OWN })], []);

      await runApply(files, store, mode);

      expect(store.home()!.headerText).toBe(OWN);
    });

    it("does NOT re-plant the RMCA footer affiliations", async () => {
      const store = makeStore(
        [],
        [{ id: "aff", key: "FOOTER_AFFILIATIONS", contentHtml: "" }],
      );
      const files = filesFor(
        [],
        [{ key: "FOOTER_AFFILIATIONS", contentHtml: FOOTER.literal }],
      );

      const plan = await runPlan(files, store, mode);
      await runApply(files, store, mode);

      expect(store.site("FOOTER_AFFILIATIONS")!.contentHtml).toBe("");
      expect(
        plan.warnings.some((w) => w.includes(FOOTER.migration) && w.includes("#2490")),
      ).toBe(true);
    });

    it("imports a DIFFERENT footer key normally", async () => {
      const store = makeStore(
        [],
        [{ id: "blurb", key: "FOOTER_BLURB", contentHtml: "<p>old</p>" }],
      );
      const files = filesFor(
        [],
        [{ key: "FOOTER_BLURB", contentHtml: "<p>Our new blurb</p>" }],
      );

      await runApply(files, store, mode);

      expect(store.site("FOOTER_BLURB")!.contentHtml).toContain("Our new blurb");
    });
  },
);

// ---------------------------------------------------------------------------
// Registry ↔ applier wiring contract (#2511 F2). The registry only defends a
// value a bundle can actually carry, and its DORMANT claim must stay honest:
// the moment a dormant field becomes exportable the transition has to be
// deliberate, never a silent reopening of the #2484 hole.
// ---------------------------------------------------------------------------

describe("cleaned-literal registry ↔ exported-field contract (#2511)", () => {
  const registered = new Map(getRegisteredEntities().map((e) => [e.entity, e]));

  it("every entity a cleaned literal targets is a registered config-transfer entity", () => {
    for (const lit of CLEANED_LITERALS) {
      expect(
        registered.has(lit.entity),
        `Cleaned literal ${lit.issue} targets entity "${lit.entity}", which is ` +
          `not registered — import its category module here or fix the entity name.`,
      ).toBe(true);
    }
  });

  it("a DORMANT literal's field is genuinely absent from its entity's exported surface", () => {
    // The honesty invariant behind the dormant Waldvogel address (#2484): the
    // field a dormant entry names must NOT be an exported field of its entity,
    // so no bundle can carry it. Adding `address` to LODGE_FIELDS puts it in the
    // lodge entity's exported fields and fails this test — the forcing function
    // that stops the #2484 exposure reopening silently. When it fails: drop
    // `dormant`, confirm the applier still calls stripCleanedLiterals for that
    // entity (the lodge applier already does), and add a behavioural strip test
    // for the now-live field.
    const dormant = CLEANED_LITERALS.filter((l) => l.dormant);
    expect(dormant.length).toBeGreaterThan(0); // the Waldvogel address entry
    for (const lit of dormant) {
      const entity = registered.get(lit.entity)!;
      expect(
        entity.fields.includes(lit.field),
        `Cleaned literal ${lit.issue} is marked dormant, but "${lit.field}" is ` +
          `now an exported field of "${lit.entity}". A bundle can carry it, so it ` +
          `is no longer dormant: drop \`dormant\`, confirm the "${lit.entity}" ` +
          `applier strips it, and add a behavioural strip test.`,
      ).toBe(false);
    }
  });

  it("a LIVE literal's field IS on its entity's exported surface (the round-trip it defends)", () => {
    for (const lit of CLEANED_LITERALS.filter((l) => !l.dormant)) {
      const entity = registered.get(lit.entity)!;
      expect(
        entity.fields.includes(lit.field),
        `Cleaned literal ${lit.issue} is live but "${lit.field}" is not an ` +
          `exported field of "${lit.entity}" — mark it dormant or fix the registry.`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Forcing function: a value-scoped cleanup migration on an exportable content
// column must be tied to the registry (#2511 F3). A full "detect every cleanup"
// scan is infeasible — a value-pinned rewrite of exportable copy is not
// mechanically distinguishable from a benign edit — so this enforces the
// tractable subset (a WHERE clause that pins a guarded column's byte value, the
// exact bytes a bundle would re-plant) and routes the one benign historical
// rewrite through an explicit, self-checked exempt list. The broader rule lives
// as a documented convention in cleaned-literals.ts and docs/config-transfer.
// ---------------------------------------------------------------------------

describe("value-scoped content cleanups stay tied to the registry (#2511)", () => {
  // Exportable content columns a config bundle round-trips (PageContent.headerText,
  // SiteContent.contentHtml, Lodge.address once it becomes portable).
  const GUARDED_EXPORTED_COLUMNS = ["headerText", "contentHtml", "address"];

  // Value-pinned content migrations that intentionally carry NO registry entry.
  const UNREGISTERED_VALUE_PINNED_MIGRATIONS = new Set<string>([
    // #716 — rewrote the starter "/home" hero to the club-agnostic wording that
    // #2431 later removed. It value-pins the PREVIOUS hero in its WHERE, but that
    // superseded string is not a harmful cleaned literal to block: the
    // guest-booking hero this migration WROTE is the one #2511 guards (via
    // 20260802150000, which is registered).
    "20260613090000_update_starter_home_page_content",
  ]);

  /** Does any UPDATE statement's WHERE clause pin a guarded column's byte value? */
  function valuePinsGuardedColumn(sql: string): boolean {
    // SQL line comments, not JavaScript ones (#3164). The canonical
    // `stripComments` helper does not know this delimiter, so a census that
    // used it here would read a commented-out UPDATE as a live one.
    const withoutSqlComments = sql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    for (const stmt of withoutSqlComments.split(";")) {
      if (!/\bUPDATE\b/i.test(stmt)) continue;
      const whereIdx = stmt.search(/\bWHERE\b/i);
      if (whereIdx < 0) continue;
      const where = stmt.slice(whereIdx);
      for (const col of GUARDED_EXPORTED_COLUMNS) {
        // `"<col>" = '…'` or `"<col>" = $cms$…$cms$` — the byte-literal pin a
        // value-scoped cleanup uses (and the exact bytes a bundle re-plants).
        if (new RegExp(`"${col}"\\s*=\\s*('|\\$cms\\$)`, "i").test(where)) {
          return true;
        }
      }
    }
    return false;
  }

  function migrationDirs(): string[] {
    return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }

  it("every migration that value-pins a guarded exported column is registered or explicitly exempt", () => {
    const registeredMigrations = new Set(CLEANED_LITERALS.map((l) => l.migration));
    const offenders: string[] = [];
    for (const dir of migrationDirs()) {
      const sqlPath = join(MIGRATIONS_DIR, dir, "migration.sql");
      if (!existsSync(sqlPath)) continue;
      if (!valuePinsGuardedColumn(readFileSync(sqlPath, "utf8"))) continue;
      if (registeredMigrations.has(dir)) continue;
      if (UNREGISTERED_VALUE_PINNED_MIGRATIONS.has(dir)) continue;
      offenders.push(dir);
    }
    expect(
      offenders,
      `These migrations value-pin an exportable content column ` +
        `(${GUARDED_EXPORTED_COLUMNS.join("/")}) but neither register a ` +
        `CLEANED_LITERALS entry nor sit on the exempt list. A value-scoped ` +
        `cleanup of exportable content a config bundle round-trips MUST add a ` +
        `registry entry in cleaned-literals.ts (see its header). If the ` +
        `migration genuinely re-plants nothing harmful, add it to ` +
        `UNREGISTERED_VALUE_PINNED_MIGRATIONS with a reason: ` +
        offenders.join(", "),
    ).toEqual([]);
  });

  it("the registered cleanup migrations are themselves detected by the scan (no false negatives)", () => {
    // Guards against the scan silently going blind: each registered migration
    // must still trip the value-pin detector.
    for (const lit of CLEANED_LITERALS) {
      const sqlPath = join(MIGRATIONS_DIR, lit.migration, "migration.sql");
      expect(
        valuePinsGuardedColumn(readFileSync(sqlPath, "utf8")),
        `registered migration ${lit.migration} (${lit.issue}) is no longer ` +
          `detected as value-pinning a guarded column — the F3 scan has gone blind.`,
      ).toBe(true);
    }
  });

  it("the exempt list stays honest — every exempt migration exists and still value-pins", () => {
    for (const dir of UNREGISTERED_VALUE_PINNED_MIGRATIONS) {
      const sqlPath = join(MIGRATIONS_DIR, dir, "migration.sql");
      expect(existsSync(sqlPath), `exempt migration ${dir} not found`).toBe(true);
      expect(
        valuePinsGuardedColumn(readFileSync(sqlPath, "utf8")),
        `exempt migration ${dir} no longer value-pins a guarded column — ` +
          `remove it from UNREGISTERED_VALUE_PINNED_MIGRATIONS.`,
      ).toBe(true);
    }
  });
});
