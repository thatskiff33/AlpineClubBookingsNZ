/**
 * Deployed-code knowledge bundle — shared types, constants, and the zod schema
 * that BOTH the generator and the runtime loader validate against (AID-3, epic
 * #2369, issue #2372).
 *
 * The bundle is a DETERMINISTIC, VERSIONED snapshot of the allowlisted source,
 * docs, and schema of the exact commit that was deployed. It lets the (later)
 * AI Diagnostics product answer "what does the running code/docs/schema say?"
 * from the artifact ACTUALLY running — never from a working tree, a live `.git`
 * (absent in the runner), or model memory.
 *
 * SECURITY POSTURE (do not weaken without an owner decision on #2370):
 *  - The bundle is UNTRUSTED, prompt-injection-capable evidence. Nothing in it
 *    is system authority. Retrieval frames excerpts as cited SOURCE evidence
 *    only (see `retrieve.ts`), never as a statement of current runtime state.
 *  - Generation FAILS CLOSED on any secret and excludes an enumerated set of
 *    sensitive paths (see `secret-scan.ts` / `allowlist.ts`).
 *  - The loader FAILS CLOSED: a missing, malformed, tampered, hash-mismatched,
 *    or unverified-commit bundle DISABLES code answers rather than falling back
 *    to a working tree or unverified memory (see `load.ts`).
 */

import { z } from "zod";

/**
 * Bundle format version. Bump only on a breaking schema change; the loader
 * pins to this exact value so a runner can never silently read a bundle it does
 * not understand.
 */
export const KNOWLEDGE_BUNDLE_SCHEMA_VERSION = 1 as const;

/** Hash algorithm used for every content/excerpt/integrity digest. */
export const KNOWLEDGE_BUNDLE_HASH_ALGORITHM = "sha256" as const;

/**
 * Runtime-relative path of the traced bundle inside the deployed artifact.
 *
 * `.artifacts/` is deliberately NOT committed to git (see `.gitignore`) and is
 * excluded from the build context (see `.dockerignore`). The bundle is generated
 * IN THE DOCKER BUILDER by `pnpm run diagnostics:bundle` (the builder has the
 * dependencies; a club server's `docker compose build` has no host Node), with
 * the commit SHA injected via the `GIT_COMMIT_SHA` build ARG because `.git` is
 * absent from the context. It is then written here, traced into `.next/standalone`
 * by `next.config.ts`, and copied into the runner by the Dockerfile. The loader
 * resolves this against `process.cwd()` (= `/app` in the standalone runner).
 */
export const KNOWLEDGE_BUNDLE_RELATIVE_PATH =
  ".artifacts/diagnostics/knowledge-bundle.json";

/**
 * Sentinel commit SHA written by the build-time generator (see
 * `scripts/diagnostics/generate-knowledge-bundle.ts`, whose `resolveCommitSha`
 * returns this value) when no real bundle was pre-generated — i.e. when neither
 * `GIT_COMMIT_SHA` nor a `.git` directory is present. The loader treats it — like
 * any non-40-hex or all-zero SHA —
 * as UNVERIFIED and fails closed. It exists only so a bare `docker build` that
 * skipped pre-generation still produces a runnable image with diagnostics
 * disabled, never a broken build.
 */
export const KNOWLEDGE_BUNDLE_PLACEHOLDER_SHA = "0".repeat(40);

/** A full, lowercase, non-zero git commit SHA-1. */
export const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Sensitivity tags attached to every entry. These are METADATA for downstream
 * retrieval policy (#2374+), NOT an exclusion decision — anything genuinely
 * excluded never reaches the bundle at all (see `allowlist.ts`). A file can
 * carry several tags.
 */
export const SENSITIVITY_TAGS = [
  "public-docs",
  "schema",
  "source",
  "config-reference",
  "security-sensitive",
  "finance-sensitive",
  "overlay",
] as const;

export type SensitivityTag = (typeof SENSITIVITY_TAGS)[number];

/** A bounded, individually-hashed slice of a file, addressable for citation. */
export interface KnowledgeExcerpt {
  /** Deterministic id: `${path}#L${startLine}-L${endLine}`. */
  id: string;
  /** Optional human label (heading text, symbol, or block name) for this slice. */
  label: string | null;
  /** 1-based inclusive first line. */
  startLine: number;
  /** 1-based inclusive last line. */
  endLine: number;
  /** sha256 of the excerpt's normalized text. Verified on load and on cite. */
  hash: string;
  /** The excerpt text (newline-normalized, bounded). */
  text: string;
}

/** One allowlisted file, its provenance, and its excerpt index. */
export interface KnowledgeEntry {
  /** Repo-relative POSIX path (forward slashes). */
  path: string;
  /** Coarse language tag derived from the extension (`markdown`, `prisma`, …). */
  language: string;
  /** sha256 of the whole file's newline-normalized content. */
  contentHash: string;
  /** Byte length of the normalized content. */
  byteLength: number;
  /** Line count of the normalized content. */
  lineCount: number;
  /** Sorted, de-duplicated sensitivity tags. */
  sensitivity: SensitivityTag[];
  /** Sorted, de-duplicated top-level symbol / heading / block names. */
  symbols: string[];
  /** Excerpts, sorted by startLine. */
  excerpts: KnowledgeExcerpt[];
}

export interface KnowledgeBundleMeta {
  /**
   * The deployed commit SHA, injected at build time (`.git` is absent in the
   * runner). A placeholder / invalid SHA makes the loader fail closed.
   */
  commitSha: string;
  /**
   * When the bundle was observed/built, as an explicit ISO-8601 input — NEVER
   * read from the wall clock inside the pure generator, so the same source +
   * SHA + observedAt is byte-identical.
   */
  observedAt: string;
  /** Tool identifier + format version, for provenance. */
  generator: string;
  /** Number of entries (== `entries.length`; a cheap tamper tripwire). */
  entryCount: number;
}

export interface KnowledgeBundleIntegrity {
  algorithm: typeof KNOWLEDGE_BUNDLE_HASH_ALGORITHM;
  /**
   * sha256 over the canonical serialization of `entries` ONLY (excludes `meta`,
   * so it is stable across two builds of identical source at different SHAs /
   * times). The loader recomputes and compares; a mismatch is a tamper signal.
   */
  entriesDigest: string;
}

export interface KnowledgeBundle {
  schemaVersion: typeof KNOWLEDGE_BUNDLE_SCHEMA_VERSION;
  meta: KnowledgeBundleMeta;
  integrity: KnowledgeBundleIntegrity;
  entries: KnowledgeEntry[];
}

// --- zod schema (loader-side validation) ------------------------------------

const excerptSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().nullable(),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    text: z.string(),
  })
  .strict();

const entrySchema = z
  .object({
    path: z.string().min(1),
    language: z.string().min(1),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    byteLength: z.number().int().nonnegative(),
    lineCount: z.number().int().nonnegative(),
    sensitivity: z.array(z.enum(SENSITIVITY_TAGS)),
    symbols: z.array(z.string()),
    excerpts: z.array(excerptSchema),
  })
  .strict();

export const knowledgeBundleSchema = z
  .object({
    schemaVersion: z.literal(KNOWLEDGE_BUNDLE_SCHEMA_VERSION),
    meta: z
      .object({
        commitSha: z.string(),
        observedAt: z.string(),
        generator: z.string(),
        entryCount: z.number().int().nonnegative(),
      })
      .strict(),
    integrity: z
      .object({
        algorithm: z.literal(KNOWLEDGE_BUNDLE_HASH_ALGORITHM),
        entriesDigest: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
    entries: z.array(entrySchema),
  })
  .strict();
