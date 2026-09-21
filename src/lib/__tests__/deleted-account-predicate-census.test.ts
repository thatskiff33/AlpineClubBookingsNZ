import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { stripComments } from "./support/strip-comments";

const SRC_DIR = join(import.meta.dirname, "..", "..");
const CANONICAL = "lib/deleted-account.ts";

type ViolationKind =
  | "retired-name"
  | "password-sentinel-comparison"
  | "reserved-address-suffix-copy"
  | "reserved-address-sql-copy"
  | "retired-five-field-shape";

type Violation = { kind: ViolationKind; path: string };

function productionSources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === "__tests__") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) productionSources(full, found);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Find executable copies of every deletion shape retired by #3542.
 *
 * This intentionally accepts imports and calls to the canonical helpers. What
 * it rejects is another place deciding from the old password sentinel, testing
 * the reserved suffix itself, reconstructing the suffix as SQL, or restoring
 * the deletion route's five-field AND. Comments are stripped through the
 * repository's one scanner so a postmortem cannot satisfy the census.
 */
export function retiredDeletionPredicateViolations(
  source: string,
  path = "fixture.ts",
): Violation[] {
  const code = stripComments(source);
  const violations: Violation[] = [];
  const add = (kind: ViolationKind) => violations.push({ kind, path });

  if (/\b(?:isDeletedAccountMarker|isMemberAnonymised)\b/.test(code)) {
    add("retired-name");
  }
  if (
    /\bpasswordHash\b\s*(?:===?|!==?)\s*DELETED_ACCOUNT_PASSWORD_HASH\b/.test(
      code,
    ) ||
    /\bDELETED_ACCOUNT_PASSWORD_HASH\b\s*(?:===?|!==?)\s*[^;\n]*\bpasswordHash\b/.test(
      code,
    )
  ) {
    add("password-sentinel-comparison");
  }
  if (
    /\.endsWith\s*\(\s*(?:`[^`]*(?:deleted\.invalid|DELETED_CONTACT_EMAIL_DOMAIN)[^`]*`|["'][^"']*deleted\.invalid[^"']*["'])/i.test(
      code,
    )
  ) {
    add("reserved-address-suffix-copy");
  }
  if (
    /pg_catalog\.right\s*\(/.test(code) &&
    /(?:deleted\.invalid|DELETED_CONTACT_EMAIL_DOMAIN)/i.test(code)
  ) {
    add("reserved-address-sql-copy");
  }
  if (
    /\bactive\b\s*===?\s*false/.test(code) &&
    /\bfirstName\b\s*===?\s*["']Deleted["']/.test(code) &&
    /\blastName\b\s*===?\s*["']Member["']/.test(code) &&
    /\bemail\b/.test(code)
  ) {
    add("retired-five-field-shape");
  }

  return violations;
}

describe("one canonical erased-member predicate (#3542)", () => {
  it("finds no retired shape outside the canonical module", () => {
    const violations = productionSources(SRC_DIR).flatMap((path) => {
      const repoPath = relative(SRC_DIR, path).replaceAll("\\", "/");
      if (repoPath === CANONICAL) return [];
      return retiredDeletionPredicateViolations(
        readFileSync(path, "utf8"),
        repoPath,
      );
    });

    expect(
      violations,
      "INV-SSOT-001 / INV-LIFE-014: deletion has one structural-or-reserved-address " +
        "predicate in src/lib/deleted-account.ts. Import it; do not reconstruct " +
        "an erased-member shape.",
    ).toEqual([]);
  });

  it("mutation: rejects the former canonical password-or-address shape", () => {
    const mutant = `
      function duplicate(member) {
        return member.passwordHash === DELETED_ACCOUNT_PASSWORD_HASH ||
          member.email.toLowerCase().endsWith(\`@\${DELETED_CONTACT_EMAIL_DOMAIN}\`);
      }
    `;
    expect(
      retiredDeletionPredicateViolations(mutant).map((v) => v.kind),
    ).toEqual(
      expect.arrayContaining([
        "password-sentinel-comparison",
        "reserved-address-suffix-copy",
      ]),
    );
  });

  it("mutation: rejects the retired Xero copy", () => {
    const mutant = `
      function isDeletedAccountMarker(member) {
        const email = member.email.trim().toLowerCase();
        return member.passwordHash === DELETED_ACCOUNT_PASSWORD_HASH ||
          email.endsWith("@deleted.invalid");
      }
    `;
    expect(
      retiredDeletionPredicateViolations(mutant).map((v) => v.kind),
    ).toEqual(
      expect.arrayContaining([
        "retired-name",
        "password-sentinel-comparison",
        "reserved-address-suffix-copy",
      ]),
    );
  });

  it("mutation: rejects the deletion queue's retired five-field shape", () => {
    const mutant = `
      function isMemberAnonymised(member) {
        return member.active === false && member.firstName === "Deleted" &&
          member.lastName === "Member" && member.email.startsWith("deleted-") &&
          member.email.endsWith("@deleted.invalid");
      }
    `;
    expect(
      retiredDeletionPredicateViolations(mutant).map((v) => v.kind),
    ).toEqual(
      expect.arrayContaining([
        "retired-name",
        "reserved-address-suffix-copy",
        "retired-five-field-shape",
      ]),
    );
  });

  it("mutation: rejects a new raw-SQL address-only copy", () => {
    const mutant = `
      const suffix = "@deleted.invalid";
      const sql = \`pg_catalog.right(pg_catalog.lower(email), \${suffix.length}) = '\${suffix}'\`;
    `;
    expect(
      retiredDeletionPredicateViolations(mutant).map((v) => v.kind),
    ).toContain("reserved-address-sql-copy");
  });
});
