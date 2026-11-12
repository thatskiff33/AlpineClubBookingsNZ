import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { adminUrlPattern } from "../../../e2e/helpers/admin-url";
import { getAdminPage, resolveAdminHref } from "@/lib/admin-hubs";
import { stripComments } from "./support/strip-comments";

/**
 * Admin URL expectations in the browser suite (epic #4468, C17 #4814).
 *
 * A moved admin page answers at its old path while `ADMIN_HUBS_LIVE` is off and
 * at its hub path once it is on. A spec that writes `/\/admin\/payments/` by
 * hand passes in one state and fails in the other, so every admin URL a spec
 * expects comes from the registry through `adminUrlPattern(adminHref(…))`.
 *
 * Two halves: the matcher is exact in both switch states, and no `toHaveURL` or
 * `waitForURL` under `e2e/` carries a literal admin path. The census is
 * DISK-SCANNING, so `vitest related` cannot select it: run it by name when a
 * change touches `e2e/`.
 */

const ORIGIN = "http://localhost:3001";

describe("adminUrlPattern", () => {
  const payments = getAdminPage("payments");
  const oldHref = resolveAdminHref(payments, false);
  const hubHref = resolveAdminHref(payments, true);

  it("matches the page's own URL in either switch state, and only that state's", () => {
    expect(oldHref).not.toBe(hubHref);
    for (const [href, other] of [
      [oldHref, hubHref],
      [hubHref, oldHref],
    ]) {
      const pattern = adminUrlPattern(href);
      expect(`${ORIGIN}${href}`).toMatch(pattern);
      expect(`${ORIGIN}${href}?status=failed`).toMatch(pattern);
      expect(`${ORIGIN}${href}#top`).toMatch(pattern);
      expect(`${ORIGIN}${other}`).not.toMatch(pattern);
      expect(`${ORIGIN}${href}-report`).not.toMatch(pattern);
      expect(`${ORIGIN}${href}/abc`).not.toMatch(pattern);
    }
  });

  it("is anchored at the path, so a prefix elsewhere does not match", () => {
    expect(`${ORIGIN}/finance${oldHref}`).not.toMatch(adminUrlPattern(oldHref));
    expect(`${ORIGIN}/admin/dashboard?next=${oldHref}`).not.toMatch(
      adminUrlPattern(oldHref),
    );
  });

  it("matches one more segment for a detail page under its list", () => {
    const pattern = adminUrlPattern("/admin/members", { child: true });
    expect(`${ORIGIN}/admin/members/cm123`).toMatch(pattern);
    expect(`${ORIGIN}/admin/members/cm123?tab=x`).toMatch(pattern);
    expect(`${ORIGIN}/admin/members`).not.toMatch(pattern);
    expect(`${ORIGIN}/admin/members/cm123/edit`).not.toMatch(pattern);
  });

  it("requires a named query parameter when asked", () => {
    const pattern = adminUrlPattern("/admin/members", {
      child: true,
      requiredParam: "returnTo",
    });
    expect(`${ORIGIN}/admin/members/cm1?returnTo=%2Fadmin`).toMatch(pattern);
    expect(`${ORIGIN}/admin/members/cm1?a=1&returnTo=x`).toMatch(pattern);
    expect(`${ORIGIN}/admin/members/cm1`).not.toMatch(pattern);
    expect(`${ORIGIN}/admin/members/cm1?xreturnTo=x`).not.toMatch(pattern);
    expect(`${ORIGIN}/admin/members/cm1#returnTo=x`).not.toMatch(pattern);
  });

  it("keeps an href's own query, then allows more", () => {
    const pattern = adminUrlPattern("/admin/family-groups?tab=suggestions");
    expect(`${ORIGIN}/admin/family-groups?tab=suggestions`).toMatch(pattern);
    expect(`${ORIGIN}/admin/family-groups?tab=suggestions&page=2`).toMatch(pattern);
    expect(`${ORIGIN}/admin/family-groups?tab=suggestionsx`).not.toMatch(pattern);
    expect(`${ORIGIN}/admin/family-groups`).not.toMatch(pattern);
  });

  it("refuses an href that is not an admin page, and a contradictory option", () => {
    expect(() => adminUrlPattern("/finance")).toThrow(/not an admin href/);
    expect(() =>
      adminUrlPattern("/admin/members?tab=a", { requiredParam: "returnTo" }),
    ).toThrow(/requiredParam/);
  });
});

const repoRoot = process.cwd();

function e2eSourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(path.join(repoRoot, dir), {
      withFileTypes: true,
    })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith(".ts")) found.push(rel);
    }
  };
  walk("e2e");
  return found.sort();
}

/** The argument text of every `toHaveURL(` / `waitForURL(` call, by paren balance. */
function urlExpectationArgs(code: string): string[] {
  const args: string[] = [];
  for (const match of code.matchAll(/\b(?:toHaveURL|waitForURL)\s*\(/g)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let end = start;
    while (end < code.length && depth > 0) {
      const ch = code[end];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      end += 1;
    }
    args.push(code.slice(start, end - 1));
  }
  return args;
}

describe("no literal admin path in an e2e URL expectation (C17 #4814)", () => {
  const files = e2eSourceFiles();
  // "/admin" in a string or template, "\/admin" in a regex literal.
  const literal = /\\?\/admin\b/;

  it("finds the e2e sources and the expectations it is meant to be scanning", () => {
    expect(files.length).toBeGreaterThan(30);
    expect(files).toContain("e2e/admin-roles.spec.ts");
    const roles = urlExpectationArgs(
      stripComments(fs.readFileSync(path.join(repoRoot, "e2e/admin-roles.spec.ts"), "utf8")),
    );
    expect(roles.some((arg) => arg.includes("adminUrlPattern("))).toBe(true);
  });

  it("asks the registry for every admin URL a spec expects", () => {
    for (const file of files) {
      const code = stripComments(fs.readFileSync(path.join(repoRoot, file), "utf8"));
      for (const arg of urlExpectationArgs(code)) {
        expect(
          arg,
          `${file} expects a literal admin URL. Use ` +
            `adminUrlPattern(adminHref(…)) from e2e/helpers/admin-url.ts so ` +
            `the expectation holds before and after the hubs switch (#4814).`,
        ).not.toMatch(literal);
      }
    }
  });

  it("catches the shapes it bans, and passes the one it asks for", () => {
    const banned = [
      'await expect(page).toHaveURL(/\\/admin\\/payments/);',
      'await page.waitForURL((url) => url.pathname.startsWith("/admin"));',
      "await expect(page).toHaveURL(`${base}/admin/members`);",
    ];
    for (const code of banned) {
      const [arg] = urlExpectationArgs(code);
      expect(arg, code).toMatch(literal);
    }
    expect(urlExpectationArgs("await page.waitForURL((url) => f(url));")).toEqual([
      "(url) => f(url)",
    ]);
    const [asked] = urlExpectationArgs(
      'await expect(page).toHaveURL(adminUrlPattern(adminHref("payments")));',
    );
    expect(asked).not.toMatch(literal);
  });
});
