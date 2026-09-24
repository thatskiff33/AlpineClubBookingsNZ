import { strToU8 } from "fflate";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { siteContentImporter } from "@/lib/config-transfer/categories/site-content";
import type { ReadDb, TxDb } from "@/lib/config-transfer/import-types";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const THEME_FILE = "site-content/theme.json";

/** A theme.json bundle entry with the given fields. */
function themeFiles(theme: Record<string, unknown>) {
  return new Map<string, Uint8Array>([
    [THEME_FILE, strToU8(JSON.stringify(theme))],
  ]);
}

function baseTheme(overrides: Record<string, unknown> = {}) {
  return {
    brandGold: "#e0a800",
    brandDeep: "#111111",
    brandSafety: "#ff0000",
    headingFontKey: "LEAGUE_SPARTAN",
    bodyFontKey: "INTER",
    rawCss: "",
    ...overrides,
  };
}

/** Minimal tx store capturing what the importer writes to ClubTheme. */
function makeStore(existingTheme: Record<string, unknown> | null = null) {
  let theme = existingTheme;
  const db = {
    pageContent: { findMany: async () => [], create: async () => ({}) },
    siteContent: { findMany: async () => [], create: async () => ({}) },
    clubTheme: {
      findUnique: async () => theme,
      findMany: async () => (theme ? [theme] : []),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        theme = { ...data };
        return theme;
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        theme = { ...(theme ?? {}), ...data };
        return theme;
      },
    },
    mediaImage: { findMany: async () => [] },
  };
  return { db, written: () => theme };
}

async function applyTheme(
  theme: Record<string, unknown>,
  imageRemap: Map<string, string> = new Map(),
  mode: "merge" | "overwrite" = "overwrite",
  existing: Record<string, unknown> | null = null,
) {
  const store = makeStore(existing);
  await siteContentImporter.apply({
    format: CLUB_FORMAT_TEST,
    tx: store.db as unknown as TxDb,
    files: themeFiles(theme),
    manifest: { formatVersion: 2 } as never,
    mode,
    resolutions: new Map<string, string>(),
    actorMemberId: "admin-1",
    imageRemap,
    notes: { doorCodesWritten: [] as string[] },
  });
  return store.written();
}

async function planTheme(
  theme: Record<string, unknown>,
  existing: Record<string, unknown> | null = null,
) {
  const store = makeStore(existing);
  return siteContentImporter.plan({
    db: store.db as unknown as ReadDb,
    files: themeFiles(theme),
    manifest: { formatVersion: 2 } as never,
    mode: "overwrite" as const,
    resolutions: new Map<string, string>(),
  } as never);
}

describe("config-transfer import validates the theme it writes (#2322)", () => {
  it("drops a logoUrl whose media the bundle does not carry", async () => {
    // recreateBundleMedia mints fresh ids; an id absent from the map has no
    // bytes in this deployment, so storing it would leave a dangling reference
    // and a broken image. The text fallback is the correct end state.
    const written = await applyTheme(
      baseTheme({ logoUrl: "/api/images/missing999", logoDataUrl: null }),
    );

    expect(written?.logoUrl).toBeNull();
  });

  it("remaps a logoUrl whose media the bundle does carry", async () => {
    const written = await applyTheme(
      baseTheme({ logoUrl: "/api/images/old123", logoDataUrl: null }),
      new Map([["old123", "new456"]]),
    );

    expect(written?.logoUrl).toBe("/api/images/new456");
  });

  it("warns in the dry-run when the logo's media is missing", async () => {
    const plan = await planTheme(
      baseTheme({ logoUrl: "/api/images/missing999", logoDataUrl: null }),
    );

    expect(
      plan.warnings.some((w) => w.toLowerCase().includes("logo")),
    ).toBe(true);
  });

  it("does not warn when the logo's media is carried", async () => {
    const store = makeStore();
    const files = themeFiles(
      baseTheme({ logoUrl: "/api/images/img123", logoDataUrl: null }),
    );
    files.set(
      "media/media-map.json",
      strToU8(
        JSON.stringify({
          img123: {
            path: "media/img123.webp",
            filename: "logo.webp",
            contentType: "image/webp",
            kind: "LOGO",
          },
        }),
      ),
    );

    const plan = await siteContentImporter.plan({
      db: store.db as unknown as ReadDb,
      files,
      manifest: { formatVersion: 2 } as never,
      mode: "overwrite" as const,
      resolutions: new Map<string, string>(),
    } as never);

    expect(plan.warnings.some((w) => w.toLowerCase().includes("logo"))).toBe(
      false,
    );
  });

  it("rejects a hostile logoUrl rather than storing it", async () => {
    // An import bypasses the zod write schema entirely, so the same normaliser
    // every render uses has to run here.
    const written = await applyTheme(
      baseTheme({
        logoUrl: "https://evil.example/logo.png",
        logoDataUrl: null,
      }),
      new Map([["evil", "evil"]]),
    );

    expect(written?.logoUrl).toBeNull();
  });

  it("enforces logo exclusivity: a URL clears the inlined data URI", async () => {
    const written = await applyTheme(
      baseTheme({
        logoUrl: "/api/images/old123",
        logoDataUrl: "data:image/png;base64,AAAA",
      }),
      new Map([["old123", "new456"]]),
    );

    expect(written?.logoUrl).toBe("/api/images/new456");
    expect(written?.logoDataUrl).toBeNull();
  });

  it("still accepts a legacy oversized data URI under the 900KB read bound", async () => {
    // Old bundles carry big inlined logos by design; the WRITE budget is an
    // admin-save rule, not an import rule.
    const legacy = `data:image/png;base64,${Buffer.alloc(860_000, 0x61).toString("base64")}`;
    const written = await applyTheme(
      baseTheme({ logoUrl: null, logoDataUrl: legacy }),
    );

    expect(written?.logoDataUrl).toBe(legacy);
  });

  it("drops a data URI that exceeds the 900KB read bound", async () => {
    const tooBig = `data:image/png;base64,${Buffer.alloc(950_000, 0x61).toString("base64")}`;
    const written = await applyTheme(
      baseTheme({ logoUrl: null, logoDataUrl: tooBig }),
    );

    expect(written?.logoDataUrl).toBeNull();
  });

  it("does not turn a partial bundle into a full overwrite", async () => {
    // normaliseThemeValues fills every field with a default; writing it
    // wholesale would reset colours the bundle never mentioned.
    const written = await applyTheme({
      logoUrl: null,
      logoDataUrl: null,
    });

    expect(written).not.toBeNull();
    expect(Object.keys(written ?? {})).not.toContain("brandGold");
  });
});

/** A theme row as it exists BEFORE the import — the update branch, not create. */
function existingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "default",
    brandGold: "#111111",
    brandDeep: "#222222",
    brandSafety: "#333333",
    headingFontKey: "LEAGUE_SPARTAN",
    bodyFontKey: "INTER",
    logoUrl: null,
    logoDataUrl: null,
    rawCss: "",
    ...overrides,
  };
}

const LEGACY_DATA_URL = `data:image/png;base64,${Buffer.alloc(900, 0x61).toString("base64")}`;

describe("logo exclusivity holds in MERGE mode onto an existing row (#2322)", () => {
  // Merge mode is the DEFAULT, and updateDataForMode drops any field whose
  // bundle value is blank — including the nulls that carry the invariant. These
  // cases all run against a NON-EMPTY row so they exercise the update branch.

  it("A: URL bundle onto a legacy data-URI row nulls the data URI", async () => {
    const written = await applyTheme(
      baseTheme({ logoUrl: "/api/images/old123", logoDataUrl: null }),
      new Map([["old123", "new456"]]),
      "merge",
      existingRow({ logoDataUrl: LEGACY_DATA_URL }),
    );

    expect(written?.logoUrl).toBe("/api/images/new456");
    expect(written?.logoDataUrl).toBeNull();
  });

  it("B: data-URI bundle onto a URL row nulls the URL and the imported logo renders", async () => {
    const written = await applyTheme(
      baseTheme({ logoUrl: null, logoDataUrl: LEGACY_DATA_URL }),
      new Map(),
      "merge",
      existingRow({ logoUrl: "/api/images/existing" }),
    );

    expect(written?.logoUrl).toBeNull();
    // The imported logo is the one that renders — precedence is logoUrl first,
    // so a surviving stale URL would have masked it entirely.
    expect(written?.logoDataUrl).toBe(LEGACY_DATA_URL);
  });

  it("C: dangling-URL bundle onto a legacy row nulls both, no resurrection", async () => {
    const written = await applyTheme(
      baseTheme({ logoUrl: "/api/images/missing999", logoDataUrl: null }),
      new Map(),
      "merge",
      existingRow({ logoDataUrl: LEGACY_DATA_URL }),
    );

    expect(written?.logoUrl).toBeNull();
    expect(written?.logoDataUrl).toBeNull();
  });

  it("D: URL bundle onto a URL row replaces without leaving both set", async () => {
    const written = await applyTheme(
      baseTheme({ logoUrl: "/api/images/old123", logoDataUrl: null }),
      new Map([["old123", "new456"]]),
      "merge",
      existingRow({ logoUrl: "/api/images/previous" }),
    );

    expect(written?.logoUrl).toBe("/api/images/new456");
    expect(written?.logoDataUrl).toBeNull();
  });

  it("E: bundle carrying BOTH onto a populated row keeps only the URL", async () => {
    const written = await applyTheme(
      baseTheme({
        logoUrl: "/api/images/old123",
        logoDataUrl: LEGACY_DATA_URL,
      }),
      new Map([["old123", "new456"]]),
      "merge",
      existingRow({ logoDataUrl: LEGACY_DATA_URL }),
    );

    expect(written?.logoUrl).toBe("/api/images/new456");
    expect(written?.logoDataUrl).toBeNull();
  });

  it("never leaves BOTH logo columns populated, for any bundle shape, mode, or existing row", async () => {
    // The five bundle shapes from the review probe (A–E): URL only, URL plus
    // explicit null, data URI only, dangling URL, and both keys set. Each is
    // applied in both modes onto both populated existing-row states, and the
    // invariant is asserted on the FINAL row — not the write set — because
    // merge-mode key-dropping was exactly how the original bug slipped past.
    const bundles: Array<Record<string, unknown>> = [
      { logoUrl: "/api/images/old123" },
      { logoUrl: "/api/images/old123", logoDataUrl: null },
      { logoDataUrl: LEGACY_DATA_URL },
      { logoUrl: "/api/images/dangling999", logoDataUrl: null },
      { logoUrl: "/api/images/old123", logoDataUrl: LEGACY_DATA_URL },
    ];
    const rows = [
      existingRow({ logoDataUrl: LEGACY_DATA_URL }),
      existingRow({ logoUrl: "/api/images/target-logo" }),
    ];
    for (const bundle of bundles) {
      for (const mode of ["merge", "overwrite"] as const) {
        for (const existing of rows) {
          const written = await applyTheme(
            baseTheme(bundle),
            new Map([["old123", "new456"]]),
            mode,
            existing,
          );

          expect(
            Boolean(written?.logoUrl) && Boolean(written?.logoDataUrl),
            `${mode} mode left both logo columns set for bundle ${JSON.stringify(bundle)} onto ${JSON.stringify(existing)}`,
          ).toBe(false);
        }
      }
    }
  });
});

describe("a bundled INLINE logo is metadata-stripped on import (#2242)", () => {
  // `ClubTheme.logoDataUrl` is image bytes like any other, and it renders inline
  // in the public header, footer and mobile menu of every public page. It used
  // to be written straight from the bundle, so a club whose theme held a
  // straight-from-phone inline logo republished its GPS coordinates on every
  // deployment that bundle was ever restored to — the same hole the bundled
  // MediaImage bytes had.
  const GPS = Buffer.from("GPS:-41.29,174.78", "latin1");

  /** A minimal JPEG carrying EXIF/GPS; without the EOI the strip is unconfirmable. */
  function exifJpeg(withEoi: boolean): Buffer {
    const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), GPS]);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(payload.length + 2, 0);
    const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), len, payload]);
    const sof0 = Buffer.alloc(11);
    sof0.writeUInt8(0xff, 0);
    sof0.writeUInt8(0xc0, 1);
    sof0.writeUInt16BE(9, 2);
    sof0.writeUInt8(8, 4);
    sof0.writeUInt16BE(16, 5);
    sof0.writeUInt16BE(16, 7);
    sof0.writeUInt8(1, 9);
    const sos = Buffer.from([0xff, 0xda, 0x00, 0x02, 0x01, 0x77]);
    const parts = [Buffer.from([0xff, 0xd8]), app1, sof0, sos];
    if (withEoi) parts.push(Buffer.from([0xff, 0xd9]));
    return Buffer.concat(parts);
  }

  const asDataUrl = (bytes: Buffer) =>
    `data:image/jpeg;base64,${bytes.toString("base64")}`;

  it("removes the EXIF/GPS before storing the inline logo", async () => {
    const bundled = asDataUrl(exifJpeg(true));
    expect(Buffer.from(bundled.split(",")[1], "base64").includes(GPS)).toBe(true);

    const written = await applyTheme(
      baseTheme({ logoUrl: null, logoDataUrl: bundled }),
    );

    const stored = String(written?.logoDataUrl);
    expect(stored).toMatch(/^data:image\/jpeg;base64,/);
    expect(Buffer.from(stored.split(",")[1], "base64").includes(GPS)).toBe(false);
    expect(stored.length).toBeLessThan(bundled.length);
  });

  it("FAILS OPEN and still imports an inline logo whose strip is unconfirmed", async () => {
    // Deliberately unlike the member-photo route: an operator restoring a
    // configuration bundle must not have the whole import blocked by one
    // unparseable decorative logo.
    const bundled = asDataUrl(exifJpeg(false)); // no primary EOI
    const written = await applyTheme(
      baseTheme({ logoUrl: null, logoDataUrl: bundled }),
    );

    expect(written?.logoDataUrl).toBe(bundled);
  });

  it("keeps plan/apply parity: the dry-run diffs the STORED (stripped) value", async () => {
    // Both sides run the single `deriveThemeWrite` derivation, so a target row
    // already holding the stripped bytes must read as unchanged rather than the
    // preview promising a logo rewrite apply would not perform (ADR-002).
    const bundled = asDataUrl(exifJpeg(true));
    const applied = await applyTheme(
      baseTheme({ logoUrl: null, logoDataUrl: bundled }),
    );
    const stored = applied?.logoDataUrl;
    expect(stored).not.toBe(bundled);

    const plan = await planTheme(
      baseTheme({ logoUrl: null, logoDataUrl: bundled }),
      existingRow({ logoDataUrl: stored }),
    );

    const item = plan.items.find((i) => i.entity === "club-theme");
    expect(item?.changedFields ?? []).not.toContain("logoDataUrl");
  });
});
