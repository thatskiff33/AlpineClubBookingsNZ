import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  GENERATED_PASSWORD_HASH_SOURCES as GENERATED_SOURCES,
  PASSWORD_HASH_SCAN_ROOTS,
  passwordHashScanFiles,
  scanPasswordHashWriters,
  scanRepositoryPasswordHashWriters,
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
      // A copy names the writers that built the object it copies; they are
      // this entry's valueFrom sites, so the copy is of the vetted value.
      const fromLines = new Set(fromSites.map((site) => site.line));
      for (const site of measured.get(k) ?? []) {
        if (site.source !== "copy") continue;
        expect(
          site.copiedFromLines.length > 0 && site.copiedFromLines.every((line) => fromLines.has(line)),
          `${site.file}:${site.line} copies a passwordHash not written by ${writer.valueFrom}`,
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

  it("ties the members import's copied hash to its random per-row hash", () => {
    const file = "src/app/api/admin/members/import/route.ts";
    const source = fs.readFileSync(file, "utf8");
    const importSites = scanPasswordHashWriters(file, source);
    const random = importSites.filter((site) => site.source === "random");
    const copies = importSites.filter((site) => site.source === "copy");
    expect(random).toHaveLength(1);
    expect(copies.map((site) => site.copiedFromLines)).toEqual([[random[0].line]]);
    // The same copy from the request body traces to nothing.
    expect(source).toContain("passwordHash: row.passwordHash,");
    const fromBody = scanPasswordHashWriters(
      file,
      source.replace("passwordHash: row.passwordHash,", "passwordHash: parsedBody.passwordHash,"),
    );
    expect(fromBody.filter((site) => site.source === "copy")).toEqual([]);
    expect(fromBody.filter((site) => site.source === "unknown")).toHaveLength(1);
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
    // #4740 review: a copy's object must be built in the same function by a
    // generated or screened writer.
    const made = `await Promise.all(list.map(async (r) => ({ ...r, passwordHash: await hash(randomBytes(16).toString("hex"), 12) })))`;
    expect(sources(`async function a(list) { const rows = ${made}; for (const row of rows) save({ passwordHash: row.passwordHash }); }`)).toEqual([["random", null], ["copy", null]]);
    expect(sources(`async function a() { const data = { passwordHash: await hash(randomUUID(), 12) }; save({ passwordHash: data.passwordHash }); }`)).toEqual([["random", null], ["copy", null]]);
    expect(sources(`async function a(p) { const s = await screenChosenPassword(p); if (!s.ok) return; const data = { passwordHash: await hash(p, 12) }; save({ passwordHash: data.passwordHash }); }`)).toEqual([["parameter", "p"], ["copy", null]]);
    expect(scan(`async function a(list) { const rows = ${made}; for (const row of rows) save({ passwordHash: row.passwordHash }); }`)[1].copiedFromLines).toEqual([1]);
    // A request body, an unknown array, a loop over something else, an
    // override by a later spread, a typed origin or another function's object.
    expect(sources(`async function a(req) { const parsedBody = await req.json(); save({ passwordHash: parsedBody.passwordHash }); }`)).toEqual([["unknown", null]]);
    expect(sources(`function a() { for (const row of rows) save({ passwordHash: row.passwordHash }); }`)).toEqual([["unknown", null]]);
    expect(sources(`async function a(list) { const rows = ${made}; for (const row of other) save({ passwordHash: row.passwordHash }); }`)).toEqual([["random", null], ["unknown", null]]);
    expect(sources(`async function a(list) { const rows = ${made}; for (let row of rows) { row = typed; save({ passwordHash: row.passwordHash }); } }`)).toEqual([["random", null], ["unknown", null]]);
    expect(sources(`async function a(b) { const data = { passwordHash: await hash(randomUUID(), 12), ...b }; save({ passwordHash: data.passwordHash }); }`)).toEqual([["random", null], ["unknown", null]]);
    expect(sources(`async function a(b) { const data = { passwordHash: await hash(b.pw, 12) }; save({ passwordHash: data.passwordHash }); }`)).toEqual([["unknown", "b.pw"], ["unknown", null]]);
    expect(sources(`const DATA = { passwordHash: "!x" }; function a() { save({ passwordHash: DATA.passwordHash }); }`)).toEqual([["literal", null], ["unknown", null]]);
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
    // A placeholder or a bind argument supplies the value at run time.
    const sqlSources = (source: string) => scan(source).map((s) => s.source);
    expect(sqlSources(`const q = 'UPDATE "Member" SET "passwordHash" = $1 WHERE "id" = $2';`)).toEqual(["unknown"]);
    expect(sqlSources(`const q = 'UPDATE "Member" SET "passwordHash" = ? WHERE "id" = ?';`)).toEqual(["unknown"]);
    expect(sqlSources(`const q = 'INSERT INTO "Member" ("id", "passwordHash") VALUES (?,?)';`)).toEqual(["unknown"]);
    expect(sqlSources(`async function a(h) { await db.$executeRawUnsafe('UPDATE "Member" SET "passwordHash" = :h', h); }`)).toEqual(["unknown"]);
    expect(sqlSources(`async function a(h) { await db.$queryRawUnsafe(('INSERT INTO "Member" ("passwordHash") VALUES (:h)'), h); }`)).toEqual(["unknown"]);
    // The value inline, with nothing beside it, is a fixed literal.
    expect(sqlSources(`async function a() { await db.$executeRawUnsafe('UPDATE "Member" SET "passwordHash" = \\'x\\' WHERE "id" = \\'y\\''); }`)).toEqual(["literal"]);
    expect(sqlSources("const q = `INSERT INTO \"Member\" (\"passwordHash\") VALUES ('audit-hash')`;")).toEqual(["literal"]);
    // A statement joined to a run-time value with `+` is not a fixed literal.
    expect(sqlSources(`async function a() { const h = await hash(b.pw, 12); await db.$executeRawUnsafe('UPDATE "Member" SET "passwordHash" = \\'' + h + '\\''); }`)).toEqual(["unknown"]);
    expect(sqlSources(`async function a() { let q = ""; q += ('UPDATE "Member" SET "passwordHash" = ' as string); q += h; await db.$executeRawUnsafe(q); }`)).toEqual(["unknown"]);
  });

  it("counts a writer as screened only when a bound, awaited screen's !ok branch exits first", () => {
    const guarded = (source: string) => scan(source).map((s) => s.screenedBefore);
    // Guarded: bound, awaited, `if (!x.ok)` exits, all before the writer.
    expect(guarded(`async function a(p) { const s = await screenChosenPassword(p); if (!s.ok) return; save({ passwordHash: await hash(p, 12) }); }`)).toEqual([true]);
    expect(guarded(`async function a(p) { const s = await screenChosenPassword(p); if (!s.ok) { log(); return r(s); } save({ passwordHash: await hash(p, 12) }); }`)).toEqual([true]);
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

  it("accepts a conditional screen only when every branch screens (#4764)", () => {
    const guarded = (source: string) => scan(source).map((s) => s.screenedBefore);
    const check = (init: string) =>
      guarded(`async function a(b, skip, other) { const s = ${init}; if (!s.ok) return; save({ passwordHash: await hash(b.pw, 12) }); }`);
    const call = `await screenChosenPassword(b.pw)`;
    // Refused: a branch (or operand) that gives a result with no screen.
    expect(check(`skip ? { ok: true } : ${call}`)).toEqual([false]);
    expect(check(`skip ? ${call} : { ok: true }`)).toEqual([false]);
    expect(check(`skip ? ${call} : other`)).toEqual([false]);
    // Nested: one branch deep down still has none.
    expect(check(`skip ? (other ? ${call} : { ok: true }) : ${call}`)).toEqual([false]);
    expect(check(`skip ? ${call} : (other ? { ok: true } : ${call})`)).toEqual([false]);
    // `||` and `??` give back an operand that was not screened.
    expect(check(`other || ${call}`)).toEqual([false]);
    expect(check(`${call} || other`)).toEqual([false]);
    expect(check(`other ?? ${call}`)).toEqual([false]);
    expect(check(`${call} ?? other`)).toEqual([false]);
    // A screen of another value does not count as a branch.
    expect(check(`skip ? ${call} : await screenChosenPassword(b.other)`)).toEqual([false]);
    // No false positives: the plain screen, and every branch or operand screening.
    expect(check(call)).toEqual([true]);
    expect(check(`skip ? ${call} : ${call}`)).toEqual([true]);
    expect(check(`skip ? (other ? ${call} : ${call}) : ${call}`)).toEqual([true]);
    expect(check(`skip ? ${call} : (other ? ${call} : ${call})`)).toEqual([true]);
    expect(check(`${call} || ${call}`)).toEqual([true]);
    expect(check(`${call} ?? ${call}`)).toEqual([true]);
    expect(check(`skip ? (${call}) : (${call})`)).toEqual([true]);
    // A branch a constant test rules out need not screen (and one that stays live must).
    expect(check(`true ? ${call} : { ok: true }`)).toEqual([true]);
    expect(check(`false ? { ok: true } : ${call}`)).toEqual([true]);
    expect(check(`true ? { ok: true } : ${call}`)).toEqual([false]);
    // A gap is harmless where the writer cannot run on its path: the real kiosk and seed shapes.
    const gated = (init: string, writer: string) =>
      guarded(`async function a(b, skip, other, password) { const s = ${init}; if (!s.ok) return; ${writer} }`);
    const save = `save({ passwordHash: await hash(b.pw, 12) });`;
    expect(gated(`skip ? { ok: true } : ${call}`, `if (!skip) { ${save} }`)).toEqual([true]);
    expect(gated(`skip ? { ok: true } : ${call}`, `if (skip) { log(); } else { ${save} }`)).toEqual([true]);
    expect(gated(`skip ? { ok: true } : ${call}`, `if (skip) { ${save} }`)).toEqual([false]);
    expect(gated(`skip ? { ok: true } : ${call}`, `if (other) { ${save} }`)).toEqual([false]);
    expect(gated(`skip ? { ok: true } : ${call}`, `if (!skip) { log(); } ${save}`)).toEqual([false]);
    expect(gated(`skip ? { ok: true } : ${call}`, `if (!skip && other) { ${save} }`)).toEqual([true]);
    expect(gated(`skip ? { ok: true } : ${call}`, `if (!skip || other) { ${save} }`)).toEqual([false]);
    expect(gated(`skip ? { ok: true } : ${call}`, `if (!skip) { await tx(async () => { ${save} }); }`)).toEqual([true]);
    expect(gated(`password ? ${call} : { ok: true }`, `if (password) { ${save} }`)).toEqual([true]);
    expect(gated(`password ? ${call} : { ok: true }`, `if (!password) { ${save} }`)).toEqual([false]);
    // A comparison and its negation, with the operands in either order.
    expect(gated(`password === null ? { ok: true } : ${call}`, `if (password !== null) { ${save} }`)).toEqual([true]);
    expect(gated(`password === null ? { ok: true } : ${call}`, `if (null !== password) { ${save} }`)).toEqual([true]);
    expect(gated(`password !== null ? ${call} : { ok: true }`, `if (password === null) { log(); } else { ${save} }`)).toEqual([true]);
    expect(gated(`password === null ? { ok: true } : ${call}`, `if (password === null) { ${save} }`)).toEqual([false]);
    expect(gated(`password == null ? { ok: true } : ${call}`, `if (password !== null) { ${save} }`)).toEqual([false]);
    // Nested: each gap needs its own path ruled out, and one fact on the path is enough.
    expect(gated(`skip ? (other ? ${call} : { ok: true }) : ${call}`, `if (other) { ${save} }`)).toEqual([true]);
    expect(gated(`skip ? (other ? ${call} : { ok: true }) : ${call}`, `if (skip) { ${save} }`)).toEqual([false]);
    expect(gated(`skip ? { ok: true } : (other ? ${call} : { ok: true })`, `if (!skip && other) { ${save} }`)).toEqual([true]);
    expect(gated(`skip ? { ok: true } : (other ? ${call} : { ok: true })`, `if (!skip) { ${save} }`)).toEqual([false]);
    expect(gated(`skip ? { ok: true } : (other ? ${call} : { ok: true })`, `if (other) { ${save} }`)).toEqual([false]);
    // A `||` or `??` operand gives back a result with no fact to rule it out.
    expect(gated(`skip || ${call}`, `if (!skip) { ${save} }`)).toEqual([false]);
    // The tested value must not be able to change between the screen and the guard.
    expect(guarded(`async function a(b, skip) { const s = skip ? { ok: true } : ${call}; if (!s.ok) return; skip = false; if (!skip) { ${save} } }`)).toEqual([false]);
    expect(guarded(`async function a(b) { let skip = f(); const s = skip ? { ok: true } : ${call}; if (!s.ok) return; if (!skip) { ${save} } }`)).toEqual([false]);
    expect(gated(`b.skip ? { ok: true } : ${call}`, `if (!b.skip) { ${save} }`)).toEqual([false]);
    expect(gated(`f() ? { ok: true } : ${call}`, `if (!f()) { ${save} }`)).toEqual([false]);
    // A same-named value in a callback is another declaration.
    expect(gated(`skip ? { ok: true } : ${call}`, `xs.forEach(async (skip) => { if (!skip) { ${save} } });`)).toEqual([false]);
    // The window starts at the earliest screen of any branch.
    expect(
      guarded(`async function a(b, skip) { const s = skip ? ${call} : (Object.assign(b, { pw: x }), ${call}); if (!s.ok) return; save({ passwordHash: await hash(b.pw, 12) }); }`),
    ).toEqual([false]);
  });

  it("extends the change window to the end of a loop the writer sits in (#4764)", () => {
    const guarded = (source: string) => scan(source).map((s) => s.screenedBefore);
    const screen = `const s = await screenChosenPassword(b.pw); if (!s.ok) return;`;
    const write = `save({ passwordHash: await hash(b.pw, 12) });`;
    const change = `Object.assign(b, { pw: x });`;
    const inFn = (body: string) => guarded(`async function a(b, xs, ys, x) { ${body} }`);
    // The issue's example, and each loop kind: the change runs before the writer on the next pass.
    expect(inFn(`${screen} for (const x of xs) { ${write} ${change} }`)).toEqual([false]);
    expect(inFn(`${screen} for (const k in xs) { ${write} ${change} }`)).toEqual([false]);
    expect(inFn(`${screen} for (let i = 0; i < 3; i++) { ${write} ${change} }`)).toEqual([false]);
    expect(inFn(`${screen} while (more()) { ${write} ${change} }`)).toEqual([false]);
    expect(inFn(`${screen} do { ${write} ${change} } while (more());`)).toEqual([false]);
    // A braceless body, a write through an alias and a plain property write.
    expect(inFn(`${screen} for (const x of xs) { ${write} const al = b; al.pw = x; }`)).toEqual([false]);
    expect(inFn(`${screen} for (const y of ys) { ${write} b.pw = y; }`)).toEqual([false]);
    // The loop's own header changes the object between passes.
    expect(inFn(`${screen} for (let i = 0; i < 3; mutate(b)) { ${write} }`)).toEqual([false]);
    expect(inFn(`${screen} while (mutate(b)) { ${write} }`)).toEqual([false]);
    expect(inFn(`${screen} do { ${write} } while (mutate(b));`)).toEqual([false]);
    // Nested loops: the change after the inner loop, in the outer body, still comes first on the next outer pass.
    expect(inFn(`${screen} for (const x of xs) { for (const y of ys) { ${write} } ${change} }`)).toEqual([false]);
    expect(inFn(`${screen} while (more()) { do { ${write} } while (again()); ${change} }`)).toEqual([false]);
    expect(inFn(`${screen} for (const x of xs) { ${change} for (const y of ys) { ${write} } }`)).toEqual([false]);
    // The writer in a callback in the loop runs on each pass as well.
    expect(inFn(`${screen} for (const x of xs) { await tx(async () => { ${write} }); ${change} }`)).toEqual([false]);
    // A change before the writer in the loop was already refused.
    expect(inFn(`${screen} for (const x of xs) { ${change} ${write} }`)).toEqual([false]);
    // No false positives: the plain loop, a change after the loop, one outside any loop after the
    // writer (a stated limit), a change to another value, and a loop that screens on each pass.
    expect(inFn(`${screen} for (const x of xs) { ${write} }`)).toEqual([true]);
    expect(inFn(`${screen} for (const x of xs) { ${write} } ${change}`)).toEqual([true]);
    expect(inFn(`${screen} ${write} ${change}`)).toEqual([true]);
    expect(inFn(`${screen} ${write} for (const x of xs) { ${change} }`)).toEqual([true]);
    expect(inFn(`${screen} for (const x of xs) { ${write} log(b.other); b.other = x; }`)).toEqual([true]);
    expect(inFn(`${screen} for (const x of xs) { ${write} } for (const y of ys) { ${change} }`)).toEqual([true]);
    expect(inFn(`for (const x of xs) { ${screen} ${write} ${change} }`)).toEqual([true]);
    expect(inFn(`${screen} for (const x of xs) { for (const y of ys) { ${write} } }`)).toEqual([true]);
    expect(inFn(`${screen} for (const x of xs) { const t = x; ${write} log(t); }`)).toEqual([true]);
    // A screen inside the loop's body, with the change after the writer in the same pass, is screened again on the next.
    expect(inFn(`while (more()) { ${screen} ${write} ${change} }`)).toEqual([true]);
    // A loop only starts the window after the screen: one wrapped around the screen does not extend it.
    expect(inFn(`for (const x of xs) { { ${screen} ${write} } ${change} }`)).toEqual([true]);
    // The loop must end the change window only for loops around the writer, not a sibling before it.
    expect(inFn(`for (const y of ys) { log(y); } ${screen} ${write} ${change}`)).toEqual([true]);
  });

  it("covers a writer in a function that runs after a change, or before the screen (#4764)", () => {
    const guarded = (source: string) => scan(source).map((s) => s.screenedBefore);
    const screen = `const s = await screenChosenPassword(b.pw); if (!s.ok) return;`;
    const body = `save({ passwordHash: hashSync(b.pw, 12) })`;
    const change = `Object.assign(b, { pw: x });`;
    const inFn = (code: string) => guarded(`async function a(b, xs, x, db) { ${code} }`);
    // The issue's input: a closure made after the screen, called after a change.
    expect(inFn(`${screen} const w = () => ${body}; ${change} w();`)).toEqual([false]);
    expect(inFn(`${screen} const w = () => ${body}; ${change} await db.$transaction(w);`)).toEqual([false]);
    expect(inFn(`${screen} setTimeout(async () => { ${body}; }, 0); ${change}`)).toEqual([false]);
    expect(inFn(`${screen} const fs = []; for (const y of xs) { fs.push(() => ${body}); } ${change} fs.forEach((f) => f());`)).toEqual([false]);
    expect(inFn(`${screen} function w() { ${body}; } ${change} w();`)).toEqual([false]);
    expect(inFn(`${screen} const w = function () { ${body}; }; ${change} w();`)).toEqual([false]);
    expect(inFn(`${screen} const o = { w() { ${body}; } }; ${change} o.w();`)).toEqual([false]);
    // A change made while a callback to `$transaction` is the writer's own function.
    expect(inFn(`${screen} await db.$transaction(async () => { ${body}; }); ${change}`)).toEqual([false]);
    // No false positives: a closure with no change after it, or one that only reads.
    expect(inFn(`${screen} const w = () => ${body}; w();`)).toEqual([true]);
    expect(inFn(`${screen} const w = () => ${body}; log(b.other); w();`)).toEqual([true]);
    expect(inFn(`${screen} await db.$transaction(async () => { ${body}; });`)).toEqual([true]);
    expect(inFn(`${screen} setTimeout(() => { ${body}; log(b.pw); }, 0); b.other = 1;`)).toEqual([true]);
    // A change before the screen is never in the window.
    expect(inFn(`${change} ${screen} const w = () => ${body}; w();`)).toEqual([true]);
    // A screen inside the closure holds the screen and the write, so a change outside it does not count.
    expect(inFn(`const w = async () => { ${screen} ${body}; }; ${change} await w();`)).toEqual([true]);
    // The issue's input for a hoisted declaration: it can be called before the screen.
    expect(guarded(`async function a(b) { await g(); ${screen} async function g() { save({ passwordHash: await hash(b.pw, 12) }); } }`)).toEqual([false]);
    expect(guarded(`async function a(b) { g(); ${screen} function g() { save({ passwordHash: hashSync(b.pw, 12) }); } }`)).toEqual([false]);
    expect(guarded(`async function a(b) { ${screen} async function g() { save({ passwordHash: await hash(b.pw, 12) }); } await g(); }`)).toEqual([false]);
    // No false positives: the screen in the declaration's own body, an unrelated declaration,
    // and an arrow function (not hoisted) after the screen.
    expect(guarded(`async function a(b) { async function g() { ${screen} save({ passwordHash: await hash(b.pw, 12) }); } await g(); }`)).toEqual([true]);
    expect(guarded(`async function a(b) { ${screen} function unrelated() { log(b.other); } save({ passwordHash: hashSync(b.pw, 12) }); }`)).toEqual([true]);
    expect(guarded(`async function a(b) { ${screen} const g = async () => { save({ passwordHash: await hash(b.pw, 12) }); }; await g(); }`)).toEqual([true]);
  });

  it("applies the loop window to a copy and to the writer a copy came from (#4764)", () => {
    const sources = (source: string) => scan(source).map((s) => s.source);
    const screen = `const s = await screenChosenPassword(b.pw); if (!s.ok) return;`;
    const built = `const data = { passwordHash: await hash(randomUUID(), 12) };`;
    const copy = `save({ passwordHash: data.passwordHash });`;
    const change = `Object.assign(data, x);`;
    const inFn = (body: string) => sources(`async function a(b, xs, x) { ${body} }`);
    // A change after the copy in a loop, with the object built before or inside it (the copy window runs to the end of the scope).
    expect(inFn(`${built} for (const x of xs) { ${copy} ${change} }`)).toEqual(["random", "unknown"]);
    expect(inFn(`for (const x of xs) { ${built} ${copy} ${change} }`)).toEqual(["random", "unknown"]);
    expect(inFn(`${built} while (more()) { ${copy} ${change} }`)).toEqual(["random", "unknown"]);
    // A change after the copy outside any loop is refused too, and no change keeps the copy.
    expect(inFn(`${built} ${copy} ${change}`)).toEqual(["random", "unknown"]);
    expect(inFn(`${built} for (const x of xs) { ${copy} }`)).toEqual(["random", "copy"]);
    // The copied writer is screened: a change to the screened password later in its loop voids the screen, and so the copy.
    const screenedBuild = `const data = { passwordHash: await hash(b.pw, 12) };`;
    expect(inFn(`${screen} for (const x of xs) { ${screenedBuild} ${copy} Object.assign(b, { pw: x }); }`)).toEqual(["unknown", "unknown"]);
    expect(inFn(`${screen} for (const x of xs) { ${screenedBuild} ${copy} }`)).toEqual(["unknown", "copy"]);
    // A change after the screened writer outside any loop stays out of scope.
    expect(inFn(`${screen} ${screenedBuild} ${copy} Object.assign(b, { pw: x });`)).toEqual(["unknown", "copy"]);
  });

  it("refuses a copy whose object is changed after it is built (#4746)", () => {
    const sources = (source: string) => scan(source).map((s) => s.source);
    const built = `const data = { passwordHash: await hash(randomUUID(), 12) };`;
    const copy = `save({ passwordHash: data.passwordHash });`;
    const made = `await Promise.all(list.map(async (r) => ({ ...r, passwordHash: await hash(randomBytes(16).toString("hex"), 12) })))`;
    const loop = `for (const row of rows) save({ passwordHash: row.passwordHash });`;
    // No false positives: the plain vetted copy, and reads, still pass.
    expect(sources(`async function a() { ${built} ${copy} }`)).toEqual(["random", "copy"]);
    expect(sources(`async function a(list) { const rows = ${made}; ${loop} }`)).toEqual(["random", "copy"]);
    expect(sources(`async function a() { ${built} log(data.passwordHash, data.other); const al = data; use(al.other); save({ passwordHash: data.passwordHash, x: data.x }); }`)).toEqual(["random", "copy"]);
    expect(sources(`async function a(list) { const rows = ${made}; rows.some((r) => r.ok); rows.map((r) => r.id); ${loop} }`)).toEqual(["random", "copy"]);
    // A chain of arrays: the call that builds the next one is not a hand-over.
    expect(sources(`async function a(list) { const pending = await Promise.all(list.map(async (r) => ({ ...r, passwordHash: await hash(randomBytes(16).toString("hex"), 12) }))); const rows = await Promise.all(pending); ${loop} }`)).toEqual(["random", "copy"]);
    // The issue's examples: a later assign, or an element written.
    expect(sources(`async function a(body) { ${built} Object.assign(data, body); ${copy} }`)).toEqual(["random", "unknown"]);
    expect(sources(`async function a(list, body) { const rows = ${made}; rows[0] = body; ${loop} }`)).toEqual(["random", "unknown"]);
    // Any write to the object, a computed key, or a write through an alias.
    expect(sources(`async function a() { ${built} data.k = 1; ${copy} }`)).toEqual(["random", "unknown"]);
    expect(sources(`async function a(k) { ${built} data[k] = 1; ${copy} }`)).toEqual(["random", "unknown"]);
    expect(sources(`async function a() { ${built} const al = data; al.k = 1; ${copy} }`)).toEqual(["random", "unknown"]);
    expect(sources(`async function a() { ${built} const al = data; const al2 = al; al2["k"] = 1; ${copy} }`)).toEqual(["random", "unknown"]);
    expect(sources(`async function a() { ${built} let al; al = data; al.k = 1; ${copy} }`)).toEqual(["random", "unknown"]);
    // Handed to a call, a constructor or a spread argument.
    expect(sources(`async function a() { ${built} log(data); ${copy} }`)).toEqual(["random", "unknown"]);
    expect(sources(`async function a(body) { ${built} Object.assign(data, ...body); ${copy} }`)).toEqual(["random", "unknown"]);
    expect(sources(`async function a() { ${built} new Thing(data); ${copy} }`)).toEqual(["random", "unknown"]);
    expect(sources(`async function a() { ${built} const al = data; mutate(al); ${copy} }`)).toEqual(["random", "unknown"]);
    // An array of objects: handed on, an element added, or the loop variable written.
    expect(sources(`async function a(list) { const rows = ${made}; mutate(rows); ${loop} }`)).toEqual(["random", "unknown"]);
    expect(sources(`async function a(list, body) { const rows = ${made}; rows.push(body); ${loop} }`)).toEqual(["random", "unknown"]);
    expect(sources(`async function a(list, body) { const rows = ${made}; rows.splice(0, 1, body); ${loop} }`)).toEqual(["random", "unknown"]);
    expect(sources(`async function a(list) { const rows = ${made}; for (const row of rows) { row.k = 1; save({ passwordHash: row.passwordHash }); } }`)).toEqual(["random", "unknown"]);
    expect(sources(`async function a(list) { const rows = ${made}; for (const row of rows) { mutate(row); save({ passwordHash: row.passwordHash }); } }`)).toEqual(["random", "unknown"]);
    expect(sources(`async function a(list, body) { const pending = await Promise.all(list.map(async (r) => ({ ...r, passwordHash: await hash(randomBytes(16).toString("hex"), 12) }))); pending[0] = body; const rows = await Promise.all(pending); ${loop} }`)).toEqual(["random", "unknown"]);
    // A change in a nested callback counts too.
    expect(sources(`async function a(list, body) { ${built} list.forEach((x) => { data.k = x; }); ${copy} }`)).toEqual(["random", "unknown"]);
    // An element of the copied array, changed through a call or an alias (#4746 review).
    const inRows = (change: string) => sources(`async function a(list, body) { const rows = ${made}; ${change} ${loop} }`);
    expect(inRows(`Object.assign(rows[0], body);`)).toEqual(["random", "unknown"]);
    expect(inRows(`const r = rows[0]; Object.assign(r, body);`)).toEqual(["random", "unknown"]);
    expect(inRows(`Object.assign(rows.at(0), body);`)).toEqual(["random", "unknown"]);
    expect(inRows(`rows[0].k = 1;`)).toEqual(["random", "unknown"]);
    expect(inRows(`rows["0"]["k"] = 1;`)).toEqual(["random", "unknown"]);
    expect(inRows(`Object.assign(rows["0"], body);`)).toEqual(["random", "unknown"]);
    expect(inRows(`const k = 0; rows[k].x = 1;`)).toEqual(["random", "unknown"]);
    // Elements changed through iteration.
    expect(inRows(`for (const r of rows) Object.assign(r, body);`)).toEqual(["random", "unknown"]);
    expect(inRows(`rows.forEach((r) => Object.assign(r, body));`)).toEqual(["random", "unknown"]);
    expect(inRows(`let r; for (r of rows) Object.assign(r, body);`)).toEqual(["random", "unknown"]);
    expect(inRows(`rows.map((r) => Object.assign(r, body));`)).toEqual(["random", "unknown"]);
    expect(inRows(`rows.forEach((r) => { r.k = 1; });`)).toEqual(["random", "unknown"]);
    // The object or array handed to a call inside a literal, or an alias built from one.
    expect(sources(`async function a(body) { ${built} mutate({ data }); ${copy} }`)).toEqual(["random", "unknown"]);
    expect(sources(`async function a(body) { ${built} mutate([data]); ${copy} }`)).toEqual(["random", "unknown"]);
    expect(sources(`async function a(body) { ${built} const h = { d: data }; Object.assign(h.d, body); ${copy} }`)).toEqual(["random", "unknown"]);
    expect(sources(`async function a(body) { ${built} mutate(f ? data : {}); ${copy} }`)).toEqual(["random", "unknown"]);
    // An alias made through a conditional, a logical operator or a logical assignment.
    expect(sources(`async function a(body) { ${built} const t = f ? data : {}; Object.assign(t, body); ${copy} }`)).toEqual(["random", "unknown"]);
    expect(sources(`async function a(body) { ${built} let al; al ||= data; Object.assign(al, body); ${copy} }`)).toEqual(["random", "unknown"]);
    expect(sources(`async function a(body) { ${built} let al; al ??= data; Object.assign(al, body); ${copy} }`)).toEqual(["random", "unknown"]);
    expect(sources(`async function a(body) { ${built} const t = other || data; Object.assign(t, body); ${copy} }`)).toEqual(["random", "unknown"]);
    expect(sources(`async function a(body) { ${built} const t = f ? {} : data; Object.assign(t, body); ${copy} }`)).toEqual(["random", "unknown"]);
    expect(sources(`async function a(body) { ${built} const t = (x, data); Object.assign(t, body); ${copy} }`)).toEqual(["random", "unknown"]);
    // A closure defined before the object, called after it.
    expect(sources(`async function a(body) { function f() { Object.assign(data, body); } ${built} f(); ${copy} }`)).toEqual(["random", "unknown"]);
    expect(sources(`async function a(body) { const f = () => Object.assign(data, body); ${built} f(); ${copy} }`)).toEqual(["random", "unknown"]);
    // A method call on the object or array: only a small read-only list is allowed.
    expect(sources(`async function a(body) { ${built} data.reset(body); ${copy} }`)).toEqual(["random", "unknown"]);
    expect(sources(`async function a(body) { ${built} data["reset"](body); ${copy} }`)).toEqual(["random", "unknown"]);
    expect(sources(`async function a(list) { const rows = ${made}; rows.sort(); ${loop} }`)).toEqual(["random", "unknown"]);
    expect(sources(`async function a(body) { ${built} tag\`${"${data}"}\`; ${copy} }`)).toEqual(["random", "unknown"]);
    // A transaction callback holds the build and the copy: a hand-over inside it still counts, nothing outside it does.
    expect(sources(`async function a(body) { await tx(async () => { ${built} mutate(data); ${copy} }); }`)).toEqual(["random", "unknown"]);
    expect(sources(`async function a(body) { await tx(async () => { ${built} ${copy} }); mutate(other); }`)).toEqual(["random", "copy"]);
    // The elements of an array literal or of a container alias are the object itself (#4746 round 3).
    const inData = (change: string) => sources(`async function a(body, list, f, other) { ${built} ${change} ${copy} }`);
    expect(inData(`[data].forEach((x) => Object.assign(x, body));`)).toEqual(["random", "unknown"]);
    expect(inData(`for (const x of [data]) Object.assign(x, body);`)).toEqual(["random", "unknown"]);
    expect(inData(`const h = [data]; for (const x of h) Object.assign(x, body);`)).toEqual(["random", "unknown"]);
    expect(inData(`const h = [data]; h.forEach((x) => Object.assign(x, body));`)).toEqual(["random", "unknown"]);
    // A callback method is read-only only with an inline function: a named one receives the elements.
    expect(inRows(`rows.forEach(mutate);`)).toEqual(["random", "unknown"]);
    expect(inRows(`rows.map(mutate);`)).toEqual(["random", "unknown"]);
    expect(inRows(`rows.some(mutate);`)).toEqual(["random", "unknown"]);
    expect(inRows(`rows.every(...fns);`)).toEqual(["random", "unknown"]);
    expect(inData(`[data].forEach(mutate);`)).toEqual(["random", "unknown"]);
    // Every parameter of an inline callback holds the elements or the array; `arguments` is refused.
    expect(inRows(`rows.forEach((r, i, arr) => { arr[0] = body; });`)).toEqual(["random", "unknown"]);
    expect(inRows(`rows.forEach((...args) => Object.assign(args[0], body));`)).toEqual(["random", "unknown"]);
    expect(inRows(`rows.forEach(function () { Object.assign(arguments[0], body); });`)).toEqual(["random", "unknown"]);
    // An alias made by writing to a property of an object or array.
    expect(inData(`const h = {}; h.d = data; Object.assign(h.d, body);`)).toEqual(["random", "unknown"]);
    expect(inData(`const h = []; h[0] = data; Object.assign(h[0], body);`)).toEqual(["random", "unknown"]);
    // An assignment used as an expression hands over what it assigns.
    expect(inData(`let x; Object.assign(x = data, body);`)).toEqual(["random", "unknown"]);
    expect(inData(`let x; Object.assign(x ||= data, body);`)).toEqual(["random", "unknown"]);
    expect(inData(`let x = data; Object.assign(x ??= other, body);`)).toEqual(["random", "unknown"]);
    expect(inData(`let x = data; Object.assign(x &&= other, body);`)).toEqual(["random", "unknown"]);
    // No false positive for the same shapes over other values, or inline read-only callbacks.
    expect(inData(`const h = [data.passwordHash]; for (const x of h) log(x);`)).toEqual(["random", "copy"]);
    expect(inRows(`rows.forEach((r, i, arr) => log(r.id, i, arr.length)); rows.map((...a) => a.length);`)).toEqual(["random", "copy"]);
    expect(inData(`const h = {}; h.d = other; let x; log(x = other);`)).toEqual(["random", "copy"]);
    // No false positive: reads, literals of other parts, read-only methods, an unrelated alias.
    expect(inRows(`const n = rows.length; const ids = rows.map((r) => r.id); log({ n, ids, first: rows[0].id });`)).toEqual(["random", "copy"]);
    expect(inRows(`for (const r of rows) log(r.id, { id: r.id });`)).toEqual(["random", "copy"]);
    expect(inRows(`rows.forEach((r) => log(r.passwordHash)); rows.some((r) => r.ok); rows.every((r) => r.ok);`)).toEqual(["random", "copy"]);
    expect(sources(`async function a(body) { ${built} const h = { d: data.passwordHash }; Object.assign(h, body); mutate({ x: data.other }); ${copy} }`)).toEqual(["random", "copy"]);
    expect(sources(`async function a(body) { ${built} const t = f ? other : {}; Object.assign(t, body); ${copy} } `)).toEqual(["random", "copy"]);
    expect(sources(`async function a(body) { function f() { Object.assign(other, body); } ${built} f(); ${copy} }`)).toEqual(["random", "copy"]);
    // An element of a holder is the object itself: reading its fields is not a change,
    // but writing them still is.
    expect(sources(`async function a() { ${built} for (const x of [data]) log(x.id); ${copy} }`)).toEqual(["random", "copy"]);
    expect(sources(`async function a() { ${built} [data].forEach((x) => log(x.id)); ${copy} }`)).toEqual(["random", "copy"]);
    expect(sources(`async function a(body) { ${built} for (const x of [data]) x.k = body; ${copy} }`)).toEqual(["random", "unknown"]);
    // Another function's object of the same name is not this one.
    expect(sources(`async function a() { ${built} ${copy} } function b(data) { data.k = 1; log(data); }`)).toEqual(["random", "copy"]);
  });

  it("voids a screen when the screened object is changed through an alias or a call (#4746)", () => {
    const guarded = (source: string) => scan(source).map((s) => s.screenedBefore);
    const screen = `const s = await screenChosenPassword(b.pw); if (!s.ok) return;`;
    const write = `save({ passwordHash: await hash(b.pw, 12) });`;
    // The issue's examples.
    expect(guarded(`async function a(b) { ${screen} const al = b; al.pw = b.other; ${write} }`)).toEqual([false]);
    expect(guarded(`async function a(b) { ${screen} Object.assign(b, { pw: b.other }); ${write} }`)).toEqual([false]);
    // An alias of the root: plain, chained, assigned later, destructured, written by key.
    expect(guarded(`async function a(b) { ${screen} const al = b; const al2 = al; al2.pw = typed; ${write} }`)).toEqual([false]);
    expect(guarded(`async function a(b) { ${screen} let al; al = b; al["pw"] = typed; ${write} }`)).toEqual([false]);
    expect(guarded(`async function a(b) { ${screen} const al = b; al[k] = typed; ${write} }`)).toEqual([false]);
    expect(guarded(`async function a(b) { ${screen} const { data } = b; data.pw = typed; ${write} }`)).toEqual([false]);
    expect(guarded(`async function a(b) { const al = b; ${screen} al.pw = typed; ${write} }`)).toEqual([false]);
    // Any call that receives the root, or a part of the path above the value.
    expect(guarded(`async function a(b) { ${screen} mutate(b); ${write} }`)).toEqual([false]);
    expect(guarded(`async function a(b) { ${screen} new Thing(b); ${write} }`)).toEqual([false]);
    expect(guarded(`async function a(b) { ${screen} mutate(...b); ${write} }`)).toEqual([false]);
    expect(guarded(`async function a(b) { ${screen} const al = b; mutate(al); ${write} }`)).toEqual([false]);
    expect(guarded(`async function a(b) { const s = await screenChosenPassword(b.data.pw); if (!s.ok) return; mutate(b.data); save({ passwordHash: await hash(b.data.pw, 12) }); }`)).toEqual([false]);
    // No false positives: the plain screened write, other paths, a call or
    // alias before the screen, an unused alias, a value passed on.
    expect(guarded(`async function a(b) { ${screen} ${write} }`)).toEqual([true]);
    expect(guarded(`async function a(b) { ${screen} const al = b; log(al.other); ${write} }`)).toEqual([true]);
    expect(guarded(`async function a(b) { ${screen} const al = b; ${write} }`)).toEqual([true]);
    expect(guarded(`async function a(b) { ${screen} log(b.other, b.pw); ${write} }`)).toEqual([true]);
    expect(guarded(`async function a(b) { validate(b); ${screen} ${write} }`)).toEqual([true]);
    expect(guarded(`async function a(b) { const al = b; al.pw = typed; ${screen} ${write} }`)).toEqual([true]);
    expect(guarded(`async function a(b) { ${screen} const al = b.other; al.pw = typed; mutate(b.other); ${write} }`)).toEqual([true]);
    expect(guarded(`async function a(b) { ${screen} mutate(b); } async function c(b) { ${screen} ${write} }`)).toEqual([true]);
    expect(guarded(`async function a(b) { const s = await screenChosenPassword(b.data.pw); if (!s.ok) return; mutate(b.other); save({ passwordHash: await hash(b.data.pw, 12) }); }`)).toEqual([true]);
    // An object or array handed to a call inside a literal, or an alias built from one (#4746 review).
    expect(guarded(`async function a(b) { ${screen} mutate({ b }); ${write} }`)).toEqual([false]);
    expect(guarded(`async function a(b) { ${screen} mutate([b]); ${write} }`)).toEqual([false]);
    expect(guarded(`async function a(b) { ${screen} const h = { b }; h.b.pw = typed; ${write} }`)).toEqual([false]);
    expect(guarded(`async function a(b) { ${screen} const h = [b]; h[0].pw = typed; ${write} }`)).toEqual([false]);
    // An alias made through a conditional, a logical operator, a destructuring assignment or a logical assignment.
    expect(guarded(`async function a(b) { ${screen} const al = c ? b : {}; al.pw = typed; ${write} }`)).toEqual([false]);
    expect(guarded(`async function a(b) { ${screen} const al = c || b; al.pw = typed; ${write} }`)).toEqual([false]);
    expect(guarded(`async function a(b) { ${screen} const al = c ?? b; al.pw = typed; ${write} }`)).toEqual([false]);
    expect(guarded(`async function a(b) { ${screen} const al = (x, b); al.pw = typed; ${write} }`)).toEqual([false]);
    expect(guarded(`async function a(b) { let al; ({ x: al } = { x: b }); ${screen} al.pw = typed; ${write} }`)).toEqual([false]);
    expect(guarded(`async function a(b) { let al; ${screen} ({ x: al } = { x: b }); al.pw = typed; ${write} }`)).toEqual([false]);
    expect(guarded(`async function a(b) { let al; ${screen} al ||= b; al.pw = typed; ${write} }`)).toEqual([false]);
    expect(guarded(`async function a(b) { let al; ${screen} al ??= b; al.pw = typed; ${write} }`)).toEqual([false]);
    // A closure defined before the screen, called after it.
    expect(guarded(`async function a(b) { const f = () => Object.assign(b, { pw: typed }); ${screen} f(); ${write} }`)).toEqual([false]);
    expect(guarded(`async function a(b) { function f() { b.pw = typed; } ${screen} f(); ${write} }`)).toEqual([false]);
    expect(guarded(`async function a(b) { const f = () => mutate(b); ${screen} f(); ${write} }`)).toEqual([false]);
    // A method call on the root, a change inside the screen statement itself, a tagged template.
    expect(guarded(`async function a(b) { ${screen} b.reset(typed); ${write} }`)).toEqual([false]);
    expect(guarded(`async function a(b) { ${screen} b["reset"](typed); ${write} }`)).toEqual([false]);
    expect(guarded(`async function a(b) { const s = await screenChosenPassword(b.pw, Object.assign(b, { pw: typed }) && undefined); if (!s.ok) return; ${write} }`)).toEqual([false]);
    expect(guarded(`async function a(b) { ${screen} tag\`${"${b}"}\`; ${write} }`)).toEqual([false]);
    // A transaction callback holds the screen and the write: only what runs inside it, after the screen, counts.
    expect(guarded(`async function a(b) { await tx(async () => { validate(b); ${screen} ${write} }); }`)).toEqual([true]);
    expect(guarded(`async function a(b) { await tx(async () => { ${screen} mutate(b); ${write} }); }`)).toEqual([false]);
    // The elements of an array literal, a named callback, a property alias and an assignment expression (#4746 round 3).
    const after = (change: string) => guarded(`async function a(b, typed, mutate) { ${screen} ${change} ${write} }`);
    expect(after(`for (const x of [b]) x.pw = typed;`)).toEqual([false]);
    expect(after(`[b].forEach((x) => { x.pw = typed; });`)).toEqual([false]);
    expect(after(`[b].forEach(mutate);`)).toEqual([false]);
    expect(after(`const h = {}; h.b = b; h.b.pw = typed;`)).toEqual([false]);
    expect(after(`let al; Object.assign(al = b, { pw: typed });`)).toEqual([false]);
    expect(after(`[b.other].forEach((x) => log(x)); let al; log(al = b.other);`)).toEqual([true]);
    // A computed key may name any part of the path.
    expect(guarded(`async function a(b, k) { const s = await screenChosenPassword(b.data.pw); if (!s.ok) return; mutate(b[k]); save({ passwordHash: await hash(b.data.pw, 12) }); }`)).toEqual([false]);
    // A write through an element access on the path (the root's own name, or an alias).
    expect(guarded(`async function a(b) { const s = await screenChosenPassword(b.data.pw); if (!s.ok) return; b["data"].pw = typed; save({ passwordHash: await hash(b.data.pw, 12) }); }`)).toEqual([false]);
    expect(guarded(`async function a(b) { const s = await screenChosenPassword(b.data.pw); if (!s.ok) return; const al = b; al["data"].pw = typed; save({ passwordHash: await hash(b.data.pw, 12) }); }`)).toEqual([false]);
    expect(guarded(`async function a(b) { const s = await screenChosenPassword(b.data.pw); if (!s.ok) return; b["data"]["pw"] = typed; save({ passwordHash: await hash(b.data.pw, 12) }); }`)).toEqual([false]);
    expect(guarded(`async function a(b, k) { const s = await screenChosenPassword(b.pw); if (!s.ok) return; b[k] = typed; save({ passwordHash: await hash(b.pw, 12) }); }`)).toEqual([false]);
    // The screened and the hashed value may be named by literal keys, but never by a computed one.
    expect(guarded(`async function a(b) { const s = await screenChosenPassword(b["pw"]); if (!s.ok) return; save({ passwordHash: await hash(b.pw, 12) }); }`)).toEqual([true]);
    expect(guarded(`async function a(b, k, j) { const s = await screenChosenPassword(b[k]); if (!s.ok) return; save({ passwordHash: await hash(b[j], 12) }); }`)).toEqual([false]);
    // No false positive: read-only methods on the value, literals of other parts, a closure unrelated to it.
    expect(guarded(`async function a(b) { ${screen} log({ x: b.other }, [b.other]); b.pw.trim(); b.other.reset(); ${write} }`)).toEqual([true]);
    expect(guarded(`async function a(b) { const f = () => mutate(other); ${screen} f(); const al = c ? b.other : {}; al.pw = typed; ${write} }`)).toEqual([true]);
    expect(guarded(`async function a(b) { ${screen} ${write} const g = () => mutate(b); }`)).toEqual([true]);
    expect(guarded(`async function a(b) { const s = await screenChosenPassword(b.pw, { userInputs: [b] }); if (!s.ok) return; ${write} }`)).toEqual([true]);
    // An element of a holder is the screened object: a read keeps the screen, a write voids it.
    expect(guarded(`async function a(b) { ${screen} [b].forEach((x) => log(x.id)); ${write} }`)).toEqual([true]);
    expect(guarded(`async function a(b) { ${screen} for (const x of [b]) log(x.id); ${write} }`)).toEqual([true]);
    expect(guarded(`async function a(b) { ${screen} for (const x of [b]) x.pw = typed; ${write} }`)).toEqual([false]);
    // A plain string cannot be changed from outside.
    expect(guarded(`async function a(p) { const s = await screenChosenPassword(p); if (!s.ok) return; log(p); const al = p; ${`save({ passwordHash: await hash(p, 12) });`} }`)).toEqual([true]);
    // A const root works like a parameter.
    expect(guarded(`async function a(req) { const b = await req.json(); ${screen} const al = b; al.pw = typed; ${write} }`)).toEqual([false]);
    expect(guarded(`async function a(req) { const b = await req.json(); ${screen} ${write} }`)).toEqual([true]);
  });
});
