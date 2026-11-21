import {
  MAX_MEDIA_IMAGE_BYTES,
  detectImageContentType,
  extractImageDimensions,
  cleanImageForStorage,
  sanitiseMediaImageFilename,
} from "@/lib/media-image";
import type {
  CategoryPlanResult,
  PlanItem,
  ReadDb,
  TxDb,
} from "./import-types";

// Shared media handling for import: PLAN the bundled MediaImage recreation
// (validating the map + every image against the same caps the image library
// enforces, and disclosing create-vs-reuse per image) and APPLY it once,
// building an old-id → new-id map so every category whose content embeds
// /api/images/<id> (site content, lodge instructions) can remap references
// consistently. See ADR-001/ADR-002.

const MEDIA_MAP_FILE = "media/media-map.json";

// Bytes to store for a bundled image: EXIF/XMP/comment metadata removed by the
// shared fail-closed helper (`cleanImageForStorage`, src/lib/media-image.ts).
//
// A recreated bundle image is an anonymously-served MediaImage — /api/images/[id]
// serves it with `public, max-age=31536000, immutable`, exactly the same footing
// as an admin image-library upload — so an uncleaned phone photo in someone's
// configuration bundle would publish its GPS coordinates effectively forever.
// An image that cannot be confirmed clean is a plan ERROR naming the file, so
// the restore stops at its dry run (#5244); resolve reports it as not carried
// and apply skips it, like the size-cap error beside it.
//
// Applied identically by the two plan helpers and by apply below, so the
// create-vs-reuse dedup — which compares filename + kind + byteSize + stored
// bytes — classifies the same way in all three.

/** Categories whose content can reference bundled images. */
const IMAGE_REFERENCING_CATEGORIES = ["site-content", "lodge-config"] as const;

/** True when the selection includes a category that can reference media. */
export function mediaApplies(selectedCategories: readonly string[]): boolean {
  return IMAGE_REFERENCING_CATEGORIES.some((c) =>
    selectedCategories.includes(c),
  );
}

/** Rewrite /api/images/<oldId> references to the remapped new ids. */
export function remapImageRefs(
  html: string,
  oldToNew: Map<string, string>,
): string {
  return html.replace(
    /\/api\/images\/([A-Za-z0-9_-]+)/g,
    (whole, id: string) => {
      const next = oldToNew.get(id);
      return next ? `/api/images/${next}` : whole;
    },
  );
}

type MediaMapEntry = {
  path: string;
  filename: string;
  contentType: string;
  /**
   * MediaImage.kind (#2322). Optional: bundles exported before club logos had
   * their own kind carry no value, and those images are content-picker images,
   * so CONTENT is the correct default. Any unrecognised value also falls back to
   * CONTENT — an import must never mint a kind this app does not know.
   */
  kind?: string;
};

/** MediaImage kinds a bundle is allowed to recreate. MEMBER_PHOTO is private
 * data and never travels in a config bundle. */
const IMPORTABLE_MEDIA_KINDS = new Set(["CONTENT", "LOGO"]);

function mediaKindFrom(value: string | undefined): "CONTENT" | "LOGO" {
  return value && IMPORTABLE_MEDIA_KINDS.has(value)
    ? (value as "CONTENT" | "LOGO")
    : "CONTENT";
}

type ParsedMediaMap =
  | { ok: true; entries: Array<[string, MediaMapEntry]> }
  | { ok: false; error: string };

/**
 * Parse + shape-validate media-map.json. Used by BOTH plan and apply so a
 * malformed map fails the dry-run (as an error that blocks apply) instead of
 * throwing mid-transaction after the backup ran.
 */
function parseMediaMap(mapBytes: Uint8Array): ParsedMediaMap {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(mapBytes));
  } catch (error) {
    return {
      ok: false,
      error: `media/media-map.json is not valid JSON (${
        error instanceof Error ? error.message : "parse error"
      })`,
    };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return {
      ok: false,
      error: "media/media-map.json must be an object of id → {path, filename, contentType}",
    };
  }
  const entries: Array<[string, MediaMapEntry]> = [];
  for (const [oldId, value] of Object.entries(json as Record<string, unknown>)) {
    const meta = value as Partial<MediaMapEntry> | null;
    if (
      !meta ||
      typeof meta !== "object" ||
      typeof meta.path !== "string" ||
      typeof meta.filename !== "string" ||
      typeof meta.contentType !== "string"
    ) {
      return {
        ok: false,
        error: `media/media-map.json entry "${oldId}" must have string path/filename/contentType`,
      };
    }
    entries.push([oldId, meta as MediaMapEntry]);
  }
  return { ok: true, entries };
}

/**
 * The MediaImage ids a bundle actually carries bytes for. Used by category
 * planners that reference an image by id outside page HTML (#2322: the club
 * theme's logoUrl) so they can warn when the bundle's reference has no bytes
 * behind it. Returns an empty set for a missing or malformed map — the planner
 * treats "not carried" as the safe reading, and a malformed map is reported as
 * an error by planBundleMedia itself.
 */
export function bundleMediaIds(files: Map<string, Uint8Array>): Set<string> {
  const mapBytes = files.get(MEDIA_MAP_FILE);
  if (!mapBytes) return new Set();
  const parsed = parseMediaMap(mapBytes);
  if (!parsed.ok) return new Set();
  return new Set(parsed.entries.map(([oldId]) => oldId));
}

/**
 * Resolve, at PLAN time, what a bundle image id will become at apply time —
 * mirroring `recreateBundleMedia`'s reuse rule byte for byte so the dry-run and
 * the write cannot disagree (#2322, ADR-002 plan/apply parity).
 *
 *  - `carried: false`   — the bundle has no usable bytes for this id, so apply
 *                         will drop the reference.
 *  - `existingId: <id>` — a byte-identical row of the same kind already exists
 *                         and will be reused; apply writes exactly this id.
 *  - `existingId: null` — a fresh row will be minted, so the resulting id is
 *                         unknowable until apply runs.
 */
export async function planBundleMediaTarget(
  db: ReadDb,
  files: Map<string, Uint8Array>,
  oldId: string,
): Promise<{ carried: boolean; existingId: string | null }> {
  const mapBytes = files.get(MEDIA_MAP_FILE);
  if (!mapBytes) return { carried: false, existingId: null };
  const parsed = parseMediaMap(mapBytes);
  if (!parsed.ok) return { carried: false, existingId: null };

  const entry = parsed.entries.find(([id]) => id === oldId)?.[1];
  if (!entry) return { carried: false, existingId: null };

  const bytes = files.get(entry.path);
  if (!bytes) return { carried: false, existingId: null };
  const buffer = Buffer.from(bytes);
  if (buffer.length > MAX_MEDIA_IMAGE_BYTES) {
    return { carried: false, existingId: null };
  }
  const detected = detectImageContentType(buffer);
  if (!detected) return { carried: false, existingId: null };

  // Resolve against the bytes apply will actually store (metadata removed), so
  // this id prediction cannot disagree with the write.
  const cleaned = cleanImageForStorage(buffer, detected);
  if (!cleaned.ok) return { carried: false, existingId: null };
  const storable = cleaned.bytes;
  const candidates = await db.mediaImage.findMany({
    where: {
      filename: sanitiseMediaImageFilename(entry.filename),
      byteSize: storable.length,
      kind: mediaKindFrom(entry.kind),
    },
    select: { id: true, data: true },
  });
  const existing = candidates.find((c) => Buffer.from(c.data).equals(storable));
  return { carried: true, existingId: existing?.id ?? null };
}

/**
 * Validate + classify the bundle's media for the dry-run: map shape, per-image
 * size cap (the same MAX_MEDIA_IMAGE_BYTES every upload path enforces), and
 * image-type sniffing are ERRORS that block apply; each accepted image is
 * disclosed as a create/unchanged plan item (unchanged = an identical image
 * already exists and will be reused).
 */
export async function planBundleMedia(
  db: ReadDb,
  files: Map<string, Uint8Array>,
): Promise<CategoryPlanResult> {
  const items: PlanItem[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const mapBytes = files.get(MEDIA_MAP_FILE);
  if (!mapBytes) return { items, warnings, errors, fingerprintParts: [] };

  const parsed = parseMediaMap(mapBytes);
  if (!parsed.ok) {
    return { items, warnings, errors: [parsed.error], fingerprintParts: [] };
  }

  for (const [oldId, meta] of parsed.entries) {
    const bytes = files.get(meta.path);
    if (!bytes) {
      errors.push(
        `media/media-map.json: entry "${oldId}" references missing file ${meta.path}`,
      );
      continue;
    }
    const buffer = Buffer.from(bytes);
    if (buffer.length > MAX_MEDIA_IMAGE_BYTES) {
      errors.push(
        `${meta.path} is ${buffer.length} bytes — over the ${MAX_MEDIA_IMAGE_BYTES}-byte image limit`,
      );
      continue;
    }
    const detected = detectImageContentType(buffer);
    if (!detected) {
      errors.push(`${meta.path} is not a recognised image format`);
      continue;
    }
    const filename = sanitiseMediaImageFilename(meta.filename);
    // Classify against the bytes apply will actually store (metadata removed),
    // so the disclosed create/unchanged plan matches the write.
    const cleaned = cleanImageForStorage(buffer, detected);
    if (!cleaned.ok) {
      errors.push(`${meta.path}: ${cleaned.message}`);
      continue;
    }
    const storable = cleaned.bytes;
    const candidates = await db.mediaImage.findMany({
      // Kind-scoped identically to the apply-side reuse lookup (#2322): without
      // this the dry-run could match a LOGO onto an existing CONTENT row and
      // report "unchanged" where apply goes on to create.
      where: {
        filename,
        byteSize: storable.length,
        kind: mediaKindFrom(meta.kind),
      },
      select: { id: true, data: true },
    });
    const existing = candidates.find((c) => Buffer.from(c.data).equals(storable));
    items.push({
      entity: "media-image",
      key: filename,
      action: existing ? "unchanged" : "create",
    });
  }
  return { items, warnings, errors, fingerprintParts: [] };
}

/**
 * Recreate the bundle's images (reusing an identical existing image by
 * filename+bytes for idempotency) and return the old-id → new-id map. The same
 * validations as planBundleMedia apply defensively (rows the plan flagged as
 * errors never reach here — errors block apply — so failures are skips, not
 * throws).
 */
export async function recreateBundleMedia(
  tx: TxDb,
  files: Map<string, Uint8Array>,
  actorMemberId: string,
): Promise<Map<string, string>> {
  const oldToNew = new Map<string, string>();
  const mapBytes = files.get(MEDIA_MAP_FILE);
  if (!mapBytes) return oldToNew;

  const parsed = parseMediaMap(mapBytes);
  if (!parsed.ok) return oldToNew; // plan blocked this; defensive no-op

  for (const [oldId, meta] of parsed.entries) {
    const bytes = files.get(meta.path);
    if (!bytes) continue;
    const buffer = Buffer.from(bytes);
    if (buffer.length > MAX_MEDIA_IMAGE_BYTES) continue; // plan blocked
    const detected = detectImageContentType(buffer);
    if (!detected) continue; // untrusted: skip non-images
    const filename = sanitiseMediaImageFilename(meta.filename);
    const cleaned = cleanImageForStorage(buffer, detected);
    if (!cleaned.ok) continue; // plan blocked
    const storable = cleaned.bytes;

    const candidates = await tx.mediaImage.findMany({
      where: {
        filename,
        byteSize: storable.length,
        // Reuse only within the same kind (#2322): matching a LOGO onto an
        // existing CONTENT row (or the reverse) would hand the theme a blob
        // whose lifecycle it does not own, or expose a picker image to the
        // logo's delete-on-replace.
        kind: mediaKindFrom(meta.kind),
      },
      select: { id: true, data: true },
    });
    const existing = candidates.find((c) => Buffer.from(c.data).equals(storable));
    if (existing) {
      oldToNew.set(oldId, existing.id);
      continue;
    }

    const dims = extractImageDimensions(storable, detected);
    const created = await tx.mediaImage.create({
      data: {
        filename,
        contentType: detected,
        byteSize: storable.length,
        data: new Uint8Array(storable),
        width: dims?.width ?? null,
        height: dims?.height ?? null,
        uploadedByMemberId: actorMemberId,
        kind: mediaKindFrom(meta.kind),
      },
      select: { id: true },
    });
    oldToNew.set(oldId, created.id);
  }
  return oldToNew;
}
