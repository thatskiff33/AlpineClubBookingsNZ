/**
 * The ALLOWLIST that decides which repo files may enter the knowledge bundle
 * (AID-3). Generation is allowlist-first: a file is included ONLY if it matches
 * an include glob, matches no exclude glob, and has a text-like extension. A
 * file that matches nothing is silently excluded — the safe default.
 *
 * DEFAULT SCOPE (owner-approved on PR #2531): docs, the
 * top-level project docs, and `prisma/schema.prisma`. These are exactly the
 * things the runtime image EXCLUDES today (`.dockerignore` drops `docs/` and
 * `*.md`), so bundling them is the whole point — Diagnostics can then answer
 * docs/schema questions from the deployed artifact instead of guessing. First-
 * party SOURCE (`src/**`) is intentionally NOT in the default: a private fork
 * may hold code it does not want summarized to a model, so widening to source
 * is a per-deployment OPT-IN via the overlay, never a public-code mandate.
 *
 * HARD_EXCLUDE can NEVER be re-included by an overlay: env files, private-key
 * material, the private deployment overlay paths (mirrors `.gitignore`), build
 * output, dependencies, `.git`, and generated code. Security excludes are not a
 * matter of configuration.
 */

import { must } from "@/lib/indexed-access";

/** Overlay a deployment MAY supply to widen (or further restrict) the allowlist. */
export interface KnowledgeAllowlistOverlay {
  /** Extra include globs (e.g. a fork opting its own `src/**` in). */
  include?: string[];
  /** Extra exclude globs (always win over includes). */
  exclude?: string[];
}

export interface ResolvedAllowlist {
  include: string[];
  exclude: string[];
}

/** Default include globs. Conservative and deployment-widened via the overlay. */
export const DEFAULT_INCLUDE_GLOBS: readonly string[] = [
  "docs/**/*.md",
  "README.md",
  "AGENTS.md",
  "CONFIGURATION.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "DEPLOYMENT.md",
  "prisma/schema.prisma",
];

/**
 * Ready-to-enable first-party SOURCE globs. NOT part of the default — a
 * deployment that wants code answers copies these into its overlay `include`
 * after reviewing its own `src/` for private material.
 */
export const OPTIONAL_SOURCE_INCLUDE_GLOBS: readonly string[] = [
  "src/**/*.ts",
  "src/**/*.tsx",
];

/** Default (overlay-relaxable) excludes: tests, fixtures, mocks, type shims. */
export const DEFAULT_EXCLUDE_GLOBS: readonly string[] = [
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/__tests__/**",
  "**/__mocks__/**",
  "**/*.d.ts",
];

/**
 * Security-critical excludes. Applied to EVERY resolution and never removable by
 * an overlay. Mirrors the "Private deployment overlay" block in `.gitignore` so
 * a fork's private identity, seeds, and branding can never be extracted.
 */
export const HARD_EXCLUDE_GLOBS: readonly string[] = [
  ".git/**",
  "node_modules/**",
  ".next/**",
  ".artifacts/**",
  "coverage/**",
  "test-results/**",
  "playwright-report/**",
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa*",
  "src/generated/**",
  "**/*.generated.*",
  // Private deployment overlay (kept in lockstep with .gitignore).
  "config/club.json",
  "config/features.json",
  "config/diagnostics-knowledge.json",
  "seeds/**",
  "public/branding/**",
  "public/images/**",
  // Runtime uploads / dumps / logs / backups.
  "uploads/**",
  "**/*.log",
  "**/*.dump",
  "**/*.sql.gz",
  "backups/**",
];

/** Extensions the bundle will carry. A backstop against binary/asset inclusion. */
const TEXT_EXTENSIONS = new Set([
  ".md",
  ".prisma",
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".sql",
  ".txt",
  ".yml",
  ".yaml",
  ".css",
]);

/** Compile a restricted glob (`**`, `*`, `?`, literals) to an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = must(glob[i], `globToRegExp: no character at index ${i} within glob.length`);
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i += 1;
        if (glob[i + 1] === "/") {
          i += 1;
          re += "(?:[^/]+/)*"; // '**/' → zero or more path segments
        } else {
          re += ".*"; // '**' → anything, including '/'
        }
      } else {
        re += "[^/]*"; // '*' → within one segment
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/**
 * True when a path matches the security-critical HARD_EXCLUDE set — the paths no
 * overlay of any kind may re-include (env files, key material, the private
 * deployment overlay files, build output, generated code). Checked BOTH as given
 * and lower-cased, because the globs are lowercase and a HARD_EXCLUDE must not be
 * evadable with `.ENV` / `ID_RSA`. Used by the private-knowledge overlay
 * (`overlay.ts`) to refuse an entry whose handle claims to be an excluded file,
 * and available to any other caller that must honour the same floor.
 */
export function isHardExcluded(path: string): boolean {
  return (
    matchesAny(path, HARD_EXCLUDE_GLOBS) ||
    matchesAny(path.toLowerCase(), HARD_EXCLUDE_GLOBS)
  );
}

function extensionOf(path: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash ? path.slice(dot).toLowerCase() : "";
}

/** True when the path has a text-like extension the bundle is willing to carry. */
export function isTextlikePath(path: string): boolean {
  return TEXT_EXTENSIONS.has(extensionOf(path));
}

/** Merge the built-in defaults with an optional overlay into a concrete lattice. */
export function resolveAllowlist(
  overlay: KnowledgeAllowlistOverlay = {},
): ResolvedAllowlist {
  return {
    include: [...DEFAULT_INCLUDE_GLOBS, ...(overlay.include ?? [])],
    // HARD excludes are appended LAST and cannot be dropped by the overlay.
    exclude: [
      ...DEFAULT_EXCLUDE_GLOBS,
      ...(overlay.exclude ?? []),
      ...HARD_EXCLUDE_GLOBS,
    ],
  };
}

/**
 * Decide whether a repo-relative POSIX path is allowlisted. Exclusion wins over
 * inclusion; a non-text extension is refused regardless of the globs.
 */
export function isAllowlisted(
  path: string,
  allowlist: ResolvedAllowlist,
): boolean {
  if (!isTextlikePath(path)) return false;
  if (matchesAny(path, allowlist.exclude)) return false;
  return matchesAny(path, allowlist.include);
}
