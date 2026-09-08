/**
 * PURE generator for the deployed-code knowledge bundle (AID-3, #2372).
 *
 * `buildKnowledgeBundle` is a pure function of its inputs — no filesystem, no
 * network, no database, no wall clock. Given the same `files`, `commitSha`, and
 * `observedAt` it returns a byte-identical bundle (input file ORDER does not
 * matter; files are sorted by path). This is what makes the artifact reproducible
 * and what the determinism tests assert.
 *
 * FAIL CLOSED: if any included file trips the secret scanner, the whole build
 * throws `KnowledgeBundleSecretError` — the bundle is never emitted with the
 * offending file dropped, because a partial bundle would silently hide the leak.
 * The thin script wrapper (`scripts/diagnostics/generate-knowledge-bundle.ts`)
 * turns that throw into a non-zero exit, so a real deploy fails closed.
 */

import {
  isAllowlisted,
  resolveAllowlist,
  type KnowledgeAllowlistOverlay,
} from "./allowlist";
import { compareOrdinal } from "@/lib/ordinal-order";
import { buildExcerpts } from "./excerpt";
import { normalizeContent, sha256Hex } from "./hash";
import { overlayFilesFrom } from "./overlay";
import { scanForSecrets, type SecretFinding } from "./secret-scan";
import { classifyOverlaySensitivity, classifySensitivity } from "./sensitivity";
import { computeEntriesDigest } from "./serialize";
import {
  KNOWLEDGE_BUNDLE_SCHEMA_VERSION,
  KNOWLEDGE_BUNDLE_HASH_ALGORITHM,
  type KnowledgeBundle,
  type KnowledgeEntry,
} from "./types";

export const KNOWLEDGE_BUNDLE_GENERATOR = `knowledge-bundle/v${KNOWLEDGE_BUNDLE_SCHEMA_VERSION}`;

export interface KnowledgeSourceFile {
  /** Repo-relative POSIX path. */
  path: string;
  /** Raw file content (normalized internally before hashing/excerpting). */
  content: string;
}

export interface BuildKnowledgeBundleInput {
  files: ReadonlyArray<KnowledgeSourceFile>;
  /** Deployed commit SHA (validity is enforced at LOAD, not here). */
  commitSha: string;
  /** Explicit ISO-8601 observed-at (never read from the clock here). */
  observedAt: string;
  /** Optional deployment-owned allowlist widening/narrowing (WHICH repo files). */
  overlay?: KnowledgeAllowlistOverlay;
  /**
   * Optional deployment-owned PRIVATE KNOWLEDGE OVERLAY (ADR-006 §4) — extra,
   * deployment-supplied knowledge CONTENT with no committed repo file. Distinct
   * from `overlay` above. Passed as the raw (untrusted) parsed object; it is
   * validated here and FAILS CLOSED (`KnowledgeOverlayError`) if malformed. Absent
   * ⇒ the bundle is byte-identical to one built without this feature.
   */
  knowledgeOverlay?: unknown;
}

/** Thrown when a secret would enter the bundle. Fail-closed signal. */
export class KnowledgeBundleSecretError extends Error {
  readonly findings: Array<{ path: string; finding: SecretFinding }>;
  constructor(findings: Array<{ path: string; finding: SecretFinding }>) {
    const summary = findings
      .map((f) => `${f.path}:${f.finding.line} (${f.finding.rule}: ${f.finding.preview})`)
      .join(", ");
    super(`Knowledge bundle generation refused: secret material detected — ${summary}`);
    this.name = "KnowledgeBundleSecretError";
    this.findings = findings;
  }
}

function buildEntry(
  file: KnowledgeSourceFile,
  opts: { overlay?: boolean } = {},
): KnowledgeEntry {
  const content = normalizeContent(file.content);
  const { language, symbols, excerpts } = buildExcerpts(file.path, content);
  const lineCount =
    content === ""
      ? 0
      : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);

  return {
    path: file.path,
    language,
    contentHash: sha256Hex(content),
    byteLength: Buffer.byteLength(content, "utf8"),
    lineCount,
    // A private-overlay entry carries the `overlay` base tag (plus the same
    // additive risk classes); a repo file gets its location/language base tag.
    sensitivity: opts.overlay
      ? classifyOverlaySensitivity(file.path, language)
      : classifySensitivity(file.path, language),
    symbols,
    excerpts,
  };
}

/**
 * Build the deterministic knowledge bundle. Repo files are (defensively)
 * re-filtered through the resolved allowlist; an optional private knowledge
 * overlay (ADR-006 §4) contributes additional entries. BOTH sources are
 * secret-scanned (fail closed), sorted by path, and de-duplicated (a duplicate
 * path is a fatal input error), and BOTH participate in the single integrity
 * digest over the entries — so `verify.ts`'s fail-closed contract is unchanged
 * whether or not an overlay is present.
 */
export function buildKnowledgeBundle(
  input: BuildKnowledgeBundleInput,
): KnowledgeBundle {
  const allowlist = resolveAllowlist(input.overlay);

  // Defense in depth: even though the script pre-filters, only allowlisted paths
  // are ever considered here.
  const fileCandidates = input.files.filter((f) =>
    isAllowlisted(f.path, allowlist),
  );

  // The PRIVATE KNOWLEDGE OVERLAY (ADR-006 §4). Validated + HARD_EXCLUDE-checked +
  // namespaced under `overlay/` by `overlayFilesFrom`, which FAILS CLOSED
  // (`KnowledgeOverlayError`) on a malformed overlay or a boundary-violating handle.
  // From here on overlay entries are ordinary source files: the SAME dedupe, the
  // SAME secret scan, the SAME excerpting/hashing, and the SAME single integrity
  // digest apply — the only difference is the `overlay` sensitivity base tag.
  const overlayCandidates = overlayFilesFrom(input.knowledgeOverlay);

  // Reject duplicate paths outright — silently keeping "the last one" would make
  // the output depend on input order, breaking determinism. The `overlay/`
  // namespace means an overlay entry can never collide with a repo file, so a
  // collision here is two overlay entries sharing a handle, or genuinely duplicate
  // repo input — both are input errors.
  const allCandidates = [...fileCandidates, ...overlayCandidates];
  const seen = new Set<string>();
  for (const f of allCandidates) {
    if (seen.has(f.path)) {
      throw new Error(`Duplicate path in knowledge bundle input: ${f.path}`);
    }
    seen.add(f.path);
  }

  // Secret scan every included file — repo AND overlay — BEFORE building anything.
  // Fail closed: an overlay secret refuses the whole build exactly like a repo one.
  const secretFindings: Array<{ path: string; finding: SecretFinding }> = [];
  for (const f of allCandidates) {
    for (const finding of scanForSecrets(normalizeContent(f.content))) {
      secretFindings.push({ path: f.path, finding });
    }
  }
  if (secretFindings.length > 0) {
    throw new KnowledgeBundleSecretError(secretFindings);
  }

  const entries = [
    ...fileCandidates.map((f) => buildEntry(f)),
    ...overlayCandidates.map((f) => buildEntry(f, { overlay: true })),
    // Ordinal (#3252): the bundle's integrity digest is computed over these
    // entries IN THIS ORDER and later compared against bytes already written to
    // disk, so the order cannot depend on the collation of the machine that
    // generated it.
  ].sort((a, b) => compareOrdinal(a.path, b.path));

  return {
    schemaVersion: KNOWLEDGE_BUNDLE_SCHEMA_VERSION,
    meta: {
      commitSha: input.commitSha,
      observedAt: input.observedAt,
      generator: KNOWLEDGE_BUNDLE_GENERATOR,
      entryCount: entries.length,
    },
    integrity: {
      algorithm: KNOWLEDGE_BUNDLE_HASH_ALGORITHM,
      entriesDigest: computeEntriesDigest(entries),
    },
    entries,
  };
}
