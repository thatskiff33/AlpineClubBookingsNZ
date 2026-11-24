/**
 * Every officer queue that reads a row-capped admin route pages through it
 * (INV-OPS-020, #4960).
 *
 * #297 capped these routes at one page; the screens kept reading only the
 * first page with no total, so the oldest requests were silently out of
 * reach. This census walks every client file under `src/`, finds each one
 * that fetches a capped queue route, and requires it to page through the
 * shared hook and render the shared `Pagination`. A file reading one of these
 * routes for something other than its list must be named in `NOT_A_QUEUE_LIST`
 * with the reason. The routes themselves must answer through `adminListPage`
 * so every client reads the same keys.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { escapeRegExp } from "@/lib/escape-regexp";

import { stripComments } from "./support/strip-comments";
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");

/**
 * Each capped officer queue route, and the source files that build its
 * response: the route itself or the lib function it hands the read to.
 */
const CAPPED_QUEUE_ROUTES: Record<string, readonly string[]> = {
  "/api/admin/mcp/grants": ["src/app/api/admin/mcp/grants/route.ts"],
  "/api/admin/member-applications": ["src/app/api/admin/member-applications/route.ts"],
  "/api/admin/refund-requests": ["src/app/api/admin/refund-requests/route.ts"],
  "/api/admin/booking-reviews": ["src/app/api/admin/booking-reviews/route.ts"],
  "/api/admin/booking-change-requests": ["src/app/api/admin/booking-change-requests/route.ts"],
  "/api/admin/booking-requests": ["src/app/api/admin/booking-requests/route.ts"],
  "/api/admin/membership-cancellation-requests": ["src/lib/membership-cancellation-admin.ts"],
  "/api/admin/member-lifecycle-action-requests": ["src/lib/member-lifecycle-actions.ts"],
  "/api/admin/booking-exception-requests": ["src/lib/booking-exception-request-service.ts"],
  "/api/admin/deletion-requests": ["src/app/api/admin/deletion-requests/route.ts"],
  "/api/admin/maintenance-reports": ["src/app/api/admin/maintenance-reports/route.ts"],
  "/api/admin/communications/history": ["src/app/api/admin/communications/history/route.ts"],
};

/** Client files that read a capped queue route without listing its rows. */
const NOT_A_QUEUE_LIST: Record<string, string> = {};

/**
 * Queue lists that guard against a slower read themselves rather than through
 * the hook's `beginLoad`, with how.
 */
const OWN_STALE_READ_GUARD: Record<string, string> = {
  "src/components/admin/booking-requests/policy-exception-requests-panel.tsx":
    "numbers each read (loadRequestIdRef) and checks the filter, for page changes too",
};

const SHARED_HOOK = "@/components/admin/use-admin-queue-page";
const SHARED_PAGER = "@/components/admin/admin-pagination";

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      files.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

function relative(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

function isClientFile(source: string): boolean {
  return /^\s*["']use client["']/.test(source);
}

/** The capped routes a file names as a fetch target (the collection, not a record). */
function cappedRoutesRead(code: string): string[] {
  return Object.keys(CAPPED_QUEUE_ROUTES).filter((route) =>
    new RegExp(`${escapeRegExp(route)}(?=[?"'\`])`).test(code),
  );
}

/**
 * The text of one top-level `const` declaration, from its name to the `;`
 * that ends it, or null when there is none or it never ends. Brackets and string literals are skipped over, so a
 * `;` inside either does not end it early.
 */
function constDeclaration(code: string, name: string): string | null {
  const start = new RegExp(`\\bconst\\s+${escapeRegExp(name)}\\b[^=]*=`).exec(code);
  if (!start) return null;
  let depth = 0;
  for (let i = start.index + start[0].length; i < code.length; i += 1) {
    const char = code[i];
    if (char === '"' || char === "'" || char === "`") {
      // Skip the literal, honouring escapes.
      for (i += 1; i < code.length && code[i] !== char; i += 1) {
        if (code[i] === "\\") i += 1;
      }
    } else if (char === "(" || char === "{" || char === "[") {
      depth += 1;
    } else if (char === ")" || char === "}" || char === "]") {
      depth -= 1;
    } else if (char === ";" && depth === 0) {
      return code.slice(start.index, i);
    }
  }
  // Unterminated: read nothing rather than the declarations after it.
  return null;
}

/**
 * Where the route's query schema is declared: the route file itself, and the
 * declaration of each schema the route parses with that it imports from an
 * `@/lib` module (shared with the AI app catalogue, ALP-719). Only that one
 * declaration is read, never the rest of its module, so a route that parses a
 * schema without paging fields fails even when a sibling schema has them.
 */
function querySchemaSources(routeFile: string): string[] {
  const code = stripComments(readFileSync(routeFile, "utf8"));
  const sources = [code];
  const parsed = new Set([...code.matchAll(/\b(\w+)\.(?:safeParse|parse)\(/g)].map((match) => match[1]));
  for (const match of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@\/lib\/([^"]+)"/g)) {
    const base = path.join(SRC, "lib", match[2] ?? "");
    const schemaModule = [`${base}.ts`, path.join(base, "index.ts")].find((candidate) => existsSync(candidate));
    if (!schemaModule) continue;
    for (const specifier of (match[1] ?? "").split(",")) {
      // `exported as local`: the route parses with the local name.
      const [exported, local = exported] = specifier.replace(/^\s*type\s+/, "").trim().split(/\s+as\s+/);
      if (!exported || !local || !parsed.has(local)) continue;
      const declaration = constDeclaration(stripComments(readFileSync(schemaModule, "utf8")), exported);
      if (declaration) sources.push(declaration);
    }
  }
  return sources;
}

function queueReaders(): Map<string, string[]> {
  const readers = new Map<string, string[]>();
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, "utf8");
    if (!isClientFile(source)) continue;
    const routes = cappedRoutesRead(stripComments(source));
    if (routes.length > 0) readers.set(relative(file), routes);
  }
  return readers;
}

/**
 * What a queue list must do to reach every row; empty when it does. Besides
 * paging and rendering the pager, a list must not let a slower read for a page
 * or filter the officer has left replace the one now shown (it calls the hook's
 * `beginLoad`, unless it is named in `OWN_STALE_READ_GUARD`), and must not
 * unmount its pager while a read is in flight, which drops a keyboard user's
 * focus to the page body on every page change.
 */
function queuePagingGaps(code: string, ownStaleReadGuard = false): string[] {
  const gaps: string[] = [];
  if (!code.includes(`"${SHARED_HOOK}"`) || !/\buseAdminQueuePage\s*\(/.test(code)) {
    gaps.push("pages through useAdminQueuePage");
  }
  if (!code.includes(`"${SHARED_PAGER}"`) || !/<Pagination\b/.test(code)) {
    gaps.push("renders the shared Pagination");
  }
  // One `beginLoad()` call per hook, so a screen paging two queues guards both.
  const hookCalls = (code.match(/\buseAdminQueuePage\s*\(/g) ?? []).length;
  const guardCalls = (code.match(/\bbegin\w*Load\s*\(\s*\)/g) ?? []).length;
  if (!ownStaleReadGuard && guardCalls < hookCalls) {
    gaps.push("guards a list read with beginLoad");
  }
  if (/!\s*\w*[lL]oading\s*&&\s*[\w.]*[pP]agination\b/.test(code)) {
    gaps.push("keeps the pager mounted through a read");
  }
  return gaps;
}

describe("row-capped officer queues page through every row (INV-OPS-020)", () => {
  const readers = queueReaders();

  it("finds a reader for every capped route, so an empty walk cannot pass", () => {
    const covered = new Set([...readers.values()].flat());
    expect([...covered].sort()).toEqual(Object.keys(CAPPED_QUEUE_ROUTES).sort());
  });

  it("enumerates the queue lists it polices", () => {
    const lists = [...readers.keys()].filter((file) => !(file in NOT_A_QUEUE_LIST)).sort();
    expect(lists).toEqual([
      "src/app/(admin)/admin/finance/refund-requests/page.tsx",
      "src/app/(admin)/admin/membership/deletion-requests/deletion-requests-client.tsx",
      "src/app/(admin)/admin/membership/member-applications/page.tsx",
      "src/app/(admin)/admin/membership/membership-cancellations/page.tsx",
      "src/app/(admin)/admin/messages/communications/_components/send-history-card.tsx",
      "src/app/(admin)/admin/system/ai-connections/ai-connections-client.tsx",
      "src/components/admin/booking-requests/booking-approvals-panel.tsx",
      "src/components/admin/booking-requests/booking-change-requests-panel.tsx",
      "src/components/admin/booking-requests/policy-exception-requests-panel.tsx",
      "src/components/admin/booking-requests/public-booking-requests-panel.tsx",
      "src/components/admin/maintenance/maintenance-queue-section.tsx",
    ]);
  });

  it("every queue list pages through the shared hook and renders Pagination", () => {
    const failures = [...readers.keys()]
      .filter((file) => !(file in NOT_A_QUEUE_LIST))
      .flatMap((file) => {
        const code = stripComments(readFileSync(path.join(ROOT, file), "utf8"));
        return queuePagingGaps(code, file in OWN_STALE_READ_GUARD).map((gap) => `${file}: ${gap}`);
      });
    expect(failures).toEqual([]);
  });

  it("each own-guard exemption is a queue list that really numbers its reads", () => {
    for (const [file, how] of Object.entries(OWN_STALE_READ_GUARD)) {
      expect(readers.has(file) && !(file in NOT_A_QUEUE_LIST), `${file} is not a queue list`).toBe(true);
      const code = stripComments(readFileSync(path.join(ROOT, file), "utf8"));
      expect(code, `${file} no longer numbers its reads; drop its exemption`).toMatch(/loadRequestIdRef/);
      expect(how.trim().length).toBeGreaterThan(0);
    }
  });

  it("each exemption still reads a capped route and gives a reason", () => {
    for (const [file, reason] of Object.entries(NOT_A_QUEUE_LIST)) {
      expect(existsSync(path.join(ROOT, file)), `${file} is gone; drop its exemption`).toBe(true);
      expect(readers.has(file), `${file} no longer reads a capped route; drop its exemption`).toBe(true);
      expect(reason.trim().length).toBeGreaterThan(0);
    }
  });

  it("every capped route answers through adminListPage", () => {
    const failures = Object.entries(CAPPED_QUEUE_ROUTES).flatMap(([route, files]) => {
      const answers = files.some((file) =>
        /\badminListPage\s*\(/.test(stripComments(readFileSync(path.join(ROOT, file), "utf8"))),
      );
      return answers ? [] : [route];
    });
    expect(failures).toEqual([]);
  });

  it("every capped route's schema spreads adminListPageQueryFields", () => {
    // The schema is in the route, or is the one the route parses with,
    // declared in a lib module (shared with the AI app catalogue, ALP-719).
    const failures = Object.keys(CAPPED_QUEUE_ROUTES).filter((route) => {
      const file = path.join(ROOT, "src/app", `${route}/route.ts`);
      return !querySchemaSources(file).some((code) => /\.\.\.adminListPageQueryFields\b/.test(code));
    });
    expect(failures).toEqual([]);
  });

  it("the gap check fails a list with no pager (mutation canary)", () => {
    const panel = stripComments(
      readFileSync(
        path.join(SRC, "components/admin/booking-requests/booking-approvals-panel.tsx"),
        "utf8",
      ),
    );
    expect(queuePagingGaps(panel)).toEqual([]);
    expect(queuePagingGaps(panel.replace(/<Pagination\b/g, "<Paginatio"))).toEqual([
      "renders the shared Pagination",
    ]);
    expect(queuePagingGaps(panel.replace(/\buseAdminQueuePage\s*\(/g, "useState("))).toEqual([
      "pages through useAdminQueuePage",
    ]);
  });

  it("the gap check fails a list that lets a stale read land or unmounts its pager (mutation canary)", () => {
    const panel = stripComments(
      readFileSync(
        path.join(SRC, "components/admin/booking-requests/booking-approvals-panel.tsx"),
        "utf8",
      ),
    );
    expect(queuePagingGaps(panel)).toEqual([]);
    expect(queuePagingGaps(panel.replace(/\bbeginLoad\s*\(/g, "begunLoad("))).toEqual([
      "guards a list read with beginLoad",
    ]);
    expect(
      queuePagingGaps(panel.replace("{queuePage.pagination ? (", "{!loading && queuePage.pagination ? (")),
    ).toEqual(["keeps the pager mounted through a read"]);
  });
});

/** The one module allowed to compute a range or read a raw page number. */
const LIST_PAGE_HELPER = "src/lib/admin-list-page.ts";

/** Hand-rolled first-row arithmetic: `(page - 1) * pageSize + 1`. */
const RANGE_START = /\(\s*[\w.]*[pP]age\s*-\s*1\s*\)\s*\*\s*[\w.]+\s*\+\s*1/;

/** A client read of a list page from the URL. */
const PAGE_PARAM_READ = /\.get\(\s*["'](?:page|archivePage|inPage|opPage)["']\s*\)/g;

const PAGE_KEY = String.raw`["'](?:page|archivePage|inPage|opPage)["']`;

/**
 * A hand-rolled page-URL write, in each form the lists used before
 * `setAdminListPageParam`: a page-conditioned `.set` (`if (page > 1)
 * params.set("page", ...)`, braced or not, or `page > 1 ? params.set(...) : ...`),
 * a `setOrDelete("inPage", page > 1 ? ... : "")`, and a bare `.delete("page")`,
 * which is a reset to page 1 and reads `setAdminListPageParam(params, 1)`.
 * A `.set` that always sends the page (an API request builder) is not a URL write.
 */
const PAGE_PARAM_WRITE = new RegExp(
  [
    String.raw`[\w.]+\s*>\s*1\s*(?:\)\s*\{?|\?)\s*[\w.]+\.set\(\s*${PAGE_KEY}`,
    String.raw`\bsetOrDelete\(\s*${PAGE_KEY}\s*,[^;]*?>\s*1`,
    String.raw`\.delete\(\s*${PAGE_KEY}\s*\)`,
  ].join("|"),
);

/** Files that read or carry a page key without parsing it, with the reason. */
const RAW_PAGE_READS: Record<string, string> = {
  "src/components/admin/booking-filters.tsx":
    "carries the URL's page value through a filter change verbatim; the bookings page parses it",
};

/** Raw page-key reads in a file that `parseAdminListPageParam` does not wrap. */
function unparsedPageReads(code: string): string[] {
  return [...code.matchAll(PAGE_PARAM_READ)]
    .filter((match) => !/parseAdminListPageParam\(\s*[\w.]+$/.test(code.slice(0, match.index)))
    .map((match) => match[0]);
}

describe("admin lists share the page parser and range text (INV-OPS-020)", () => {
  // API routes read `page` through their zod schema (`adminListPageQueryFields`).
  const files = sourceFiles(SRC)
    .map(relative)
    .filter((file) => file !== LIST_PAGE_HELPER && !file.startsWith("src/app/api/"));
  const code = new Map(files.map((file) => [file, stripComments(readFileSync(path.join(ROOT, file), "utf8"))]));

  it("no list computes its own first-row number; formatAdminListRange does", () => {
    expect(files.filter((file) => RANGE_START.test(code.get(file)!))).toEqual([]);
  });

  it("every page number read from the URL goes through parseAdminListPageParam", () => {
    const failures = files
      .filter((file) => !(file in RAW_PAGE_READS))
      .flatMap((file) => unparsedPageReads(code.get(file)!).map((read) => `${file}: ${read}`));
    expect(failures).toEqual([]);
  });

  it("every page written into a URL goes through setAdminListPageParam", () => {
    expect(
      files.filter((file) => !(file in RAW_PAGE_READS) && PAGE_PARAM_WRITE.test(code.get(file)!)),
    ).toEqual([]);
  });

  it("enumerates the lists that parse a page key, so an empty walk cannot pass", () => {
    const parsing = files.filter((file) => /\bparseAdminListPageParam\(/.test(code.get(file)!)).sort();
    expect(parsing).toEqual([
      "src/app/(admin)/admin/booking-desk/waitlist/page.tsx",
      "src/app/(admin)/admin/finance/payments/page.tsx",
      "src/app/(admin)/admin/finance/refund-requests/page.tsx",
      "src/app/(admin)/admin/finance/subscriptions/page.tsx",
      "src/app/(admin)/admin/finance/xero/_components/inbound-events-panel.tsx",
      "src/app/(admin)/admin/finance/xero/_components/operations-panel.tsx",
      "src/app/(admin)/admin/membership/member-applications/page.tsx",
      "src/app/(admin)/admin/membership/members/_hooks/use-members-query-state.ts",
      "src/app/(admin)/admin/membership/membership-cancellations/page.tsx",
      "src/app/(admin)/admin/system/audit-log/page.tsx",
      "src/components/admin/booking-requests/booking-approvals-panel.tsx",
      "src/components/admin/booking-requests/booking-change-requests-panel.tsx",
      "src/components/admin/booking-requests/public-booking-requests-panel.tsx",
    ]);
  });

  it("each raw-read exemption still reads a page key and gives a reason", () => {
    for (const [file, reason] of Object.entries(RAW_PAGE_READS)) {
      expect(code.has(file), `${file} is gone; drop its exemption`).toBe(true);
      expect(unparsedPageReads(code.get(file)!).length, `${file} parses its page now; drop its exemption`).toBeGreaterThan(0);
      expect(reason.trim().length).toBeGreaterThan(0);
    }
  });

  it("the checks fail a hand-rolled range and an unparsed read (mutation canary)", () => {
    expect(RANGE_START.test("const start = (page - 1) * pageSize + 1")).toBe(true);
    expect(RANGE_START.test("const start = (pagination.page - 1) * pagination.pageSize + 1")).toBe(true);
    expect(unparsedPageReads('parseAdminListPageParam(searchParams.get("opPage"))')).toEqual([]);
    expect(unparsedPageReads('Number(searchParams.get("opPage"))')).toEqual(['.get("opPage")']);
  });

  it("the write check fails every hand-written form and passes the shared writer (mutation canary)", () => {
    const handWritten = [
      'if (page > 1) params.set("page", String(page))',
      'if (archivePageNumber > 1) queueParams.set("archivePage", "2")',
      'if (page > 1) {\n  params.set("page", String(page));\n}',
      'page > 1 ? params.set("page", String(page)) : params.delete("page")',
      'setOrDelete("inPage", page > 1 ? String(page) : "")',
      'params.delete("page")',
      "params.delete('opPage')",
    ];
    for (const write of handWritten) expect(PAGE_PARAM_WRITE.test(write), write).toBe(true);
    const allowed = [
      'setAdminListPageParam(params, page, "opPage")',
      'params.set("page", String(page))',
      'params.set("pageSize", String(pageSize))',
      'params.delete("pageSize")',
    ];
    for (const write of allowed) expect(PAGE_PARAM_WRITE.test(write), write).toBe(false);
  });
});

/**
 * The `page` and `pageSize` a capped route accepts are `adminListPageQueryFields`
 * (page from 1, 25 a page, 100 at most). A schema that spells the same
 * `pageSize` out again is a second definition: change the shared cap and it
 * would keep answering the old one.
 */
const SHARED_PAGE_SIZE_DEFINITION =
  /\bpageSize\s*:\s*z\s*\.coerce\s*\.number\(\s*\)\s*\.int\(\s*\)\s*\.min\(\s*1\s*\)\s*\.max\(\s*100\s*\)(?:\s*\.optional\(\s*\))?\s*\.default\(\s*25\s*\)/;

/**
 * The same for `page`: a route that cannot spread the whole object (the Xero
 * panels size their own page) takes `adminListPageField`. A list with a
 * ceiling of its own (`.max(10_000)`, the image library) is a different rule
 * and does not match.
 */
const SHARED_PAGE_DEFINITION =
  /\bpage\s*:\s*z\s*\.coerce\s*\.number\(\s*\)\s*\.int\(\s*\)\s*\.min\(\s*1\s*\)(?:\s*\.optional\(\s*\))?\s*\.default\(\s*1\s*\)/;

describe("a capped route takes its page fields from one definition (INV-OPS-020)", () => {
  const files = sourceFiles(SRC)
    .map(relative)
    .filter((file) => file !== LIST_PAGE_HELPER);

  it("no schema re-declares the shared page size", () => {
    // Only a file that names `pageSize` can spell it out, so the comment
    // stripper runs on those few rather than on the whole tree.
    const redeclared = files.filter((file) => {
      const source = readFileSync(path.join(ROOT, file), "utf8");
      return source.includes("pageSize") && SHARED_PAGE_SIZE_DEFINITION.test(stripComments(source));
    });
    expect(redeclared).toEqual([]);
  }, CENSUS_TIMEOUT_MS);

  it("no schema re-declares the shared page field", () => {
    const redeclared = files.filter((file) => {
      const source = readFileSync(path.join(ROOT, file), "utf8");
      return source.includes("page") && SHARED_PAGE_DEFINITION.test(stripComments(source));
    });
    expect(redeclared).toEqual([]);
  }, CENSUS_TIMEOUT_MS);

  it("the shared page field is still spelled the way the check looks for it (mutation canary)", () => {
    const helper = stripComments(readFileSync(path.join(ROOT, LIST_PAGE_HELPER), "utf8"));
    expect(helper).toMatch(/adminListPageField\s*=\s*z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.optional\(\)\.default\(1\)/);
    expect(SHARED_PAGE_DEFINITION.test("page: z.coerce.number().int().min(1).optional().default(1),")).toBe(true);
    expect(SHARED_PAGE_DEFINITION.test("page: z.coerce.number().int().min(1).default(1),")).toBe(true);
    expect(SHARED_PAGE_DEFINITION.test("page: z.coerce\n    .number()\n    .int()\n    .min(1)\n    .default(1),")).toBe(true);
    expect(SHARED_PAGE_DEFINITION.test("page: z.coerce.number().int().min(1).max(10_000).default(1),")).toBe(false);
    expect(SHARED_PAGE_DEFINITION.test("page: adminListPageField,")).toBe(false);
  });

  it("the shared page size is still spelled the way the check looks for it (mutation canary)", () => {
    const helper = stripComments(readFileSync(path.join(ROOT, LIST_PAGE_HELPER), "utf8"));
    expect(helper).toMatch(/ADMIN_LIST_MAX_PAGE_SIZE\s*=\s*100/);
    expect(helper).toMatch(/ADMIN_LIST_DEFAULT_PAGE_SIZE\s*=\s*25/);
    expect(
      SHARED_PAGE_SIZE_DEFINITION.test("pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),"),
    ).toBe(true);
    expect(
      SHARED_PAGE_SIZE_DEFINITION.test(
        "pageSize: z.coerce\n    .number()\n    .int()\n    .min(1)\n    .max(100)\n    .default(25),",
      ),
    ).toBe(true);
    expect(
      SHARED_PAGE_SIZE_DEFINITION.test("pageSize: z.coerce.number().int().min(1).max(200).default(50),"),
    ).toBe(false);
  });
});
