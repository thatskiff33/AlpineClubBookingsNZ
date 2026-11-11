import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { incompatibleLockTransactions } from "./support/advisory-lock-isolation";

// INV-LOCK-005: no approved exceptions. Any future entry needs its reason here.
const ALLOWED: Readonly<Record<string, string>> = {};

function sources(dir: string): Array<{ file: string; text: string }> {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sources(full);
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.(d|test|spec|integration)\./.test(entry.name)) return [];
    return [{ file: path.relative(process.cwd(), full).replaceAll("\\", "/"), text: fs.readFileSync(full, "utf8") }];
  });
}

describe("advisory lock transaction isolation (INV-LOCK-005)", () => {
  it("keeps lock/re-read transactions at READ COMMITTED throughout src", () => {
    const files = sources(path.join(process.cwd(), "src"));
    expect(files.length).toBeGreaterThan(0);
    const violations = incompatibleLockTransactions(files);
    expect(violations.filter(site => !ALLOWED[site]), "INV-LOCK-005: snapshot isolation hides commits made while waiting on advisory locks").toEqual([]);
    expect(Object.keys(ALLOWED).filter(site => !violations.includes(site)), "stale isolation exceptions").toEqual([]);
  });

  it.each(["Serializable", "RepeatableRead"])("finds %s with inline locks, helpers, aliases and wrappers", level => {
    const result = incompatibleLockTransactions([
      { file: "lock.ts", text: "export async function lock(tx) { await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`; }" },
      { file: "job.ts", text: `import { lock as takeLock } from './lock';
        async function wrapper(tx) { await takeLock(tx); }
        db.$transaction(async tx => { await wrapper(tx); }, { isolationLevel: '${level}' });
        db.$transaction(async tx => { await tx.$executeRaw\`SELECT pg_try_advisory_xact_lock(1)\`; }, { isolationLevel: Prisma.TransactionIsolationLevel.${level} });` },
    ]);
    expect(result).toHaveLength(2);
  });

  it("allows unrelated snapshot transactions and READ COMMITTED lock writers", () => {
    expect(incompatibleLockTransactions([{ file: "safe.ts", text: `
      // pg_advisory_xact_lock(1)
      db.$transaction(async tx => { await tx.member.count(); }, { isolationLevel: 'Serializable' });
      db.$transaction(async tx => { await tx.$executeRaw\`SELECT pg_advisory_xact_lock(1)\`; });
    ` }])).toEqual([]);
  });
});
