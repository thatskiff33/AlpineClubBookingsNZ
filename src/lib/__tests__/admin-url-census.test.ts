import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { adminHrefPattern, adminUrlPattern } from "../../../e2e/helpers/admin-url";
import { adminHref, getAdminPage, resolveAdminHref } from "@/lib/admin-hubs";
import { buildHrefWithReturnTo } from "@/lib/internal-return-path";
import { stripComments } from "./support/strip-comments";

/**
 * Admin URL expectations in the browser suite (epic #4468, C17 #4814).
 *
 * A moved admin page answers at its old path while `ADMIN_HUBS_LIVE` is off and
 * at its hub path once it is on. A spec that writes `/\/admin\/payments/` by
 * hand passes in one state and fails in the other, so every admin URL a spec
 * expects comes from the registry through `adminUrlPattern(adminHref(…))`.
 *
 * Two halves: the matchers are exact in both switch states, and nothing under
 * `e2e/` that expects an admin address carries a literal admin path: no
 * `toHaveURL`, no `waitForURL`, no `[href…]` selector and no
 * `toHaveAttribute("href", …)`. A link's `href` is as much an address as a page
 * URL, and the member list's links move with the switch. The census is
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

describe("adminHrefPattern", () => {
  it("matches the href the member table builds, in the state the app is in", () => {
    const pattern = adminHrefPattern(adminHref("members"), {
      child: true,
      requiredParam: "returnTo",
    });
    const built = buildHrefWithReturnTo(
      adminHref("member-detail", { id: "cm123" }),
      "/admin/members",
    );
    expect(built).toMatch(pattern);
    expect(built).toMatch(/\?returnTo=/);
  });

  it("is exact, in both switch states, and takes no origin", () => {
    const payments = getAdminPage("payments");
    const oldHref = resolveAdminHref(payments, false);
    const hubHref = resolveAdminHref(payments, true);
    for (const [href, other] of [
      [oldHref, hubHref],
      [hubHref, oldHref],
    ]) {
      const pattern = adminHrefPattern(href);
      expect(href).toMatch(pattern);
      expect(`${href}?status=failed`).toMatch(pattern);
      expect(other).not.toMatch(pattern);
      expect(`${href}-report`).not.toMatch(pattern);
      expect(`${ORIGIN}${href}`).not.toMatch(pattern);
    }
    const child = adminHrefPattern("/admin/members", {
      child: true,
      requiredParam: "returnTo",
    });
    expect("/admin/members/cm1?returnTo=%2Fadmin%2Fmembers").toMatch(child);
    expect("/admin/members/cm1?a=1&returnTo=x").toMatch(child);
    expect("/admin/members/cm1").not.toMatch(child);
    expect("/admin/membership/members/cm1?returnTo=x").not.toMatch(child);
    expect("/admin/members/cm1/merge?returnTo=x").not.toMatch(child);
  });

  it("refuses what adminUrlPattern refuses", () => {
    expect(() => adminHrefPattern("/finance")).toThrow(/not an admin href/);
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

/** The argument text of every call `opener` finds, by paren balance. */
function callArgs(code: string, opener: RegExp): string[] {
  const args: string[] = [];
  for (const match of code.matchAll(opener)) {
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

/** The argument text of every `toHaveURL(` / `waitForURL(` call. */
function urlExpectationArgs(code: string): string[] {
  return callArgs(code, /\b(?:toHaveURL|waitForURL)\s*\(/g);
}

/**
 * The text of every place a spec names a link's address: each `[href…]` selector
 * (any quoting, so a template with `${adminHref(…)}` in it is one whole piece) and
 * the arguments of each `toHaveAttribute("href", …)`.
 */
function hrefExpectations(code: string): string[] {
  const found = [...code.matchAll(/\[href[^\]]*\]/g)].map((match) => match[0]);
  for (const arg of callArgs(code, /\btoHaveAttribute\s*\(/g)) {
    if (/^\s*["'`]href["'`]/.test(arg)) found.push(arg);
  }
  return found;
}

/**
 * A literal admin href a spec may keep, because the APP writes the same literal
 * by hand: the address does not move with the switch, so the spec pins what the
 * app renders. Each entry is checked against both the spec and the app, so it
 * cannot outlive the reason it is here.
 */
const APP_LITERAL_HREFS = [
  {
    file: "e2e/ai-diagnostics.spec.ts",
    expectation: '"href", "/admin/modules"',
    app: "src/components/help-widget/diagnostics-view.tsx",
    appText: 'href="/admin/modules"',
  },
] as const;

describe("no literal admin path in an e2e URL expectation (C17 #4814)", () => {
  const files = e2eSourceFiles();
  // "/admin" in a string or template, "\/admin" in a regex literal.
  const literal = /\\?\/admin\b/;
  const codeOf = (file: string): string =>
    stripComments(fs.readFileSync(path.join(repoRoot, file), "utf8"));

  it("finds the e2e sources and the expectations it is meant to be scanning", () => {
    expect(files.length).toBeGreaterThan(30);
    expect(files).toContain("e2e/admin-roles.spec.ts");
    const roles = urlExpectationArgs(codeOf("e2e/admin-roles.spec.ts"));
    expect(roles.some((arg) => arg.includes("adminUrlPattern("))).toBe(true);
    // The two href shapes are reached too: a selector and an attribute check.
    expect(
      hrefExpectations(codeOf("e2e/admin-roles.spec.ts")).some((text) =>
        text.includes("adminHref("),
      ),
    ).toBe(true);
    expect(
      hrefExpectations(codeOf("e2e/admin-member-detail.spec.ts")).some((text) =>
        text.includes("adminHrefPattern("),
      ),
    ).toBe(true);
  });

  it("asks the registry for every admin URL a spec expects", () => {
    for (const file of files) {
      for (const arg of urlExpectationArgs(codeOf(file))) {
        expect(
          arg,
          `${file} expects a literal admin URL. Use ` +
            `adminUrlPattern(adminHref(…)) from e2e/helpers/admin-url.ts so ` +
            `the expectation holds before and after the hubs switch (#4814).`,
        ).not.toMatch(literal);
      }
    }
  });

  it("asks the registry for every admin href a spec selects or expects", () => {
    for (const file of files) {
      for (const text of hrefExpectations(codeOf(file))) {
        const kept = APP_LITERAL_HREFS.some(
          (entry) => entry.file === file && text === entry.expectation,
        );
        if (kept) continue;
        expect(
          text,
          `${file} names a literal admin href. Select with ` +
            `a[href^="\${adminHref(…)}"] or expect adminHrefPattern(adminHref(…)) ` +
            `from e2e/helpers/admin-url.ts: the member list's links move with ` +
            `the hubs switch (#4814).`,
        ).not.toMatch(literal);
      }
    }
  });

  it("keeps each app-literal exception only while the app still writes that literal", () => {
    for (const entry of APP_LITERAL_HREFS) {
      expect(
        hrefExpectations(codeOf(entry.file)),
        `${entry.file} no longer has ${entry.expectation}: remove the exception`,
      ).toContain(entry.expectation);
      expect(
        fs.readFileSync(path.join(repoRoot, entry.app), "utf8"),
        `${entry.app} no longer writes ${entry.appText} by hand: convert it to ` +
          `adminHref, then make ${entry.file} expect adminHrefPattern(adminHref(…)) ` +
          `and remove the exception`,
      ).toContain(entry.appText);
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

  it("catches the href shapes it bans, and passes the ones it asks for", () => {
    const banned = [
      "page.locator('a[href*=\"/admin/members/\"]')",
      "page.locator(`a[href^=\"/admin/members/\"]`)",
      "await expect(link).toHaveAttribute(\"href\", /\\/admin\\/members\\/[^?]+/);",
      "await expect(link).toHaveAttribute(\n  'href',\n  \"/admin/modules\",\n);",
    ];
    for (const code of banned) {
      const found = hrefExpectations(code);
      expect(found, code).toHaveLength(1);
      expect(found[0], code).toMatch(literal);
    }
    const asked = [
      'page.locator(`a[href^="${adminHref("members")}/"]`)',
      'await expect(link).toHaveAttribute("href", adminHrefPattern(adminHref("members")));',
      "page.locator('a[href^=\"/bookings/\"]')",
    ];
    for (const code of asked) {
      const found = hrefExpectations(code);
      expect(found, code).toHaveLength(1);
      expect(found[0], code).not.toMatch(literal);
    }
    // Another attribute is not an address.
    expect(hrefExpectations('await expect(x).toHaveAttribute("title", "/admin")')).toEqual(
      [],
    );
  });
});
