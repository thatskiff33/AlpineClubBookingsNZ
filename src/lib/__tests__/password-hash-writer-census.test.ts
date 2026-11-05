import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  PASSWORD_HASH_SCAN_ROOTS,
  passwordHashScanFiles,
  scanPasswordHashWriters,
  scanRepositoryPasswordHashWriters,
  type PasswordHashValueSource,
  type PasswordHashWriterKind,
  type PasswordHashWriterSite,
} from "./support/password-hash-writer-scan";

// Census of every `passwordHash` writer (#4610, INV-AUTH-006).
//
// Every place a PERSON chooses a password must call `screenChosenPassword`
// (src/lib/breached-password.ts) before the hash is written, so a password on
// the public breach list is refused wherever it is chosen. Every other writer
// stores a generated or deliberately unusable hash and is listed as exempt with
// its reason, and the scanner traces what it writes: random bytes, the erased-
// account sentinel or a fixed literal. An exempt writer that starts hashing
// anything else fails, so an exemption cannot quietly cover a typed password. A new writer in neither list fails here, naming its file and
// enclosing function; so does a "chosen" writer that stops screening first.
// Raw-SQL writers (an INSERT or UPDATE literal naming the column) are counted
// too, under `kind: "sql"`.
//
// The manifest enumerates file#scope pairs with their counts, not one total,
// so two lanes adding writers conflict on these lines and a person classifies
// both (docs/TESTING.md, "Census tests and the merge hazard"). Re-derive it from
// the scanner, never by incrementing.

type Classification = "chosen" | "exempt";

type ReviewedWriter = {
  file: string;
  scope: string;
  /** Defaults to "property"; raw-SQL writers say "sql". */
  kind?: PasswordHashWriterKind;
  count: number;
  classification: Classification;
  reason: string;
  /**
   * For an exempt writer that stores a parameter or copies another object's
   * `passwordHash`: the manifest key of the writer that produced the value.
   * That writer must itself be screened, or exempt and traced.
   */
  valueFrom?: string;
  /**
   * An exempt writer whose value the scanner cannot trace, with why that is
   * acceptable. Only the keys in UNTRACED_EXEMPT_WRITERS may carry one.
   */
  untracedValue?: string;
};

/** What an exempt writer may store with no further reason: nobody chose it. */
const GENERATED_SOURCES: ReadonlySet<PasswordHashValueSource> = new Set([
  "random",
  "deleted-sentinel",
  "literal",
]);

/** The only exempt writers allowed an untraced value: local demo data. */
const UNTRACED_EXEMPT_WRITERS = ["prisma/demo-seed.ts#makeMember", "prisma/demo-seed.ts#main"];

// A directory whose raw-SQL writers are exempt as a class: every SQL site
// under it is covered, and a property writer there still needs its own entry.
const REVIEWED_SQL_WRITER_DIRECTORIES: readonly { prefix: string; reason: string }[] = [
  {
    prefix: "prisma/migration-verification/",
    reason:
      "Migration-verification fixtures: INSERT seeds with fixed literal hashes, run only against the scratch database the migration drift check builds.",
  },
];

const GENERATED_PLACEHOLDER =
  "Hash of random bytes nobody knows; the person sets their own password later through /reset-password, which screens it.";

const REVIEWED_PASSWORD_HASH_WRITERS: readonly ReviewedWriter[] = [
  // A person chooses the password: screened before the hash is written.
  {
    file: "src/app/api/auth/change-password/route.ts",
    scope: "POST",
    count: 1,
    classification: "chosen",
    reason: "A signed-in member chooses a new password.",
  },
  {
    file: "src/app/api/auth/reset-password/route.ts",
    scope: "POST",
    count: 1,
    classification: "chosen",
    reason: "A member chooses a password from a reset or account-setup (invite) link.",
  },
  {
    file: "src/app/api/admin/lodge/route.ts",
    scope: "PUT",
    count: 1,
    classification: "chosen",
    reason: "An officer chooses a new kiosk password.",
  },
  {
    file: "src/app/api/admin/lodge/route.ts",
    scope: "POST",
    count: 1,
    classification: "chosen",
    reason: "An officer chooses the password for a new kiosk account.",
  },
  {
    file: "prisma/seed.ts",
    scope: "main",
    count: 2,
    classification: "chosen",
    reason: "The operator chooses SEED_ADMIN_PASSWORD and SEED_LODGE_PASSWORD; the install-time seed screens each and stops on a breached one.",
  },
  // Generated or unusable hashes: nobody chooses these.
  {
    file: "src/app/api/admin/lodge/route.ts",
    scope: "GET",
    count: 1,
    classification: "exempt",
    reason: "First kiosk auto-created with a random password; an officer sets a real one through the screened PUT.",
  },
  {
    file: "src/app/api/admin/deletion-requests/[id]/route.ts",
    scope: "POST",
    count: 1,
    classification: "exempt",
    reason: "Erasure writes DELETED_ACCOUNT_PASSWORD_HASH, which no password matches.",
  },
  {
    file: "src/lib/privacy-retention-anonymise.ts",
    scope: "anonymiseFormerMember",
    count: 1,
    classification: "exempt",
    reason: "Anonymisation writes DELETED_ACCOUNT_PASSWORD_HASH, which no password matches.",
  },
  {
    file: "src/app/api/admin/members/import/route.ts",
    scope: "POST",
    count: 2,
    classification: "exempt",
    reason: `CSV import: a random-bytes hash computed per row, then copied into the create. ${GENERATED_PLACEHOLDER}`,
    valueFrom: "src/app/api/admin/members/import/route.ts#POST",
  },
  {
    file: "src/app/api/admin/xero/import-member-contact/route.ts",
    scope: "POST",
    count: 1,
    classification: "exempt",
    reason: GENERATED_PLACEHOLDER,
  },
  {
    file: "src/lib/xero-member-import.ts",
    scope: "importMembersFromXeroGroups",
    count: 2,
    classification: "exempt",
    reason: GENERATED_PLACEHOLDER,
  },
  {
    file: "src/lib/admin-members-service.ts",
    scope: "createAdminMember",
    count: 1,
    classification: "exempt",
    reason: `Admin-created member. ${GENERATED_PLACEHOLDER}`,
  },
  {
    file: "src/lib/admin-family-group-requests-service.ts",
    scope: "reviewAdminFamilyGroupRequest",
    count: 2,
    classification: "exempt",
    reason: `Family members created on approval. ${GENERATED_PLACEHOLDER}`,
  },
  {
    file: "src/lib/nomination.ts",
    scope: "approveMemberApplication",
    count: 3,
    classification: "exempt",
    reason: `Approved applicant (create and login-promotion paths). ${GENERATED_PLACEHOLDER}`,
  },
  {
    file: "src/lib/booking-request.ts",
    scope: "approveBookingRequest",
    count: 2,
    classification: "exempt",
    reason: `Placeholder guest or contact record that cannot sign in. ${GENERATED_PLACEHOLDER}`,
  },
  {
    file: "src/lib/booking-request-quotes.ts",
    scope: "holdBookingRequestSlots",
    count: 1,
    classification: "exempt",
    reason: `Placeholder guest record. ${GENERATED_PLACEHOLDER}`,
  },
  {
    file: "src/lib/school-booking-request.ts",
    scope: "approveSchoolBookingRequest",
    count: 2,
    classification: "exempt",
    reason: `Placeholder school contact or guest record. ${GENERATED_PLACEHOLDER}`,
  },
  {
    file: "src/lib/group-booking.ts",
    scope: "verifyAndCreateNonMemberJoin",
    count: 1,
    classification: "exempt",
    reason: `Placeholder non-member joiner. ${GENERATED_PLACEHOLDER}`,
  },
  {
    file: "src/lib/non-member-contact.ts",
    scope: "createNonMemberContact",
    count: 1,
    classification: "exempt",
    reason: `Placeholder non-member contact. ${GENERATED_PLACEHOLDER}`,
  },
  // Development seeds: run from the command line, outside any request.
  {
    file: "prisma/seed-data.ts",
    scope: "buildSeedAdminMemberData",
    count: 1,
    classification: "exempt",
    reason: "Copies the hash prisma/seed.ts computed into the seed admin row.",
    valueFrom: "prisma/seed.ts#main",
  },
  {
    file: "prisma/seed-data.ts",
    scope: "buildSeedLodgeMemberData",
    count: 1,
    classification: "exempt",
    reason: "Copies the hash prisma/seed.ts computed into the seed kiosk row.",
    valueFrom: "prisma/seed.ts#main",
  },
  {
    file: "prisma/demo-seed.ts",
    scope: "makeMember",
    count: 1,
    classification: "exempt",
    reason: "Local demo data with a published demo password; never a production account.",

    untracedValue: "DEMO_SEED_PASSWORD or its published default; the demo seed refuses to run without ALLOW_DEMO_SEED=1.",
  },
  {
    file: "prisma/demo-seed.ts",
    scope: "main",
    count: 3,
    classification: "exempt",
    reason: "Local demo data with a published demo password; never a production account.",

    untracedValue: "DEMO_SEED_PASSWORD or its published default; the demo seed refuses to run without ALLOW_DEMO_SEED=1.",
  },
  {
    file: "scripts/audit-access-role-membership-cleanup.ts",
    scope: "buildRepresentativeSeedSql",
    kind: "sql",
    count: 1,
    classification: "exempt",
    reason: "Audit rehearsal seed SQL for a scratch database; writes the fixed sentinel 'audit-hash', which no password matches.",
  },
];

function key(file: string, scope: string, kind: PasswordHashWriterKind = "property"): string {
  return kind === "property" ? `${file}#${scope}` : `${file}#${scope} (${kind})`;
}

function sqlDirectory(site: PasswordHashWriterSite) {
  return site.kind === "sql"
    ? REVIEWED_SQL_WRITER_DIRECTORIES.find((dir) => site.file.startsWith(dir.prefix))
    : undefined;
}

function group(sites: readonly PasswordHashWriterSite[]) {
  const grouped = new Map<string, PasswordHashWriterSite[]>();
  for (const site of sites) {
    const k = key(site.file, site.scope, site.kind);
    grouped.set(k, [...(grouped.get(k) ?? []), site]);
  }
  return grouped;
}

describe("passwordHash writer census (#4610, INV-AUTH-006)", () => {
  const allSites = scanRepositoryPasswordHashWriters();
  const sites = allSites.filter((site) => !sqlDirectory(site));
  const measured = group(sites);
  const reviewed = new Map(
    REVIEWED_PASSWORD_HASH_WRITERS.map((w) => [key(w.file, w.scope, w.kind), w]),
  );

  it("walks every scan root and finds the known writers (no vacuous pass)", () => {
    const files = passwordHashScanFiles();
    for (const root of PASSWORD_HASH_SCAN_ROOTS) {
      expect(files.some((file) => file.startsWith(`${root}/`)), root).toBe(true);
    }
    expect(files).toContain("src/app/api/auth/change-password/route.ts");
    expect(sites.length).toBeGreaterThan(0);
    expect(allSites.some((site) => site.kind === "sql")).toBe(true);
  });

  it("covers raw-SQL writers in each exempt directory, and nothing else there", () => {
    for (const dir of REVIEWED_SQL_WRITER_DIRECTORIES) {
      expect(allSites.some((site) => sqlDirectory(site) === dir), `${dir.prefix} is stale`).toBe(true);
      expect(dir.reason.trim().length).toBeGreaterThan(20);
    }
  });

  it("lists each manifest entry once", () => {
    expect(reviewed.size).toBe(REVIEWED_PASSWORD_HASH_WRITERS.length);
  });

  it("classifies every writer in the tree, with the measured count", () => {
    const unlisted = [...measured.keys()].filter((k) => !reviewed.has(k));
    expect(
      unlisted,
      "New passwordHash writer(s): call screenChosenPassword before hashing a password a person chose, " +
        "or list a generated/unusable hash as exempt with its reason",
    ).toEqual([]);
    for (const [k, found] of measured) {
      expect(found.length, `${k} writer count changed; re-derive and re-classify`).toBe(
        reviewed.get(k)?.count,
      );
    }
  });

  it("has no stale manifest entries", () => {
    const stale = [...reviewed.keys()].filter((k) => !measured.has(k));
    expect(stale).toEqual([]);
  });

  it("screens every chosen-password writer before it writes the hash", () => {
    for (const writer of REVIEWED_PASSWORD_HASH_WRITERS.filter((w) => w.classification === "chosen")) {
      for (const site of measured.get(key(writer.file, writer.scope, writer.kind)) ?? []) {
        expect(
          site.screenedBefore,
          `${site.file}:${site.line} (${site.scope}) writes passwordHash without first binding an awaited ` +
            "screenChosenPassword of the same password it hashes (bcrypt.hash's first argument) and " +
            "returning on !result.ok",
        ).toBe(true);
      }
    }
  });

  it("ties every exempt writer to a generated, sentinel or fixed value", () => {
    const failures: string[] = [];
    for (const writer of REVIEWED_PASSWORD_HASH_WRITERS.filter((w) => w.classification === "exempt")) {
      const k = key(writer.file, writer.scope, writer.kind);
      if (writer.untracedValue) continue;
      for (const site of measured.get(k) ?? []) {
        if (GENERATED_SOURCES.has(site.source)) continue;
        if ((site.source === "parameter" || site.source === "copy") && writer.valueFrom) continue;
        failures.push(
          `${site.file}:${site.line} (${site.scope}) is exempt but writes a value traced to "${site.source}". ` +
            "An exempt writer must hash randomBytes/randomUUID output, or write DELETED_ACCOUNT_PASSWORD_HASH " +
            "or a fixed literal; a password a person chose is screened and classified \"chosen\".",
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it("traces a parameter or copied value to a screened or generated writer that supplies it", () => {
    for (const writer of REVIEWED_PASSWORD_HASH_WRITERS.filter((w) => w.valueFrom)) {
      const k = key(writer.file, writer.scope, writer.kind);
      const from = reviewed.get(writer.valueFrom ?? "");
      expect(from, `${k}: valueFrom ${writer.valueFrom} is not a manifest entry`).toBeDefined();
      if (!from) continue;
      const fromSites = measured.get(key(from.file, from.scope, from.kind)) ?? [];
      if (from.classification === "chosen") {
        expect(fromSites.every((site) => site.screenedBefore), `${k}: ${writer.valueFrom} is not screened`).toBe(true);
      } else {
        expect(
          fromSites.some((site) => GENERATED_SOURCES.has(site.source)) &&
            fromSites.every((site) => site.source !== "unknown"),
          `${k}: ${writer.valueFrom} does not trace to a generated value`,
        ).toBe(true);
      }
      // A different file must actually hand the value over: it calls this scope.
      if (from.file !== writer.file) {
        expect(fs.readFileSync(from.file, "utf8"), `${from.file} never calls ${writer.scope}`).toContain(
          `${writer.scope}(`,
        );
      }
    }
  });

  it("allows an untraced exempt value only for the local demo seed", () => {
    const untraced = REVIEWED_PASSWORD_HASH_WRITERS.filter((w) => w.untracedValue).map((w) =>
      key(w.file, w.scope, w.kind),
    );
    expect(untraced.sort()).toEqual([...UNTRACED_EXEMPT_WRITERS].sort());
  });

  it("gives every exempt writer a reason", () => {
    for (const writer of REVIEWED_PASSWORD_HASH_WRITERS) {
      expect(writer.reason.trim().length, key(writer.file, writer.scope, writer.kind)).toBeGreaterThan(20);
    }
  });
});

// The scanner proven against shapes, so a quiet tree cannot hide a blind spot.
describe("passwordHash writer scanner", () => {
  const scan = (source: string) => scanPasswordHashWriters("src/example.ts", source);

  it("skips prisma/migrations by path, and still reads any other migrations directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "password-hash-scan-"));
    try {
      for (const file of ["prisma/migrations/0001/seed.ts", "src/lib/migrations/run.ts", "scripts/migrations/fix.ts"]) {
        fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), "export {};\n");
      }
      expect(passwordHashScanFiles(root).sort()).toEqual(["scripts/migrations/fix.ts", "src/lib/migrations/run.ts"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds property, quoted, shorthand and assignment writers", () => {
    const sites = scan(`
      async function create(passwordHash: string) {
        await db.member.create({ data: { passwordHash: await hash(x) } });
        await db.member.create({ data: { "passwordHash": h } });
        await db.member.create({ data: { passwordHash } });
        row.passwordHash = h;
        row["passwordHash"] = h;
      }
    `);
    expect(sites.map((s) => s.scope)).toEqual(["create", "create", "create", "create", "create"]);
  });

  it("ignores types, selects, destructuring, comments and strings", () => {
    expect(
      scan(`
        interface Row { passwordHash: string | null }
        type R = { passwordHash?: string };
        const q = { select: { passwordHash: true }, omit: { passwordHash: false } };
        const { passwordHash, ...rest } = member;
        if (row.passwordHash === other) {}
        // data: { passwordHash: x }
        const s = "passwordHash: x";
      `),
    ).toEqual([]);
  });

  it("names the enclosing function across arrow callbacks, wrappers, and module scope", () => {
    const sites = scan(`
      export const PUT = async () => { await tx(async (t) => t.update({ data: { passwordHash: h } })); };
      class S { async reset() { this.data = { passwordHash: h }; } }
      export const POST = withGuard(async () => save({ passwordHash: h }));
      const top = { passwordHash: h };
    `);
    expect(sites.map((s) => s.scope)).toEqual(["PUT", "reset", "POST", "module"]);
  });

  it("finds raw-SQL writers in string and template literals, and nothing else", () => {
    const sites = scan(`
      async function seed() {
        await db.$executeRawUnsafe('UPDATE "Member" SET "passwordHash" = $1', h);
        await db.$executeRaw\`INSERT INTO "Member" ("id", "passwordHash") VALUES (\${id}, \${h})\`;
        const plain = \`update member set passwordHash = 'x'\`;
        const read = 'SELECT "passwordHash" FROM "Member"';
        const other = 'UPDATE "Member" SET "email" = $1';
      }
    `);
    expect(sites.map((s) => [s.kind, s.scope])).toEqual([
      ["sql", "seed"],
      ["sql", "seed"],
      ["sql", "seed"],
    ]);
  });

  it("traces a written value to random bytes, the sentinel, a literal, a parameter or a copy", () => {
    const sources = (source: string) => scan(source).map((s) => [s.source, s.hashedInput]);
    // Generated or unusable: what an exemption may store.
    expect(sources(`async function a() { const h = await hash(randomBytes(32).toString("hex"), 12); await tx(async (t) => t.save({ passwordHash: h })); }`)).toEqual([["random", null]]);
    expect(sources(`async function a() { const pw = crypto.randomBytes(24).toString("base64url"); const passwordHash = await bcrypt.hash(pw, 12); save({ passwordHash }); }`)).toEqual([["random", "pw"]]);
    expect(sources(`async function a() { row.passwordHash = await bcrypt.hash(crypto.randomUUID(), 12); }`)).toEqual([["random", null]]);
    expect(sources(`function a() { save({ passwordHash: DELETED_ACCOUNT_PASSWORD_HASH }); }`)).toEqual([["deleted-sentinel", null]]);
    expect(sources(`function a() { save({ passwordHash: "!unusable" }); }`)).toEqual([["literal", null]]);
    expect(sources(`const PW = "demo"; const H = bcrypt.hashSync(PW, 12); function a() { save({ passwordHash: H }); }`)).toEqual([["literal", "PW"]]);
    // The caller decides, or another object's hash is copied.
    expect(sources(`function a(params) { return { passwordHash: params.passwordHash }; }`)).toEqual([["parameter", null]]);
    expect(sources(`async function a(password) { save({ passwordHash: await hash(password, 12) }); }`)).toEqual([["parameter", "password"]]);
    expect(sources(`function a() { for (const row of rows) save({ passwordHash: row.passwordHash }); }`)).toEqual([["copy", null]]);
    // A typed password, or anything the trace cannot follow.
    expect(sources(`async function a(input) { const h = await hash(input.password, 12); save({ passwordHash: h }); }`)).toEqual([["unknown", "input.password"]]);
    expect(sources(`async function a() { const pw = body.newPassword; save({ passwordHash: await hash(pw, 12) }); }`)).toEqual([["unknown", "pw"]]);
    expect(sources(`async function a() { let h = await hash(randomBytes(8).toString("hex"), 12); h = typed; save({ passwordHash: h }); }`)).toEqual([["unknown", null]]);
    expect(sources(`async function a() { save({ passwordHash: await hash(String(Date.now()), 12) }); }`)).toEqual([["unknown", null]]);
    expect(sources(`async function a() { save({ passwordHash: await other(randomBytes(8)) }); }`)).toEqual([["unknown", null]]);
    // A loop or catch variable shadows an outer constant too, and is not followed.
    const h = `const h = await hash(randomBytes(8).toString("hex"), 12);`;
    expect(sources(`async function a() { ${h} for (const h of typed) save({ passwordHash: h }); }`)).toEqual([["unknown", null]]);
    expect(sources(`async function a() { ${h} for (const h in typed) save({ passwordHash: h }); }`)).toEqual([["unknown", null]]);
    expect(sources(`async function a() { ${h} for (let h = typed; ; ) save({ passwordHash: h }); }`)).toEqual([["unknown", null]]);
    expect(sources(`async function a() { ${h} for (const [h] of typed) { save({ passwordHash: h }); } }`)).toEqual([["unknown", null]]);
    expect(sources(`async function a() { ${h} try { x(); } catch (h) { save({ passwordHash: h }); } }`)).toEqual([["unknown", null]]);
    expect(sources(`async function a() { ${h} try { x(); } catch ({ h }) { save({ passwordHash: h }); } }`)).toEqual([["unknown", null]]);
    expect(sources(`async function a() { ${h} for (const x of list) save({ passwordHash: h }); }`)).toEqual([["random", null]]);
    // A callback's own parameter shadows an outer constant of the same name.
    expect(sources(`async function a() { const h = await hash(randomBytes(8).toString("hex"), 12); list.map((h) => save({ passwordHash: h })); }`)).toEqual([["parameter", null]]);
  });

  it("calls a raw-SQL writer a fixed literal only when it has no template holes", () => {
    expect(scan(`const q = 'UPDATE "Member" SET "passwordHash" = \\'x\\'';`).map((s) => s.source)).toEqual(["literal"]);
    expect(scan("const q = `UPDATE \"Member\" SET \"passwordHash\" = ${h}`;").map((s) => s.source)).toEqual(["unknown"]);
  });

  it("counts a writer as screened only when a bound, awaited screen's !ok branch exits first", () => {
    const guarded = (source: string) => scan(source).map((s) => s.screenedBefore);
    // Guarded: bound, awaited, `if (!x.ok)` exits, all before the writer.
    expect(guarded(`async function a(p) { const s = await screenChosenPassword(p); if (!s.ok) return; save({ passwordHash: await hash(p, 12) }); }`)).toEqual([true]);
    expect(guarded(`async function a(p) { const s = p ? await screenChosenPassword(p) : { ok: true }; if (!s.ok) { log(); return r(s); } save({ passwordHash: await hash(p, 12) }); }`)).toEqual([true]);
    expect(guarded(`async function a(p) { const s = await screenChosenPassword(p); if (!s.ok) throw new E(); await tx(async (t) => t.save({ passwordHash: await hash(p, 12) })); }`)).toEqual([true]);
    // A `||` chain still enters the branch whenever the screen failed.
    expect(guarded(`async function a(p) { const s = await screenChosenPassword(p); if (bad || !s.ok) return; save({ passwordHash: await hash(p, 12) }); }`)).toEqual([true]);
    expect(guarded(`async function a(p) { const s = await screenChosenPassword(p); if ((!s.ok) || bad) return; save({ passwordHash: await hash(p, 12) }); }`)).toEqual([true]);
    // Not guarded.
    expect(guarded(`async function a(p) { screenChosenPassword(p); save({ passwordHash: await hash(p, 12) }); }`)).toEqual([false]);
    expect(guarded(`async function a(p) { await screenChosenPassword(p); save({ passwordHash: await hash(p, 12) }); }`)).toEqual([false]);
    expect(guarded(`async function a(p) { const s = await screenChosenPassword(p); save({ passwordHash: await hash(p, 12) }); }`)).toEqual([false]);
    expect(guarded(`async function a(p) { const s = await screenChosenPassword(p); if (!s.ok) log(); save({ passwordHash: await hash(p, 12) }); }`)).toEqual([false]);
    expect(guarded(`async function a(p) { const s = await screenChosenPassword(p); if (s.ok) return; save({ passwordHash: await hash(p, 12) }); }`)).toEqual([false]);
    expect(guarded(`async function a(p) { const s = await screenChosenPassword(p); if (!other.ok) return; save({ passwordHash: await hash(p, 12) }); }`)).toEqual([false]);
    expect(guarded(`async function a(p) { save({ passwordHash: await hash(p, 12) }); const s = await screenChosenPassword(p); if (!s.ok) return; }`)).toEqual([false]);
    // A conditional or doubly negated test can let a failed screen through.
    expect(guarded(`async function a(p) { const s = await screenChosenPassword(p); if (flag && !s.ok) return; save({ passwordHash: await hash(p, 12) }); }`)).toEqual([false]);
    expect(guarded(`async function a(p) { const s = await screenChosenPassword(p); if (!!s.ok) return; save({ passwordHash: await hash(p, 12) }); }`)).toEqual([false]);
    expect(guarded(`async function a(p) { const s = await screenChosenPassword(p); if (f(!s.ok)) return; save({ passwordHash: await hash(p, 12) }); }`)).toEqual([false]);
    expect(guarded(`async function a(p) { const s = await screenChosenPassword(p); if (bad || (flag && !s.ok)) return; save({ passwordHash: await hash(p, 12) }); }`)).toEqual([false]);
    expect(guarded(`async function a(p) { if (p) { const s = await screenChosenPassword(p); if (!s.ok) return; } save({ passwordHash: await hash(p, 12) }); }`)).toEqual([false]);
    expect(guarded(`async function b(p) { const s = await screenChosenPassword(p); if (!s.ok) return; } async function a() { save({ passwordHash: await hash(p, 12) }); }`)).toEqual([false]);
    // The screened password must be the one hashed: same identifier or property access.
    expect(guarded(`async function a(b) { const s = await screenChosenPassword(b.newPassword); if (!s.ok) return; const h = await bcrypt.hash(b.newPassword, 12); save({ passwordHash: h }); }`)).toEqual([true]);
    expect(guarded(`async function a(cur, next) { const s = await screenChosenPassword(cur); if (!s.ok) return; save({ passwordHash: await hash(next, 12) }); }`)).toEqual([false]);
    expect(guarded(`async function a(b) { const s = await screenChosenPassword(b.currentPassword); if (!s.ok) return; save({ passwordHash: await hash(b.newPassword, 12) }); }`)).toEqual([false]);
    expect(guarded(`async function a(p) { const s = await screenChosenPassword(p); if (!s.ok) return; save({ passwordHash: await hash(p.trim(), 12) }); }`)).toEqual([false]);
    expect(guarded(`async function a(p) { const s = await screenChosenPassword(p); if (!s.ok) return; save({ passwordHash: h }); }`)).toEqual([false]);
    // #4740 review: the result is a `const` bound to the awaited screen itself.
    expect(guarded(`async function a(body) { const { pw } = body; const s = await screenChosenPassword(pw, policy); if (!s.ok) return; save({ passwordHash: await hash(pw, 12) }); }`)).toEqual([true]);
    expect(guarded(`async function a(p) { const s = { ok: true, r: await screenChosenPassword(p) }; if (!s.ok) return; save({ passwordHash: await hash(p, 12) }); }`)).toEqual([false]);
    expect(guarded(`async function a(p) { const s = (await screenChosenPassword(p), { ok: true }); if (!s.ok) return; save({ passwordHash: await hash(p, 12) }); }`)).toEqual([false]);
    expect(guarded(`async function a(p) { const s = false ? await screenChosenPassword(p) : { ok: true }; if (!s.ok) return; save({ passwordHash: await hash(p, 12) }); }`)).toEqual([false]);
    expect(guarded(`async function a(p) { const s = (true) ? { ok: true } : await screenChosenPassword(p); if (!s.ok) return; save({ passwordHash: await hash(p, 12) }); }`)).toEqual([false]);
    expect(guarded(`async function a(p) { let s = await screenChosenPassword(p); s = { ok: true }; if (!s.ok) return; save({ passwordHash: await hash(p, 12) }); }`)).toEqual([false]);
    expect(guarded(`async function a(p) { const s = await screenChosenPassword(p, { breachedPasswordCheck: false }); if (!s.ok) return; save({ passwordHash: await hash(p, 12) }); }`)).toEqual([false]);
    // ...of the same declaration the hash reads, which nothing reassigns.
    expect(guarded(`async function a(p) { const s = await screenChosenPassword(p); if (!s.ok) return; p = typed; save({ passwordHash: await hash(p, 12) }); }`)).toEqual([false]);
    expect(guarded(`async function a(p) { const s = await screenChosenPassword(p); if (!s.ok) return; [p] = typed; save({ passwordHash: await hash(p, 12) }); }`)).toEqual([false]);
    expect(guarded(`async function a(b) { const s = await screenChosenPassword(b.pw); if (!s.ok) return; b.pw = typed; save({ passwordHash: await hash(b.pw, 12) }); }`)).toEqual([false]);
    expect(guarded(`async function a(b) { const s = await screenChosenPassword(b.data.pw); if (!s.ok) return; b["data"] = typed; save({ passwordHash: await hash(b.data.pw, 12) }); }`)).toEqual([false]);
    expect(guarded(`async function a(body) { let pw = body.pw; const s = await screenChosenPassword(pw); if (!s.ok) return; save({ passwordHash: await hash(pw, 12) }); }`)).toEqual([false]);
    expect(guarded(`async function a(p, list) { const s = await screenChosenPassword(p); if (!s.ok) return; list.forEach(async (p) => save({ passwordHash: await hash(p, 12) })); }`)).toEqual([false]);
    expect(guarded(`async function a(p, list) { const s = await screenChosenPassword(p); if (!s.ok) return; for (const p of list) save({ passwordHash: await hash(p, 12) }); }`)).toEqual([false]);
    expect(guarded(`async function a(p) { const s = await screenChosenPassword(p); if (!s.ok) return; try { x(); } catch (p) { save({ passwordHash: await hash(p, 12) }); } }`)).toEqual([false]);
    // A write deeper than the path, or to another property, reassigns nothing.
    expect(guarded(`async function a(b) { const s = await screenChosenPassword(b.pw); if (!s.ok) return; b.other = 1; save({ passwordHash: await hash(b.pw, 12) }); }`)).toEqual([true]);
    // A screen in another wrapped handler never satisfies this one.
    expect(
      guarded(`
        export const POST = wrap(async (p) => { const s = await screenChosenPassword(p); if (!s.ok) return r; });
        export const PUT = wrap(async () => save({ passwordHash: await hash(p, 12) }));
      `),
    ).toEqual([false]);
  });
});
