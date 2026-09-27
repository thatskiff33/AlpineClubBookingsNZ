#!/usr/bin/env -S npx tsx
/**
 * Generate the deployed-code knowledge bundle (AID-3, #2372).
 *
 *   GIT_COMMIT_SHA=<sha> pnpm run diagnostics:bundle
 *
 * Runs in the DOCKER BUILDER (and locally the same way), where the dependencies
 * exist — a club server's `docker compose build` has no host Node toolchain, so
 * generation has to happen inside the image. It walks the allowlist
 * (`src/lib/diagnostics/knowledge/allowlist.ts`) over the working tree, reads
 * each file, and hands them to the PURE generator — no database, no network. The
 * bundle is written to `.artifacts/diagnostics/knowledge-bundle.json`, traced
 * into `.next/standalone` (`next.config.ts`), and copied into the runner
 * (`Dockerfile`). `.git` is absent from the build context, so the commit SHA
 * comes from `GIT_COMMIT_SHA` (the builder injects it as a build ARG).
 *
 * FAIL CLOSED: a detected secret (or any generation error) exits non-zero so a
 * deploy stops rather than shipping a leak or an unverifiable bundle.
 *
 * DETERMINISM: the pure core is a function of (files, commitSha, observedAt). For
 * a byte-reproducible artifact, pass `GIT_COMMIT_SHA` and
 * `KNOWLEDGE_BUNDLE_OBSERVED_AT` (the release sets observedAt to the commit
 * date); otherwise they fall back to `git` and, last, the wall clock.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  isAllowlisted,
  resolveAllowlist,
  type KnowledgeAllowlistOverlay,
} from "../../src/lib/diagnostics/knowledge/allowlist";
import {
  buildKnowledgeBundle,
  KnowledgeBundleSecretError,
  type KnowledgeSourceFile,
} from "../../src/lib/diagnostics/knowledge/generate";
import { KnowledgeOverlayError } from "../../src/lib/diagnostics/knowledge/overlay";
import { serializeBundle } from "../../src/lib/diagnostics/knowledge/serialize";
import {
  KNOWLEDGE_BUNDLE_PLACEHOLDER_SHA,
  KNOWLEDGE_BUNDLE_RELATIVE_PATH,
} from "../../src/lib/diagnostics/knowledge/types";

const REPO_ROOT = process.cwd();

/**
 * The conventional, git-ignored, HARD_EXCLUDE-d slot a deployment populates with
 * its private Diagnostics knowledge config. GENERIC MECHANISM (ADR-006 §4): the
 * DEFAULT location only. A fork may point elsewhere with
 * `DIAGNOSTICS_KNOWLEDGE_CONFIG_PATH` — public code embeds no deployment-specific
 * path or content, and assumes nothing about what the file contains.
 *
 * The file carries two independent, both-optional sections:
 *   - `include` / `exclude` — the ALLOWLIST overlay (which committed repo files to
 *     bundle), consumed by `resolveAllowlist`;
 *   - `knowledge` — the PRIVATE KNOWLEDGE OVERLAY (ADR-006 §4), extra inline
 *     knowledge entries with no committed repo file, consumed by the generator as
 *     `knowledgeOverlay` (validated + secret-scanned + fail-closed there).
 */
const DIAGNOSTICS_KNOWLEDGE_CONFIG_PATH =
  process.env.DIAGNOSTICS_KNOWLEDGE_CONFIG_PATH?.trim() ||
  path.join(REPO_ROOT, "config", "diagnostics-knowledge.json");

/** Directories never worth descending into (fast prune before per-file globbing). */
const PRUNE_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  ".artifacts",
  "coverage",
  "test-results",
  "playwright-report",
  ".vercel",
  "build",
  "dist",
]);

function tryGit(args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function resolveCommitSha(): string {
  const fromEnv = process.env.GIT_COMMIT_SHA?.trim();
  if (fromEnv) return fromEnv;
  const fromGit = tryGit(["rev-parse", "HEAD"]);
  if (fromGit) return fromGit;
  console.warn(
    "[knowledge-bundle] No GIT_COMMIT_SHA and no git — writing placeholder SHA; " +
      "the runtime loader will treat the bundle as UNVERIFIED and disable code answers.",
  );
  return KNOWLEDGE_BUNDLE_PLACEHOLDER_SHA;
}

function resolveObservedAt(): string {
  const fromEnv = process.env.KNOWLEDGE_BUNDLE_OBSERVED_AT?.trim();
  if (fromEnv) return fromEnv;
  const commitDate = tryGit(["show", "-s", "--format=%cI", "HEAD"]);
  if (commitDate) return commitDate;
  return new Date().toISOString();
}

interface DeploymentKnowledgeConfig {
  /** The allowlist overlay (which committed repo files to bundle). */
  allowlist: KnowledgeAllowlistOverlay;
  /**
   * The raw private-knowledge overlay section, passed through UNVALIDATED — the
   * pure generator owns its schema, secret scan, and fail-closed contract so the
   * one validation lives in one place. `undefined` when the section is absent.
   */
  knowledge: unknown;
}

/**
 * Read the deployment's Diagnostics knowledge config, or empty defaults when the
 * file is absent (the normal case). FAILS CLOSED on a present-but-malformed file:
 * a config we cannot parse must stop the build, not be silently ignored — the same
 * posture as a detected secret. (This tightens the previous "warn and ignore"
 * behaviour, deliberately, now that the file can carry knowledge CONTENT.)
 */
function loadDeploymentKnowledgeConfig(): DeploymentKnowledgeConfig {
  let raw: string;
  try {
    raw = readFileSync(DIAGNOSTICS_KNOWLEDGE_CONFIG_PATH, "utf8");
  } catch {
    return { allowlist: {}, knowledge: undefined };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new KnowledgeOverlayError(
      `config at ${DIAGNOSTICS_KNOWLEDGE_CONFIG_PATH} is not valid JSON — ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const config = parsed as {
    include?: unknown;
    exclude?: unknown;
    knowledge?: unknown;
  };
  const asStringArray = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.every((x) => typeof x === "string")
      ? (v as string[])
      : undefined;

  return {
    allowlist: {
      include: asStringArray(config.include),
      exclude: asStringArray(config.exclude),
    },
    knowledge: config.knowledge,
  };
}

function walk(dirAbs: string, relBase: string, out: string[]): void {
  const entries = readdirSync(dirAbs, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue; // never follow symlinks out of the tree
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (PRUNE_DIRS.has(entry.name)) continue;
      walk(path.join(dirAbs, entry.name), rel, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}

function main(): void {
  let config: DeploymentKnowledgeConfig;
  try {
    config = loadDeploymentKnowledgeConfig();
  } catch (err) {
    if (err instanceof KnowledgeOverlayError) {
      console.error(`[knowledge-bundle] FAIL CLOSED — ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  const allowlist = resolveAllowlist(config.allowlist);

  const allPaths: string[] = [];
  walk(REPO_ROOT, "", allPaths);

  const files: KnowledgeSourceFile[] = [];
  for (const rel of allPaths) {
    if (!isAllowlisted(rel, allowlist)) continue;
    files.push({ path: rel, content: readFileSync(path.join(REPO_ROOT, rel), "utf8") });
  }

  const commitSha = resolveCommitSha();
  const observedAt = resolveObservedAt();

  let serialized: string;
  try {
    const bundle = buildKnowledgeBundle({
      files,
      commitSha,
      observedAt,
      overlay: config.allowlist,
      knowledgeOverlay: config.knowledge,
    });
    serialized = serializeBundle(bundle);
    const overlayCount = bundle.entries.filter((e) =>
      e.sensitivity.includes("overlay"),
    ).length;
    console.log(
      `[knowledge-bundle] ${bundle.entries.length} entries ` +
        `(${overlayCount} from the private overlay), ` +
        `${bundle.entries.reduce((n, e) => n + e.excerpts.length, 0)} excerpts, ` +
        `commit ${commitSha.slice(0, 12)}, digest ${bundle.integrity.entriesDigest.slice(0, 12)}.`,
    );
  } catch (err) {
    if (
      err instanceof KnowledgeBundleSecretError ||
      err instanceof KnowledgeOverlayError
    ) {
      console.error(`[knowledge-bundle] FAIL CLOSED — ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const outPath = path.join(REPO_ROOT, KNOWLEDGE_BUNDLE_RELATIVE_PATH);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, serialized, "utf8");
  console.log(`[knowledge-bundle] Wrote ${KNOWLEDGE_BUNDLE_RELATIVE_PATH}.`);
}

main();
