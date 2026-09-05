import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static guard over the reverse-proxy configuration's `X-Frame-Options`
 * (issue #2246). There is no Caddy in the CI stack, so a source assertion in the
 * house static-test style (see `deployment-image-contracts.test.ts`) is the only
 * automated coverage possible.
 *
 * WHY THIS TEST EXISTS.
 *
 * `src/lib/csp.ts` sets `X-Frame-Options: DENY` on every route except `/display`,
 * which gets `SAMEORIGIN` so the admin's own sandboxed preview surfaces can frame
 * it (LTV-036, ADR-003 §5, and the Visual builder's Live preview, #2246). The
 * edge used to set a blanket `DENY`, replacing that value — the previews worked
 * only because CSP2 requires browsers to ignore `X-Frame-Options` when
 * `frame-ancestors` is present. The header is now path-scoped at the edge so it
 * says what the app means.
 *
 * The two invariants below are what make that safe, and neither is observable
 * from any other test:
 *
 *  1. `/display` — and nothing else — receives `SAMEORIGIN`. A widened matcher
 *     (`path /display*`, a dropped anchor, a case-insensitive `path` matcher)
 *     would hand same-origin framing to sibling routes.
 *  2. Every other path receives a GUARANTEED `DENY`. It must be a plain set, not
 *     Caddy's set-if-absent `?X-Frame-Options` form: `?` would turn a guaranteed
 *     edge control into an advisory one on every route, so any response emitting
 *     a permissive value would win — including `/finance-legacy*` (a
 *     reverse-proxied third-party upstream) and `/images/*`, neither of which the
 *     app's own middleware covers.
 *  3. The guarantee needs BOTH an eager unscoped `DENY` and the deferred scoped
 *     pair. The deferred (`>`) rewrite lives in a `ResponseWriter` wrapper that
 *     is unwound when a handler returns an error, so Caddy's error chain — 502,
 *     413 from the `request_body` cap, any 5xx — writes the response without it.
 *     Those responses never reach Next, so they carry no `frame-ancestors`
 *     fallback either; the eager set is the only thing denying them. Measured
 *     against caddy:2 with a permissive upstream: with the eager line removed,
 *     502/413/500 carried NO `X-Frame-Options` at all.
 */

const EDGE_CONFIGS = ["Caddyfile", "Caddyfile.staging"] as const;

/**
 * The one path the app itself relaxes (`setSecurityHeaders` in `src/lib/csp.ts`).
 * `/?` mirrors that file's trailing-slash normalisation; the anchors are what
 * stop `/display/foo` and `/display-foo` matching. `path_regexp` rather than
 * `path` because Caddy's `path` matcher is case-INSENSITIVE and would relax
 * `/DISPLAY`, where the app's exact comparison says DENY.
 */
const EXPECTED_MATCHERS = [
  "@display path_regexp ^/display/?$",
  "@not_display not path_regexp ^/display/?$",
];

/**
 * `>` is a deferred set: the edge value overwrites the upstream's rather than
 * being appended alongside it as a second, conflicting header.
 */
const EXPECTED_HEADERS = [
  'header @display >X-Frame-Options "SAMEORIGIN"',
  'header @not_display >X-Frame-Options "DENY"',
];

/**
 * The eager, unscoped floor inside the shared `header { }` block. It is what
 * error responses carry, because they never reach the deferred rewrite (see
 * invariant 3 in the file header). Written without a matcher and without a
 * prefix, so it is a plain set on every response.
 */
const EAGER_DENY = { matcher: "", prefix: "", value: "DENY" } as const;

function readRepoFile(relativePath: string) {
  // Test helper: reads a fixed repo file under process.cwd(); relativePath is test-controlled, not user input.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

function readEdgeConfig(relativePath: string) {
  // The Caddyfile comments explain the directives in full, and name the forms
  // this test forbids (`?X-Frame-Options`, `path` vs `path_regexp`). Strip them
  // so the assertions read only real configuration.
  return readRepoFile(relativePath)
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

/**
 * The FIRST top-level site block — the app's own site (`{$DOMAIN}` in
 * `Caddyfile`, `{$STAGING_CADDY_SITE…}` in `Caddyfile.staging`).
 *
 * Scoping matters for the eager-floor assertion below: `Caddyfile` has a second
 * site (`dashboard.{$DOMAIN}`, a redirect-only host) carrying its own
 * `X-Frame-Options "DENY"`, and a whole-file scan would let that unrelated
 * directive stand in for the app site's floor — verified by deleting the app
 * site's line and watching the unscoped assertion still pass.
 */
/** Index of the `}` closing the block opened at `start`. */
function endOfBlock(source: string, start: number) {
  let depth = 0;

  for (let i = start; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}" && --depth === 0) return i;
  }

  throw new Error("unbalanced braces: could not find the end of the block");
}

/**
 * A Caddyfile's GLOBAL OPTIONS block is the one whose address is empty, so
 * nothing but comments and whitespace precedes its `{`.
 *
 * It has to be recognised and skipped rather than counted, because it is not a
 * site: it carries no `header` directive, so treating it as the primary site
 * block made the eager-DENY assertion below scan an empty haystack. #3293 added
 * one to `Caddyfile` and `Caddyfile.staging` (the redacting default logger), and
 * the guard went red — correctly, but for the wrong reason. A site address is
 * blanked to `PLACEHOLDER` by the caller before this runs, so `{$DOMAIN} {`
 * leaves `PLACEHOLDER ` in front of its brace and is never mistaken for one.
 */
function opensWithGlobalOptionsBlock(source: string, firstBrace: number) {
  return /^(?:\s*(?:#[^\n]*)?\n)*\s*$/.test(source.slice(0, firstBrace));
}

function primarySiteBlock(config: string) {
  // Caddy placeholders (`{$DOMAIN}`, `{uri}`, `{path}`) use braces too. They
  // never contain whitespace and a block opener always does (a newline follows
  // it), so blanking them leaves only real block delimiters to count.
  const source = config.replace(/\{[^{}\s]*\}/g, "PLACEHOLDER");
  const firstBrace = source.indexOf("{");
  const start = opensWithGlobalOptionsBlock(source, firstBrace)
    ? source.indexOf("{", endOfBlock(source, firstBrace) + 1)
    : firstBrace;

  if (start === -1) {
    throw new Error("no site block follows the global options block");
  }

  return source.slice(start + 1, endOfBlock(source, start));
}

/** Every `X-Frame-Options` directive in the file, with its matcher token. */
function frameOptionsDirectives(config: string) {
  return [...config.matchAll(/^\s*header\s+(?:(@\S+|\S*\*\S*|\/\S*)\s+)?([+\-?>]?)X-Frame-Options\s+"([^"]*)"/gim)]
    .map(([, matcher, prefix, value]) => ({
      matcher: matcher ?? "",
      prefix,
      value,
    }))
    .concat(
      // The block form: `header { … X-Frame-Options "…" … }` — a bare directive
      // inside a braces block, which carries no matcher and so is unscoped.
      [...config.matchAll(/^\s*([+\-?>]?)X-Frame-Options\s+"([^"]*)"/gim)].map(
        ([, prefix, value]) => ({ matcher: "", prefix, value }),
      ),
    );
}

describe("primarySiteBlock", () => {
  // The eager-DENY assertion would pass VACUOUSLY if this helper ever returned
  // the wrong block and `frameOptionsDirectives` therefore found nothing, so the
  // skip is asserted directly rather than left to be implied.
  it("skips a leading global options block and returns the first site block", () => {
    const config = [
      "# leading comment",
      "{",
      "\tlog default {",
      "\t\tformat json",
      "\t}",
      "}",
      "",
      "{$DOMAIN} {",
      '\theader { X-Frame-Options "DENY" }',
      "}",
    ].join("\n");

    const block = primarySiteBlock(config);

    expect(block).toContain('X-Frame-Options "DENY"');
    expect(block).not.toContain("log default");
  });

  it("returns the first block when there is no global options block", () => {
    const config = ['{$DOMAIN} {', '\theader { X-Frame-Options "DENY" }', "}"].join(
      "\n",
    );

    expect(primarySiteBlock(config)).toContain('X-Frame-Options "DENY"');
  });
});

describe.each(EDGE_CONFIGS)("%s edge X-Frame-Options (#2246)", (configName) => {
  const config = readEdgeConfig(configName);

  it("scopes SAMEORIGIN to /display with an anchored, case-sensitive matcher", () => {
    for (const matcher of EXPECTED_MATCHERS) {
      expect(config, `${configName} must define \`${matcher}\``).toContain(matcher);
    }
    for (const directive of EXPECTED_HEADERS) {
      expect(config, `${configName} must set \`${directive}\``).toContain(directive);
    }
  });

  it("grants SAMEORIGIN to no matcher other than the /display one", () => {
    const relaxed = frameOptionsDirectives(config).filter(
      ({ value }) => value.toUpperCase() !== "DENY",
    );

    // Exactly one relaxation, bound to the @display matcher and to SAMEORIGIN.
    // Anything else — a second relaxed rule, a bare unscoped `SAMEORIGIN`, an
    // `ALLOWALL`/`ALLOW-FROM` — fails here.
    expect(relaxed).toEqual([
      { matcher: "@display", prefix: ">", value: "SAMEORIGIN" },
    ]);
  });

  it("keeps an eager unscoped DENY as the error-response floor", () => {
    // Deleting this line looks like harmless de-duplication — the two `>`
    // directives appear to cover every path — but it silently drops
    // X-Frame-Options from every response Caddy's error chain writes (502 from a
    // down upstream including /finance-legacy*, 413 from the request_body cap,
    // any 5xx), because the deferred rewrite is unwound on a handler error.
    // Those responses carry no CSP `frame-ancestors` fallback either.
    expect(
      frameOptionsDirectives(primarySiteBlock(config)),
      `${configName} must keep the eager unscoped \`X-Frame-Options "DENY"\` in the app site's shared header block`,
    ).toContainEqual(EAGER_DENY);
  });

  it("leaves every X-Frame-Options directive an enforced set, never set-if-absent", () => {
    const directives = frameOptionsDirectives(config);
    // Self-sufficient: without this, an empty scan (a renamed directive, a
    // broken regex) would pass the assertion below vacuously.
    expect(directives.length).toBeGreaterThan(0);

    const advisory = directives.filter(({ prefix }) => prefix === "?");

    // `?X-Frame-Options` is Caddy's "only if the response does not already have
    // one". It was refuted in review as a security downgrade: it would convert a
    // guaranteed edge control into an advisory one on every route.
    expect(advisory).toEqual([]);
  });

  it("emits no X-Frame-Options that is neither the /display relaxation nor DENY", () => {
    const directives = frameOptionsDirectives(config);

    expect(directives.length).toBeGreaterThan(0);
    for (const { matcher, value } of directives) {
      if (matcher === "@display") continue;
      expect(
        value,
        `${configName}: matcher \`${matcher || "(unscoped)"}\` must send DENY`,
      ).toBe("DENY");
    }
  });
});

describe("edge and app X-Frame-Options agree (#2246)", () => {
  it("relaxes exactly the path src/lib/csp.ts relaxes", () => {
    // The edge matcher is only correct while the app relaxes this one path. If
    // `setSecurityHeaders` ever relaxes another route, the Caddyfiles must gain
    // its matcher too or the edge silently overrides the app again.
    const csp = readRepoFile("src/lib/csp.ts");
    const relaxations = [
      ...csp.matchAll(/headers\.set\(\s*"X-Frame-Options"\s*,\s*"([^"]+)"\s*\)/g),
    ];

    expect(relaxations.map(([, value]) => value)).toEqual(["SAMEORIGIN"]);
    // …and that it is the NORMALISED path that is compared, which is what makes
    // the edge's `/?` and the app's trailing-slash folding agree on `/display/`.
    expect(csp).toMatch(
      /normalisePathname\(pathname\)\s*===\s*"\/display"/,
    );
  });
});
