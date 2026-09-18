import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { CREDENTIAL_SYSTEM_ACTORS } from "@/lib/integration-credential-actor";

/*
  #2720 — the credential blast-radius list has ONE home, and it is current.

  `DEPLOYMENT.md`'s auth-secret rotation runbook told an operator that rotation
  strands "Xero client id/secret/webhook key; Stripe secret/publishable/
  webhook-signing keys". By August 2026 that was four providers short: Google
  (#2087), the backup destination and restore DSN (#2095), and two Anthropic
  keys (#2211, #2371) had all joined the same encrypted store. An operator
  planning a two-provider rotation would have met six of them mid-rotation, with
  sessions already dropped and 2FA already gone — the worst moment to discover a
  document was stale.

  A second hand-written list is the defect, so the fix is structural rather than
  a correction: `docs/SECURITY-ATTACK-SURFACE.md` carries the one list, the
  runbook links to it, and this test holds both halves to the code.

  It reads the WRITE ALLOWLIST rather than grepping for provider-ish strings.
  `WRITABLE_CREDENTIALS` is what the endpoint enforces, so a provider that can
  actually receive a credential is exactly a provider named there — and adding
  one is the moment the documentation has to move. Every name is resolved
  through its exported constant, never assumed from the identifier's spelling.

  Scanned from disk, so `vitest related` cannot reach it from a route change:
  this is a CI-caught contract by design, like the other census tests here.
*/

const REPO_ROOT = resolve(process.cwd());

const CREDENTIALS_ROUTE =
  "src/app/api/admin/integrations/credentials/route.ts";
const CANONICAL_LIST_DOC = "docs/SECURITY-ATTACK-SURFACE.md";
const ROTATION_RUNBOOK_DOC = "DEPLOYMENT.md";

/**
 * The SECOND list on this page that is restated from code (#2723): the closed
 * set of background writers of the credential store.
 *
 * It is here for the reason written at the top of this file. A second
 * hand-written list IS the defect — the rotation runbook's copy of the provider
 * list went four providers stale, and an operator would have met the missing
 * ones mid-rotation. The actor list has exactly the same shape: it is closed, it
 * is reviewed, it is restated in prose on the attack-surface page, and adding or
 * removing a background writer is precisely the moment the prose falls behind.
 * #2723 removed two entries from it in a single fix round, which is how fast it
 * moves.
 */
const ACTOR_LIST_HEADING = "#### The background writers, in full (#2723)";

/** The heading the canonical provider list lives under. */
const CANONICAL_LIST_HEADING =
  "### The provider list, and the one place it lives (#2720)";

/** The heading the operator rotation procedure lives under. */
const ROTATION_RUNBOOK_HEADING = "### Auth-secret rotation runbook";

/**
 * The anchor the runbook must link to. Written out rather than derived so that
 * renaming the heading breaks this test loudly instead of breaking the link
 * quietly — `docs:linkcheck` would catch a dead fragment, but not a runbook
 * that had simply stopped linking anywhere.
 */
const CANONICAL_LIST_LINK =
  "docs/SECURITY-ATTACK-SURFACE.md#the-provider-list-and-the-one-place-it-lives-2720";

/**
 * A guard against this whole test going vacuous. If the allowlist parse ever
 * resolves nothing — a refactor to a `satisfies` form, a move to another
 * module — the assertions below would all pass over an empty set and report a
 * clean bill of health for a document nobody had checked.
 */
const MINIMUM_EXPECTED_PROVIDERS = 5;

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

/** The body of a `const NAME: … = { … };` object literal, by brace matching. */
function objectLiteralBody(source: string, name: string): string {
  const declaration = source.indexOf(`const ${name}`);
  if (declaration === -1) {
    throw new Error(
      `${CREDENTIALS_ROUTE} no longer declares ${name}. That object is the ` +
        "allowlist this contract reads to learn which providers exist. If it " +
        "was renamed, rename it here too rather than deleting the check.",
    );
  }
  const open = source.indexOf("{", declaration);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error(`${name} in ${CREDENTIALS_ROUTE} has no closing brace`);
}

/** `localName -> module specifier`, for every named import in `source`. */
function namedImportModules(source: string): Map<string, string> {
  const modules = new Map<string, string>();
  for (const match of source.matchAll(
    /import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g,
  )) {
    for (const raw of match[1].split(",")) {
      const local = raw.trim().split(/\s+as\s+/).at(-1)?.trim();
      if (local) modules.set(local, match[2]);
    }
  }
  return modules;
}

/** `@/lib/x` -> `src/lib/x.ts`, the only import form the route uses. */
function resolveLibModule(specifier: string): string {
  if (!specifier.startsWith("@/")) {
    throw new Error(
      `Cannot resolve the non-alias import "${specifier}" that a provider ` +
        "constant now comes from. Teach this helper the new form; do not drop " +
        "the provider from the check.",
    );
  }
  return `src/${specifier.slice(2)}.ts`;
}

/** The string literal a module exports as `const <name> = "…"`. */
function exportedStringConstant(moduleSource: string, name: string): string {
  const match = moduleSource.match(
    new RegExp(`export const ${name}\\s*=\\s*"([^"]+)"`),
  );
  if (!match) {
    throw new Error(
      `${name} is not exported as a plain string constant. This contract ` +
        "resolves provider names through their constants so it never has to " +
        "guess one from an identifier's spelling.",
    );
  }
  return match[1];
}

/** Every provider namespace the credential write endpoint will accept. */
function writableProviders(): string[] {
  const route = readRepoFile(CREDENTIALS_ROUTE);
  const body = objectLiteralBody(route, "WRITABLE_CREDENTIALS");
  const imports = namedImportModules(route);

  const providers = new Set<string>();
  for (const match of body.matchAll(/^\s*\[([A-Za-z_][A-Za-z0-9_]*)\]\s*:/gm)) {
    const identifier = match[1];
    const specifier = imports.get(identifier);
    if (!specifier) {
      throw new Error(
        `${identifier} keys an entry in WRITABLE_CREDENTIALS but is not a ` +
          `named import of ${CREDENTIALS_ROUTE}. A locally-declared provider ` +
          "name cannot be resolved here; import it from its config module.",
      );
    }
    providers.add(
      exportedStringConstant(
        readRepoFile(resolveLibModule(specifier)),
        identifier,
      ),
    );
  }
  return [...providers].sort();
}

/** The text between `heading` and the next `##`/`###`, exclusive. */
function documentSection(
  relativePath: string,
  heading: string,
): string {
  const text = readRepoFile(relativePath);
  const start = text.indexOf(`\n${heading}\n`);
  if (start === -1) {
    throw new Error(
      `${relativePath} no longer has the heading "${heading}". This contract ` +
        "anchors on it, so a rename fails loudly here rather than silently " +
        "checking nothing — which is the failure mode that let the runbook " +
        "list go four providers stale in the first place.",
    );
  }
  const body = text.slice(start + heading.length + 2);
  const end = body.search(/^#{2,3} /m);
  return end === -1 ? body : body.slice(0, end);
}

describe("credential blast-radius documentation contract (#2720)", () => {
  it("finds the write allowlist it is meant to police", () => {
    const providers = writableProviders();

    expect(providers.length).toBeGreaterThanOrEqual(
      MINIMUM_EXPECTED_PROVIDERS,
    );
    // Resolved through the constants, so this also proves the parse is reading
    // real names rather than identifier text.
    expect(providers).toContain("xero");
    expect(providers).toContain("stripe");
  });

  it("names every writable provider in the one canonical list", () => {
    const canonical = documentSection(
      CANONICAL_LIST_DOC,
      CANONICAL_LIST_HEADING,
    );
    const missing = writableProviders().filter(
      (provider) => !canonical.includes(`\`${provider}\``),
    );

    expect(
      missing,
      `${CANONICAL_LIST_DOC} → "${CANONICAL_LIST_HEADING}" does not name every ` +
        "provider the credential write endpoint accepts. Rotating the auth " +
        "secret strands all of them, and this list is what an operator plans " +
        "the rotation from — a provider missing here is one they meet " +
        "mid-rotation, after sessions and 2FA are already gone. Add it with " +
        "the keys it holds and the issue that introduced it.",
    ).toEqual([]);
  });

  it("names every background credential writer, and invents none (#2723)", () => {
    const section = documentSection(CANONICAL_LIST_DOC, ACTOR_LIST_HEADING);
    // Read back what the page actually claims, from its own bullets, so the
    // comparison is set-to-set rather than "does the text mention it".
    const documented = [
      ...section.matchAll(/^- `([a-z0-9-]+)`/gm),
    ].map((match) => match[1]);

    expect(
      documented.length,
      `${CANONICAL_LIST_DOC} → "${ACTOR_LIST_HEADING}" parsed to no entries at ` +
        "all, so this check would pass over an empty set. The list is written " +
        "as one `- \`actor-name\` — description` bullet per actor; keep that " +
        "shape or teach this parser the new one.",
    ).toBeGreaterThan(0);

    expect(
      [...documented].sort(),
      `${CANONICAL_LIST_DOC} → "${ACTOR_LIST_HEADING}" does not match ` +
        "CREDENTIAL_SYSTEM_ACTORS. That list is closed and every entry is a " +
        "background writer with access to a stored secret, so an operator " +
        "reading this page to find out which job touched a credential must be " +
        "reading the real set. Add or remove the bullet in the same change as " +
        "the constant — a second hand-written list is the defect this whole " +
        "file exists to prevent.",
    ).toEqual([...CREDENTIAL_SYSTEM_ACTORS].sort());
  });

  it("keeps the rotation runbook pointing at that list instead of copying it", () => {
    const runbook = documentSection(
      ROTATION_RUNBOOK_DOC,
      ROTATION_RUNBOOK_HEADING,
    );

    expect(
      runbook.includes(CANONICAL_LIST_LINK),
      `${ROTATION_RUNBOOK_DOC} → "${ROTATION_RUNBOOK_HEADING}" must link to ` +
        `${CANONICAL_LIST_LINK}. A second hand-written provider list is the ` +
        "defect this contract exists to prevent: the runbook's own copy named " +
        "two providers and stayed that way while four more joined the store.",
    ).toBe(true);
  });
});
