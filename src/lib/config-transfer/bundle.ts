import "server-only";

import { createHash } from "node:crypto";
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";

import { parseCsv } from "./csv";
import {
  CONFIG_TRANSFER_CATEGORIES,
  CONFIG_TRANSFER_FORMAT_VERSION,
  CONFIG_TRANSFER_MANIFEST_PATH,
  configTransferManifestSchema,
  type ConfigTransferCategory,
  type ConfigTransferManifest,
} from "./manifest";

// Zip read/write for config-transfer bundles, with integrity + safety limits.
// A bundle is untrusted input (hand-editable), so readBundle validates the
// manifest, verifies every declared checksum, and rejects anything unexpected
// or oversized before the engine sees it. See ADR-002 "Security Considerations".

/** Overall (compressed) bundle upload cap (MVP). */
export const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;
/**
 * Per-field cap for the bundle upload's accompanying form fields (mode /
 * categories / resolutions / expectedFingerprint). The `resolutions` JSON grows
 * with the number of match conflicts an admin resolves, so it can legitimately
 * exceed the streamed reader's 1 MiB default — 2 MiB gives real headroom while
 * still bounding a hostile field. (#2235 Finding 3.)
 */
export const MAX_BUNDLE_UPLOAD_FIELD_BYTES = 2 * 1024 * 1024;
/**
 * Whole multipart request-body ceiling for a bundle upload: the bundle file cap
 * plus headroom for the accompanying form fields and multipart boundary
 * overhead. Enforced by the streamed reader before the body is buffered (#2235).
 *
 * Arithmetic: worst legitimate body = a 50 MiB bundle file at its cap + a 2 MiB
 * `resolutions` field (MAX_BUNDLE_UPLOAD_FIELD_BYTES) + the small mode /
 * categories / expectedFingerprint fields + multipart part-header/boundary
 * overhead (a few KiB). The 4 MiB of headroom below covers the 2 MiB field plus
 * that slack, so a legitimate max-size bundle carrying a large resolutions set
 * is not spuriously rejected by the request cap before the field cap can apply.
 */
export const MAX_BUNDLE_REQUEST_BYTES = MAX_BUNDLE_BYTES + 4 * 1024 * 1024;
/**
 * Per-file uncompressed cap, enforced BEFORE inflation via the unzip filter.
 * (Media files are additionally capped at MAX_MEDIA_IMAGE_BYTES by the media
 * plan/apply phase in media.ts.)
 */
export const MAX_BUNDLE_FILE_BYTES = 8 * 1024 * 1024;
/** Total uncompressed cap across all entries, enforced before inflation. */
export const MAX_BUNDLE_TOTAL_BYTES = 100 * 1024 * 1024;
/** Guard against zip-bomb-style entry counts, enforced before inflation. */
export const MAX_BUNDLE_FILES = 2000;

export class ConfigTransferBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigTransferBundleError";
  }
}

/** Exact-version gate, parameterised so tests can prove old/new-reader safety. */
export function assertConfigTransferFormatVersion(
  bundleVersion: number,
  supportedVersion = CONFIG_TRANSFER_FORMAT_VERSION,
): void {
  if (bundleVersion > supportedVersion) {
    throw new ConfigTransferBundleError(
      `Bundle format version ${bundleVersion} is newer than this ` +
        `app supports (${supportedVersion}); upgrade before importing`,
    );
  }
  if (bundleVersion < supportedVersion) {
    throw new ConfigTransferBundleError(
      `Bundle format version ${bundleVersion} predates this app's ` +
        `format (${supportedVersion}) and cannot be imported; ` +
        `re-export from an up-to-date app`,
    );
  }
}

export type BundleEntry = {
  /** Path within the zip, e.g. "site-content/pages.csv". Never "manifest.json". */
  path: string;
  category: ConfigTransferCategory;
  /** Row count for tabular/document files; null for binary media. */
  rowCount: number | null;
  bytes: Uint8Array;
};

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type BuildBundleParams = {
  entries: BundleEntry[];
  appVersion: string;
  prismaMigration: string | null;
  includedCategories: ConfigTransferCategory[];
  doorCodesIncluded: boolean;
  /** ISO-8601 timestamp; the app stamps this (kept out of this pure builder). */
  generatedAt: string;
};

/** Build a bundle's zip bytes: manifest (with per-file checksums) + entries. */
export function buildBundle(params: BuildBundleParams): Uint8Array {
  const seen = new Set<string>();
  for (const entry of params.entries) {
    if (entry.path === CONFIG_TRANSFER_MANIFEST_PATH) {
      throw new ConfigTransferBundleError(
        `Entry path collides with the manifest: ${entry.path}`,
      );
    }
    if (seen.has(entry.path)) {
      throw new ConfigTransferBundleError(`Duplicate entry path: ${entry.path}`);
    }
    seen.add(entry.path);
  }

  const manifest: ConfigTransferManifest = {
    formatVersion: CONFIG_TRANSFER_FORMAT_VERSION,
    generatedAt: params.generatedAt,
    app: {
      version: params.appVersion,
      prismaMigration: params.prismaMigration,
    },
    includedCategories: params.includedCategories,
    files: params.entries.map((entry) => ({
      path: entry.path,
      category: entry.category,
      rowCount: entry.rowCount,
      sha256: sha256Hex(entry.bytes),
    })),
    doorCodesIncluded: params.doorCodesIncluded,
  };

  const zippable: Record<string, Uint8Array> = {
    [CONFIG_TRANSFER_MANIFEST_PATH]: strToU8(
      JSON.stringify(manifest, null, 2),
    ),
  };
  for (const entry of params.entries) {
    zippable[entry.path] = entry.bytes;
  }

  return zipSync(zippable, { level: 6 });
}

export type ReadBundleResult = {
  manifest: ConfigTransferManifest;
  /**
   * Every non-manifest file actually present in the zip, keyed by path
   * (files-first: the importer trusts the bytes on disk, not the manifest's
   * declared list, so a hand-added file is usable and a hand-removed one simply
   * absent).
   */
  files: Map<string, Uint8Array>;
  /**
   * Advisory integrity notes (checksum drift, declared-but-missing, or
   * present-but-undeclared files). Surfaced in the dry-run so the admin can
   * decide; never blocks the import. See ADR-001 "hand-edit".
   */
  warnings: string[];
};

/** Reject path-traversal / absolute / backslash entry names (safety, not integrity). */
function isUnsafeEntryPath(name: string): boolean {
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return true;
  if (name.includes("\\")) return true;
  return name.split("/").some((seg) => seg === ".." || seg === ".");
}

/**
 * Junk a re-zip adds that is never bundle data: directory markers ("foo/"),
 * macOS resource forks, and Finder metadata. Skipped BEFORE inflation.
 */
function isJunkEntry(name: string): boolean {
  return (
    name.endsWith("/") ||
    name.startsWith("__MACOSX/") ||
    name.split("/").includes(".DS_Store")
  );
}

/**
 * Tolerate the single-wrapper-directory re-zip mistake: if `manifest.json`
 * isn't at the root but exactly one top-level folder contains it (the macOS
 * "Compress the folder" shape), strip that folder prefix so the bundle reads
 * as if at the root. Files OUTSIDE the wrapper are not silently dropped — they
 * are returned as `discarded` so the dry-run can warn about them. Anything
 * ambiguous (no wrapper, or several candidates) is left as-is and falls through
 * to the normal missing-manifest error.
 */
function normalizeBundleEntries(unzipped: Record<string, Uint8Array>): {
  entries: Record<string, Uint8Array>;
  discarded: string[];
} {
  const cleaned = Object.entries(unzipped);
  if (cleaned.some(([name]) => name === CONFIG_TRANSFER_MANIFEST_PATH)) {
    return { entries: Object.fromEntries(cleaned), discarded: [] };
  }
  const wrapperPrefixes = new Set<string>();
  for (const [name] of cleaned) {
    const slash = name.indexOf("/");
    if (slash > 0 && name.slice(slash + 1) === CONFIG_TRANSFER_MANIFEST_PATH) {
      wrapperPrefixes.add(name.slice(0, slash + 1));
    }
  }
  // `wrapperPrefixes.size === 1` guarantees an element, but destructuring a
  // Set is still an iterator read the type can't mark present — and an
  // absent prefix here is exactly the "ambiguous" case the docstring already
  // falls through for, so it is handled the same way rather than asserted
  // away.
  const [prefix] = wrapperPrefixes;
  if (wrapperPrefixes.size === 1 && prefix !== undefined) {
    const discarded = cleaned
      .filter(([name]) => !name.startsWith(prefix))
      .map(([name]) => name);
    return {
      entries: Object.fromEntries(
        cleaned
          .filter(([name]) => name.startsWith(prefix))
          .map(([name, bytes]) => [name.slice(prefix.length), bytes]),
      ),
      discarded,
    };
  }
  return { entries: Object.fromEntries(cleaned), discarded: [] };
}

/**
 * Parse + validate a bundle. HARD-throws ConfigTransferBundleError only for
 * problems that make the bundle unprocessable or unsafe: oversized, too many
 * files, unsafe entry paths, not-a-zip, missing/invalid manifest, or an
 * unsupported (newer) format version. Integrity issues that a hand-editor can
 * legitimately cause — checksum drift, row-count/file-set differences — are
 * returned as `warnings`, not thrown, because bundles are meant to be editable
 * and a human reviews the dry-run before anything writes (ADR-001 "hand-edit").
 */
export function readBundle(zipBytes: Uint8Array): ReadBundleResult {
  if (zipBytes.byteLength > MAX_BUNDLE_BYTES) {
    throw new ConfigTransferBundleError(
      `Bundle exceeds the ${MAX_BUNDLE_BYTES}-byte limit`,
    );
  }

  // Resource limits are enforced BEFORE inflation via the unzip filter: junk
  // entries are never inflated, and the entry-count / per-file / total
  // UNCOMPRESSED caps fire on the zip's declared sizes — so a high-ratio or
  // many-entry zip within the 50MB compressed cap cannot exhaust memory
  // (fflate reports `originalSize` = uncompressed bytes pre-inflation).
  let entryCount = 0;
  let totalBytes = 0;
  let capError: ConfigTransferBundleError | null = null;
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(zipBytes, {
      filter: (info) => {
        if (isJunkEntry(info.name)) return false;
        entryCount += 1;
        totalBytes += info.originalSize ?? 0;
        if (entryCount > MAX_BUNDLE_FILES) {
          capError = new ConfigTransferBundleError(
            `Bundle has too many files (> ${MAX_BUNDLE_FILES})`,
          );
          throw capError;
        }
        if ((info.originalSize ?? 0) > MAX_BUNDLE_FILE_BYTES) {
          capError = new ConfigTransferBundleError(
            `Bundle file exceeds the per-file limit: ${info.name}`,
          );
          throw capError;
        }
        if (totalBytes > MAX_BUNDLE_TOTAL_BYTES) {
          capError = new ConfigTransferBundleError(
            `Bundle exceeds the total uncompressed limit`,
          );
          throw capError;
        }
        return true;
      },
    });
  } catch (error) {
    if (capError) throw capError;
    if (error instanceof ConfigTransferBundleError) throw error;
    throw new ConfigTransferBundleError("Bundle is not a valid zip archive");
  }
  // Forgive the single-wrapper-folder re-zip mistake, keeping note of any
  // files outside the wrapper so they warn instead of vanishing silently.
  const normalized = normalizeBundleEntries(unzipped);
  unzipped = normalized.entries;

  const names = Object.keys(unzipped);
  for (const name of names) {
    if (isUnsafeEntryPath(name)) {
      throw new ConfigTransferBundleError(
        `Bundle contains an unsafe entry path: ${name}`,
      );
    }
  }

  const manifestBytes = unzipped[CONFIG_TRANSFER_MANIFEST_PATH];
  if (!manifestBytes) {
    throw new ConfigTransferBundleError("Bundle is missing manifest.json");
  }

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(strFromU8(manifestBytes));
  } catch {
    throw new ConfigTransferBundleError("manifest.json is not valid JSON");
  }

  const parsed = configTransferManifestSchema.safeParse(manifestJson);
  if (!parsed.success) {
    throw new ConfigTransferBundleError(
      `manifest.json failed validation: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  const manifest = parsed.data;

  assertConfigTransferFormatVersion(manifest.formatVersion);

  // v2 changed the theme columns; v3 adds destructive booking-policy replace
  // semantics. Neither has a safe translation path, so capability is exact.

  // Files-first: every file actually present (bar the manifest) is usable.
  const files = new Map<string, Uint8Array>();
  for (const name of names) {
    if (name === CONFIG_TRANSFER_MANIFEST_PATH) continue;
    const bytes = unzipped[name];
    // Unreachable: `name` came from `Object.keys(unzipped)` above.
    if (!bytes) continue;
    files.set(name, bytes);
  }

  // Advisory integrity: compare the manifest's declared file list to what is
  // present. Drift is expected for hand-edited bundles, so these are warnings.
  const warnings: string[] = [];
  for (const dropped of normalized.discarded) {
    warnings.push(
      `${dropped} sits outside the bundle's root folder and will be ignored ` +
        `(re-zip the bundle contents, not the folder, to include it)`,
    );
  }
  const declared = new Set<string>();
  for (const file of manifest.files) {
    declared.add(file.path);
    const bytes = files.get(file.path);
    if (!bytes) {
      warnings.push(`Manifest lists ${file.path}, but it is not in the bundle`);
      continue;
    }
    if (sha256Hex(bytes) !== file.sha256) {
      warnings.push(
        `${file.path} differs from its manifest checksum (edited since export)`,
      );
    }
  }
  for (const name of files.keys()) {
    if (!declared.has(name)) {
      warnings.push(`${name} is present but not listed in the manifest`);
    }
  }

  // Category coverage: data present for a category the manifest does not mark
  // as included is silently skipped by the importer — surface it loudly so a
  // hand-added file can't be believed imported when it never was.
  const presentCategories = new Set<string>();
  for (const name of files.keys()) {
    const seg = name.split("/")[0];
    // Unreachable: `String.prototype.split` always returns at least one
    // element, even for an empty string.
    if (seg === undefined) continue;
    if (seg === "media") continue; // media rides with its referencing category
    if ((CONFIG_TRANSFER_CATEGORIES as readonly string[]).includes(seg)) {
      presentCategories.add(seg);
    }
  }
  for (const category of presentCategories) {
    if (!manifest.includedCategories.includes(category as ConfigTransferCategory)) {
      warnings.push(
        `Files exist for category "${category}" but the manifest does not list ` +
          `it in includedCategories — that data will NOT be imported. Reseal ` +
          `the bundle to fix this.`,
      );
    }
  }

  return { manifest, files, warnings };
}

/** Map a zip path to its owning category by layout (media rides with site-content). */
function categoryForPathHeuristic(path: string): ConfigTransferCategory | null {
  const seg = path.split("/")[0];
  if (seg === "media") return "site-content";
  return CONFIG_TRANSFER_CATEGORIES.find((c) => c === seg) ?? null;
}

/** True when any lodge.json in the bundle carries a doorCode key. */
function bundleCarriesDoorCodes(files: Map<string, Uint8Array>): boolean {
  for (const [path, bytes] of files) {
    if (!/^lodge-config\/lodges\/[^/]+\/lodge\.json$/.test(path)) continue;
    try {
      const parsed = JSON.parse(strFromU8(bytes)) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && "doorCode" in parsed) {
        return true;
      }
    } catch {
      // Unreadable lodge.json is the planner's problem; not a door-code signal.
    }
  }
  return false;
}

/**
 * Regenerate a bundle's manifest from the files actually present, so a
 * hand-edited bundle imports without integrity warnings. Recomputes every
 * checksum + row count, re-derives includedCategories from the files, and
 * recomputes doorCodesIncluded from the actual lodge.json contents (a hand-added
 * door code cannot hide behind a stale export-time flag). Categories come from
 * the old manifest's declaration first, falling back to the path layout; files
 * that fit neither are reported together in one actionable error.
 */
export function resealBundle(zipBytes: Uint8Array): Uint8Array {
  const { manifest, files } = readBundle(zipBytes);
  const declaredCategory = new Map(
    manifest.files.map((f) => [f.path, f.category]),
  );
  const entries: BundleEntry[] = [];
  const unmappable: string[] = [];
  for (const [path, bytes] of files) {
    const category =
      declaredCategory.get(path) ?? categoryForPathHeuristic(path);
    if (!category) {
      unmappable.push(path);
      continue;
    }
    entries.push({
      path,
      category,
      rowCount: path.endsWith(".csv")
        ? parseCsv(strFromU8(bytes)).rows.length
        : null,
      bytes,
    });
  }
  if (unmappable.length > 0) {
    throw new ConfigTransferBundleError(
      `Cannot reseal: ${unmappable.length} file(s) belong to no category — ` +
        `${unmappable.join(", ")}. Remove them from the zip, or move each ` +
        `into a category folder, then reseal again.`,
    );
  }
  return buildBundle({
    entries,
    appVersion: manifest.app.version,
    prismaMigration: manifest.app.prismaMigration,
    includedCategories: [...new Set(entries.map((e) => e.category))],
    doorCodesIncluded: bundleCarriesDoorCodes(files),
    generatedAt: manifest.generatedAt,
  });
}
