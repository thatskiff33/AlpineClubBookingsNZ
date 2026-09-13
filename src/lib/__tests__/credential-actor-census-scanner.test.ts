/**
 * The credential-actor census SCANNER, exercised against synthetic trees (#2723).
 *
 * WHY THIS FILE EXISTS SEPARATELY from `credential-actor-census.test.ts`. That
 * file is the CONTRACT: it scans the real repository and compares the answer
 * against the reviewed manifest. It can only ever prove things about writers
 * that already exist, and every writer in the tree today names an actor — so it
 * is green whether the walk works or not.
 *
 * The acceptance criterion #2723 actually turns on is the opposite one: **a
 * seeded actorless writer must fail the guard.** That is what this file proves,
 * by seeding one. Each fixture below writes a credential the way a future
 * author plausibly would, and asserts the census reports it rather than
 * returning a clean bill of health.
 *
 * The fixtures are not invented shapes. They are the four bypasses a review of
 * the audit census demonstrated against a scanner that had already shipped
 * (#2581) — a delegate parked in a local, a delegate reached by element access,
 * raw SQL from TypeScript, and a migration's own SQL — plus the two this
 * census's own boundary turns on: a spread whose keys cannot be read must fail
 * CLOSED, and a plain read must NOT be reported. A scanner that flagged
 * `findMany` would be switched off within a week.
 *
 * WHAT EACH TEST WOULD CATCH: delete the corresponding branch of the walk and
 * its fixture goes from "reported" back to "invisible", while the real-tree
 * contract stays green either way — because the real tree contains none of
 * these shapes. That false assurance is exactly what this file removes.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  describeCredentialActor,
  describeCredentialExpectation,
  scanCredentialActorCensus,
} from "../../../scripts/audit/credential-actor-census";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A minimal repository: the roots the census walks, plus whichever files the
 * fixture needs. Anything not written stays empty, so a fixture's report
 * contains only what the fixture put there.
 */
function tree(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "credential-census-"));
  roots.push(root);
  for (const dir of ["src", "scripts", "e2e", "prisma"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  return scanCredentialActorCensus(root);
}

function sites(census: ReturnType<typeof scanCredentialActorCensus>) {
  return census.sites.map((site) => ({
    mutator: site.mutator,
    actor: describeCredentialActor(site.actor),
    expectation: describeCredentialExpectation(site.expectation),
  }));
}

describe("credential-actor census scanner: a seeded actorless writer (#2723)", () => {
  it("REPORTS a writer that passes no actor at all", () => {
    // THE ACCEPTANCE CRITERION. This is the exact shape the store's required
    // argument makes uncompilable; the census is the second line, for the value
    // that reaches the call through a cast or from untyped JavaScript.
    const census = tree({
      "src/lane.ts": `
        import { setIntegrationCredential } from "@/lib/integration-credentials";
        export async function save(value: string) {
          await setIntegrationCredential({
            provider: "stripe",
            key: "secret_key",
            value,
          } as never);
        }
      `,
    });

    expect(sites(census)).toEqual([
      { mutator: "setIntegrationCredential", actor: "(absent)", expectation: "(absent)" },
    ]);
    expect(census.actorless).toHaveLength(1);
    expect(census.actorless[0]?.symbol).toBe("save");
    expect(census.expectationless).toHaveLength(1);
  });

  it("REPORTS a delete that names an actor but declares no expectation", () => {
    const census = tree({
      "src/lane.ts": `
        import { deleteIntegrationCredential } from "@/lib/integration-credentials";
        export async function drop() {
          await deleteIntegrationCredential({
            provider: "google",
            key: "verified_at",
            actor: { kind: "system", actor: "google-verify-reset" },
          } as never);
        }
      `,
    });

    expect(sites(census)).toEqual([
      {
        mutator: "deleteIntegrationCredential",
        actor: "system",
        expectation: "(absent)",
      },
    ]);
    expect(census.actorless).toHaveLength(0);
    expect(census.expectationless).toHaveLength(1);
  });

  it("does NOT ask `ensureGeneratedCredential` for an expectation", () => {
    // Its expectation is not the caller's to choose — create-only, never
    // overwrite a readable row — so a required `expect` there would be a
    // decision with one legal answer. It still requires an actor.
    const census = tree({
      "src/lane.ts": `
        import { ensureGeneratedCredential } from "@/lib/integration-credentials";
        export async function key() {
          return ensureGeneratedCredential({
            provider: "xero",
            key: "token_key",
            label: "xero-token-key:v1",
            generate: () => "k",
            actor: { kind: "system", actor: "xero-token-key-generation" },
          });
        }
      `,
    });

    expect(sites(census)).toEqual([
      {
        mutator: "ensureGeneratedCredential",
        actor: "system",
        expectation: "(not-applicable)",
      },
    ]);
    expect(census.expectationless).toHaveLength(0);
  });
});

describe("credential-actor census scanner: writers that skip the store (#2723)", () => {
  it("REPORTS a direct Prisma write to the credential table", () => {
    const census = tree({
      "src/lane.ts": `
        import { prisma } from "@/lib/prisma";
        export async function save() {
          await prisma.integrationCredential.upsert({
            where: { provider_key: { provider: "x", key: "y" } },
            create: {},
            update: {},
          });
        }
      `,
    });

    expect(census.bypasses.map((bypass) => bypass.statement)).toEqual([
      "integrationCredential.upsert",
    ]);
    expect(census.sites).toHaveLength(0);
  });

  it("REPORTS a delegate parked in a local", () => {
    // Bypass 1 from #2581's review. The receiver is `rows`, not
    // `<something>.integrationCredential`, so a property-access-only check sees
    // nothing at all.
    const census = tree({
      "src/lane.ts": `
        export async function save(tx: any) {
          const rows = tx.integrationCredential;
          await rows.updateMany({ where: {}, data: {} });
        }
      `,
    });

    expect(census.bypasses.map((bypass) => bypass.statement)).toEqual([
      "integrationCredential.updateMany",
    ]);
  });

  it("REPORTS a delegate reached by element access", () => {
    // Bypass 2 from the same review.
    const census = tree({
      "src/lane.ts": `
        export async function save(tx: any) {
          await tx["integrationCredential"].deleteMany({ where: {} });
        }
      `,
    });

    expect(census.bypasses.map((bypass) => bypass.statement)).toEqual([
      "integrationCredential.deleteMany",
    ]);
  });

  it("REPORTS raw SQL DML from TypeScript, including a schema qualifier", () => {
    // Bypass 3 and 5 from the same review: `prisma/**/*.sql` never walks
    // TypeScript, and `"public"."…"` was used to defeat an unqualified regex.
    const census = tree({
      "src/lane.ts": `
        import { prisma } from "@/lib/prisma";
        export async function wipe() {
          await prisma.$executeRawUnsafe(
            'DELETE FROM "public"."IntegrationCredential" WHERE provider = $1',
            "stripe",
          );
        }
      `,
    });

    expect(census.bypasses.map((bypass) => bypass.statement)).toEqual([
      "raw.$executeRawUnsafe",
    ]);
  });

  it("REPORTS a migration that rewrites credential rows", () => {
    // Bypass 4: a migration mutating stored credentials is a change nobody can
    // attribute either, and a TypeScript-only census would call the tree clean.
    const census = tree({
      "prisma/migrations/20260101000000_x/migration.sql": `
        UPDATE "IntegrationCredential" SET "secretSource" = 'AUTH_SECRET';
      `,
    });

    expect(census.bypasses.map((bypass) => bypass.statement)).toEqual([
      "sql.update",
    ]);
  });

  it("does NOT report a plain read — of either kind", () => {
    // The opposite direction, and it matters just as much. Half a dozen config
    // modules read the table directly with `findMany`/`findUnique` on purpose;
    // a census that flagged those would be turned off within a week.
    const census = tree({
      "src/lane.ts": `
        import { prisma } from "@/lib/prisma";
        export async function read() {
          const rows = await prisma.integrationCredential.findMany({ where: {} });
          const one = await prisma.integrationCredential.findUnique({ where: {} });
          const raw = await prisma.$queryRawUnsafe(
            'SELECT provider FROM "IntegrationCredential"',
          );
          return { rows, one, raw };
        }
      `,
    });

    expect(census.bypasses).toEqual([]);
    expect(census.sites).toEqual([]);
  });
});

describe("credential-actor census scanner: reading the call site (#2723)", () => {
  it("fails CLOSED on a params object whose keys it cannot name", () => {
    // A computed key sets a key at run time that the parser cannot resolve, so
    // the whole object is unreadable and the lookup must report "decided
    // elsewhere" rather than the absence it cannot see. Reporting `absent` here
    // would be a FALSE finding; reporting `literal` would be a false clean.
    const census = tree({
      "src/lane.ts": `
        const KEY = "actor";
        export async function save(setIntegrationCredential: any) {
          await setIntegrationCredential({
            provider: "x",
            key: "y",
            value: "z",
            [KEY]: { kind: "admin", memberId: "m" },
            expect: { expect: "any" },
          });
        }
      `,
    });

    expect(sites(census)).toEqual([
      {
        mutator: "setIntegrationCredential",
        actor: "(forwarded) (unreadable keys)",
        // `expect` IS readable here: the fail-closed rule applies to the key
        // the walk could not FIND, not to every key on an object that has one
        // computed name. Reading this as unreadable would be a false finding.
        expectation: "any",
      },
    ]);
    expect(census.actorless).toHaveLength(0);
  });

  it("reads a hoisted actor as forwarded rather than as missing", () => {
    // The shape the backups route uses for nine writes in one handler. It is
    // legitimate and it is PINNED by the contract test, never silently accepted.
    const census = tree({
      "src/lane.ts": `
        import { setIntegrationCredential } from "@/lib/integration-credentials";
        export async function save(memberId: string) {
          const actor = { kind: "admin", memberId } as const;
          const expect = { expect: "any" } as const;
          await setIntegrationCredential({
            provider: "backup",
            key: "bucket",
            value: "b",
            actor,
            expect,
          });
        }
      `,
    });

    expect(sites(census)).toEqual([
      {
        mutator: "setIntegrationCredential",
        actor: "(forwarded) actor",
        expectation: "(forwarded) expect",
      },
    ]);
    expect(census.actorless).toHaveLength(0);
  });

  it("does not count the store's own internal calls", () => {
    // The boundary modules ARE the implementation. Counting their own calls
    // would double every writer and make the population meaningless.
    const census = tree({
      "src/lib/integration-credentials.ts": `
        export async function ensureGeneratedCredential(p: any) {
          return createGeneratedCredential(p);
        }
        async function createGeneratedCredential(p: any) {
          return deleteIntegrationCredential(p);
        }
        export async function deleteIntegrationCredential(p: any) {
          return p;
        }
      `,
      "src/lib/integration-credential-claim.ts": `
        export async function claim(tx: any) {
          await tx.integrationCredential.updateMany({ where: {}, data: {} });
        }
      `,
    });

    expect(census.sites).toEqual([]);
    expect(census.bypasses).toEqual([]);
  });
});
