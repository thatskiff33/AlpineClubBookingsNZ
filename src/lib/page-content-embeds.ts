import "server-only";

import fs from "fs/promises";
import path from "path";
import {
  ALLOWED_IMAGE_EXTS,
  IMAGE_DERIVATIVES_DIRECTORY,
  imageContentTypeForExt,
  imagePublicUrl,
  listImageDerivatives,
  resolveAlbumPathInImagesRoot,
  type ImageDerivative,
} from "@/lib/image-storage";
import { getClubIdentity } from "@/lib/club-identity-settings";
import {
  getDefaultLodgeCapacity,
  getLodgeCapacity,
} from "@/lib/lodge-capacity";
import logger from "@/lib/logger";
import { deriveAltFromImageSrc } from "@/lib/image-alt";
import { extractImageDimensions } from "@/lib/media-image";
import {
  embedTokenNames,
  legacySingleBraceTokenNames,
  parameterisedTextTokenNames,
  plainTextTokenNames,
} from "@/lib/token-catalogue";
import {
  loadPublicAnnualFees,
  loadPublicBookingPolicy,
  loadPublicCancellationPolicy,
  loadPublicHutFees,
  loadPublicJoiningFees,
  type PublicBookingPolicy,
  type PublicCancellationPolicy,
  type PublicFeeGroup,
  type PublicFeeTable,
} from "@/lib/public-page-content-tokens";
import { loadPublicFirstYearCosts } from "@/lib/public-first-year-costs";
import { resolveFeeTokenParameters } from "@/lib/token-parameters";
import { clubFormatValues } from "@/lib/club-format-server";
import type { ClubFormat } from "@/lib/club-format";
import { escapeRegExp } from "@/lib/escape-regexp";

export type PhotoGalleryImageCopy = {
  src: string;
  width: number;
  height: number;
};

export type PhotoGalleryImage = {
  src: string;
  alt: string;
  width: number | null;
  height: number | null;
  /**
   * Website-sized WebP copies of an Image Manager photo (#4935,
   * INV-PUB-004), narrowest first. Absent for inline page images and for a
   * photo with no current copies (uploaded before copies existed and not yet
   * backfilled, too narrow, or a GIF/AVIF) — which then renders as the
   * original exactly as before.
   */
  copies?: PhotoGalleryImageCopy[];
};

export type EmbeddedBodyPart =
  | { type: "html"; value: string }
  | { type: "committee" }
  | { type: "member-application-form" }
  | { type: "contact-form" }
  | { type: "booking-requests" }
  | { type: "school-bookings" }
  | { type: "skifield-conditions"; dataHash?: string }
  | { type: "skifield-whakapapa" }
  | { type: "photo-gallery"; images: PhotoGalleryImage[] }
  | { type: "photo-slideshow"; images: PhotoGalleryImage[] }
  // Fee embeds (#1933, E7). {{membership-types}} is a deprecated alias of
  // {{annual-fees}} and {{entrance-fees}} of {{joining-fees}} — the aliases
  // resolve to the same part/renderer. Joining and annual fees share the
  // grouped definition-list view model; hut fees carry the tabular
  // membership-type x age-tier view model instead (#2129).
  | { type: "hut-fees"; tables: PublicFeeTable[] }
  | { type: "joining-fees"; groups: PublicFeeGroup[] }
  | { type: "annual-fees"; groups: PublicFeeGroup[] }
  // #4295: joining fee + first-year subscription per membership type and tier;
  // same grouped view model, so it shares the fee-group renderer.
  | { type: "first-year-costs"; groups: PublicFeeGroup[] }
  | { type: "booking-policy-summary"; policy: PublicBookingPolicy | null }
  | { type: "cancellation-policy"; policy: PublicCancellationPolicy | null };

type ParsedEmbedToken = {
  token: string;
  parameter: string | undefined;
};

// Both matchers are derived from src/lib/token-catalogue.ts (single source of
// truth) and built once at module load. Matching behaviour is unchanged from
// the previous hardcoded regexes: case-insensitive, whitespace tolerant,
// double braces with an optional `:parameter`, and the legacy single-brace
// form only for legacy-enabled embed tokens (photo tokens excluded).
const EMBED_TOKEN_ALTERNATION = embedTokenNames().map(escapeRegExp).join("|");
const LEGACY_TOKEN_ALTERNATION = legacySingleBraceTokenNames()
  .map(escapeRegExp)
  .join("|");
const PARAM_TEXT_TOKEN_ALTERNATION = parameterisedTextTokenNames()
  .map(escapeRegExp)
  .join("|");
const PLAIN_TEXT_TOKEN_ALTERNATION = plainTextTokenNames()
  .map(escapeRegExp)
  .join("|");

// test seam
export const EMBED_TOKEN_REGEX = new RegExp(
  `\\{\\{\\s*(${EMBED_TOKEN_ALTERNATION})(?:\\s*:\\s*([^{}]+?))?\\s*\\}\\}` +
    `|\\{\\s*(${LEGACY_TOKEN_ALTERNATION})(?:\\s*:\\s*([^{}]+?))?\\s*\\}`,
  "gi",
);
// Text tokens match bare, except those whose catalogue entry declares
// parameter support (allowsParameter — the multi-lodge
// {{lodge-capacity:lodge-slug}} form). Group 1/2 = parameterised token and
// its optional parameter; group 3 = plain token.
// test seam
export const TEXT_TOKEN_REGEX = new RegExp(
  `\\{\\{\\s*(?:(${PARAM_TEXT_TOKEN_ALTERNATION})(?:\\s*:\\s*([^{}]+?))?|(${PLAIN_TEXT_TOKEN_ALTERNATION}))\\s*\\}\\}`,
  "gi",
);

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * {{lodge-capacity}} resolves the default lodge's capacity (the pre-
 * multi-lodge behaviour); {{lodge-capacity:lodge-slug}} resolves the named
 * lodge's capacity so multi-lodge pages can state each property's size.
 * An unknown slug falls back to the default lodge rather than rendering
 * a broken page.
 */
async function resolveLodgeCapacityToken(
  parameter: string | undefined,
): Promise<number> {
  if (parameter) {
    try {
      const { prisma } = await import("@/lib/prisma");
      const lodge = await prisma.lodge.findUnique({
        where: { slug: parameter },
        select: { id: true },
      });
      if (lodge) {
        return await getLodgeCapacity(lodge.id);
      }
    } catch {
      // fall through to the default lodge
    }
  }
  return getDefaultLodgeCapacity();
}

type LodgeIdentityTokenValue = { name: string; address: string };

/**
 * {{lodge-name}} / {{lodge-address}} resolve the default lodge's name/address;
 * {{lodge-name:lodge-slug}} etc. resolve the named lodge. An unknown slug falls
 * back to the default lodge (mirrors {{lodge-capacity}}); a lodge with no
 * address renders "". Both tokens share this single lookup per slug.
 */
async function resolveLodgeIdentityToken(
  parameter: string | undefined,
): Promise<LodgeIdentityTokenValue> {
  const { prisma } = await import("@/lib/prisma");
  const { getDefaultLodgeId } = await import("@/lib/lodges");
  try {
    if (parameter) {
      const lodge = await prisma.lodge.findUnique({
        where: { slug: parameter },
        select: { name: true, address: true },
      });
      if (lodge) return { name: lodge.name, address: lodge.address ?? "" };
    }
    const defaultLodgeId = await getDefaultLodgeId(prisma);
    const lodge = await prisma.lodge.findUnique({
      where: { id: defaultLodgeId },
      select: { name: true, address: true },
    });
    return { name: lodge?.name ?? "", address: lodge?.address ?? "" };
  } catch {
    return { name: "", address: "" };
  }
}

// URL schemes a token value may safely carry into an href attribute. Mirrors
// allowedSchemes in page-content-html.ts, whose sanitiser cannot vet token
// values because tokens resolve after sanitisation.
const SAFE_TOKEN_URL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

function isSafeTokenUrl(value: string): boolean {
  try {
    return SAFE_TOKEN_URL_SCHEMES.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

// Warn once per offending config value so a bad deploy shows up in the logs
// without repeating on every render.
const warnedUnsafeTokenUrls = new Set<string>();

// Authors place URL tokens inside href attributes (the starter footer uses
// <a href="{{facebook-url}}">), and because resolution runs after
// sanitisation the sanitiser's scheme allowlist never sees the resolved
// value. HTML-escaping does not neutralise a dangerous URL scheme, so
// enforce the same http/https/mailto allowlist here before injection.
//
// `fallbackUrl` (C6 #1985): when a token value carries a disallowed scheme we
// substitute a safe URL. The caller passes the DB-first resolved public URL
// (getClubIdentity().publicUrl, itself the NEXTAUTH_URL/safe-default bootstrap
// origin) rather than a static config constant, so the fallback tracks the
// resolved identity; "#" is the last resort if even that is unsafe.
function safeTokenUrl(token: string, value: string, fallbackUrl: string): string {
  if (isSafeTokenUrl(value)) {
    return value;
  }
  if (!warnedUnsafeTokenUrls.has(value)) {
    warnedUnsafeTokenUrls.add(value);
    logger.warn(
      { token },
      "Blocked text-token config value with a disallowed URL scheme; only http, https, and mailto URLs are rendered.",
    );
  }
  return isSafeTokenUrl(fallbackUrl) ? fallbackUrl : "#";
}

// Exported for reuse by other sanitised HTML surfaces (lodge instructions).
// Replacement values are HTML-escaped via escapeHtmlText and URL-bearing
// tokens are additionally scheme-validated via safeTokenUrl, so this stays
// safe to run after sanitisation.
export async function resolveTextTokens(
  contentHtml: string,
  /**
   * The club's STORED format (#3565), resolved ONCE by the caller. A parameter
   * rather than a read of its own: in a route handler `cache()` does not memoise,
   * so a read here cost one query per call — three per lodge-instructions
   * request, one per key — and `buildEmbeddedBody` already holds it.
   */
  format: ClubFormat,
): Promise<string> {
  TEXT_TOKEN_REGEX.lastIndex = 0;
  const matches = Array.from(contentHtml.matchAll(TEXT_TOKEN_REGEX));
  if (matches.length === 0) {
    return contentHtml;
  }

  // `{{currency}}` renders the club's STORED code (#3565), the one the fee
  // tables on the same page render in, never the environment's.

  // Pre-resolve each distinct lodge-capacity parameter (the replace
  // callback below is synchronous).
  const capacityParams = new Set(
    matches
      .filter((match) => (match[1] ?? "").toLowerCase() === "lodge-capacity")
      .map((match) => (match[2] ?? "").trim().toLowerCase()),
  );
  const capacityByParam = new Map<string, number>();
  for (const param of capacityParams) {
    capacityByParam.set(
      param,
      await resolveLodgeCapacityToken(param || undefined),
    );
  }

  // Pre-resolve each distinct lodge-name / lodge-address slug parameter (E3
  // #1929). Both tokens share one lookup per slug; the empty-string key is the
  // default lodge.
  const lodgeIdentityParams = new Set(
    matches
      .filter((match) => {
        const token = (match[1] ?? "").toLowerCase();
        return token === "lodge-name" || token === "lodge-address";
      })
      .map((match) => (match[2] ?? "").trim().toLowerCase()),
  );
  const lodgeIdentityByParam = new Map<string, LodgeIdentityTokenValue>();
  for (const param of lodgeIdentityParams) {
    lodgeIdentityByParam.set(
      param,
      await resolveLodgeIdentityToken(param || undefined),
    );
  }

  // DB-first club identity (E3 #1929): pre-resolve once (the replace callback is
  // synchronous) so {{club-name}}/{{hut-leader}} render the admin-editable values.
  const clubIdentity = await getClubIdentity();

  return contentHtml.replace(
    TEXT_TOKEN_REGEX,
    (_match, paramToken: string | undefined, parameter: string | undefined, plainToken: string | undefined) => {
      const token = paramToken ?? plainToken ?? "";
      switch (token.toLowerCase()) {
        case "lodge-capacity": {
          const value = capacityByParam.get(
            (parameter ?? "").trim().toLowerCase(),
          );
          return escapeHtmlText(String(value ?? ""));
        }
        case "lodge-name": {
          const value = lodgeIdentityByParam.get(
            (parameter ?? "").trim().toLowerCase(),
          );
          return escapeHtmlText(value?.name ?? "");
        }
        case "lodge-address": {
          const value = lodgeIdentityByParam.get(
            (parameter ?? "").trim().toLowerCase(),
          );
          return escapeHtmlText(value?.address ?? "");
        }
        case "club-name":
          return escapeHtmlText(clubIdentity.name);
        case "hut-leader":
          return escapeHtmlText(clubIdentity.hutLeaderLabel);
        case "hut-leader-lower":
          return escapeHtmlText(clubIdentity.hutLeaderLabel.toLowerCase());
        case "currency":
          return escapeHtmlText(format.currencyCode);
        case "facebook-url":
          // Escaping keeps the value safe as visible text and attribute
          // content, but not as an href target: a javascript: scheme survives
          // HTML-escaping, so safeTokenUrl vets the scheme first.
          return escapeHtmlText(
            safeTokenUrl(
              "facebook-url",
              // DB-first (C5 #1984): the admin-editable facebookUrl resolved via
              // getClubIdentity() wins over the static config constant, matching
              // {{club-name}}/{{hut-leader}} above. Falls back to the resolved
              // public URL (C6 #1985 — the bootstrap origin, never club.json)
              // when no link is configured.
              clubIdentity.socialLinks?.facebook ?? clubIdentity.publicUrl,
              clubIdentity.publicUrl,
            ),
          );
        default:
          return "";
      }
    },
  );
}

function parseTokenMatch(match: RegExpMatchArray): ParsedEmbedToken {
  return {
    token: (match[1] ?? match[3] ?? "").toLowerCase(),
    parameter: (match[2] ?? match[4] ?? "").trim() || undefined,
  };
}

// deriveAltFromImageSrc lives in @/lib/image-alt (a pure, dependency-free
// module) so the HTML sanitiser can share it without importing this module's
// server-only graph. Re-exported here for existing importers/tests.
export { deriveAltFromImageSrc };

function extractInlinePhotoGalleryImages(contentHtml: string): {
  cleanedHtml: string;
  images: PhotoGalleryImage[];
} {
  const images: PhotoGalleryImage[] = [];
  const cleanedHtml = contentHtml.replace(
    /<img\b[^>]*src=["']([^"']+)["'][^>]*>/gi,
    (match, src: string) => {
      const altMatch = match.match(/alt=["']([^"']*)["']/i);
      const widthMatch = match.match(/width=["']?(\d+)["']?/i);
      const heightMatch = match.match(/height=["']?(\d+)["']?/i);
      // Data layer: preserve a present-but-empty alt="" as the author's
      // explicit decorative marker, and backfill only a wholly missing alt
      // from the filename (#1947). NOTE: for gallery/slideshow images the
      // render layer (photo-gallery-token.tsx) deliberately does NOT honour an
      // empty alt as decorative — each image there is a link's only content, so
      // an empty alt would be an unnamed link (WCAG 2.4.4/4.1.2). It replaces
      // the empty string with a positional accessible name. The two layers are
      // reconciled on purpose: the data layer stays faithful to author intent;
      // the render layer enforces the stricter linked-image accessible-name rule.
      // Both capture groups above are mandatory (no `?` quantifier), so a
      // present match always carries one; `?.[1] ?? …` / `?.[1] ? … : null`
      // preserve the exact truthy/empty-string behaviour these already had.
      const alt = altMatch?.[1] ?? deriveAltFromImageSrc(src);
      images.push({
        src,
        alt,
        width: widthMatch?.[1] ? Number.parseInt(widthMatch[1], 10) : null,
        height: heightMatch?.[1] ? Number.parseInt(heightMatch[1], 10) : null,
      });
      return "";
    },
  );

  return { cleanedHtml, images };
}

function normaliseGalleryDirectoryInput(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/^public\/images\/?/i, "")
    .replace(/^images\/?/i, "")
    .replace(/\/+$/g, "");
}

// Every format's dimensions sit in its header: a JPEG's frame header follows
// its metadata segments, at most a few tens of KB into a stripped file. This
// bounds what a gallery render reads per photo (#4935), where it used to read
// every original whole. Only a JPEG can push its frame header later — one
// uploaded before metadata stripping, whose EXIF segment alone may approach
// 64 KB — so a JPEG not resolved in the first read gets one wider read.
const IMAGE_HEADER_READ_BYTES = 64 * 1024;
const JPEG_HEADER_RETRY_READ_BYTES = 1024 * 1024;

async function readImageFileDimensions(absPath: string) {
  const contentType = imageContentTypeForExt(
    path.extname(absPath).toLowerCase(),
  );
  if (!contentType) return null;
  let handle;
  try {
    const opened = await fs.open(absPath, "r");
    handle = opened;
    const readHeader = async (length: number) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await opened.read(buffer, 0, length, 0);
      return {
        dimensions: extractImageDimensions(
          buffer.subarray(0, bytesRead),
          contentType,
        ),
        filled: bytesRead === length,
      };
    };
    const first = await readHeader(IMAGE_HEADER_READ_BYTES);
    if (first.dimensions || !first.filled || contentType !== "image/jpeg") {
      return first.dimensions;
    }
    return (await readHeader(JPEG_HEADER_RETRY_READ_BYTES)).dimensions;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/**
 * The copies of one photo a gallery may use: only those at least as new as
 * the original. A copy older than its original belongs to an earlier file of
 * the same name — replaced by code that predates copies, during a blue/green
 * cutover or after a rollback — and serving it would show the old photo.
 */
async function currentGalleryCopies(
  absDir: string,
  originalPath: string,
  derivatives: ImageDerivative[],
): Promise<PhotoGalleryImageCopy[]> {
  if (derivatives.length === 0) return [];
  let originalMtimeMs: number;
  try {
    originalMtimeMs = (await fs.stat(originalPath)).mtimeMs;
  } catch {
    return [];
  }
  const copies: PhotoGalleryImageCopy[] = [];
  for (const derivative of derivatives) {
    if (derivative.mtimeMs < originalMtimeMs) continue;
    const copyPath = path.join(
      absDir,
      IMAGE_DERIVATIVES_DIRECTORY,
      derivative.fileName,
    );
    const dimensions = await readImageFileDimensions(copyPath);
    if (!dimensions) continue;
    copies.push({ src: imagePublicUrl(copyPath), ...dimensions });
  }
  return copies;
}

async function listPhotoGalleryImagesFromDirectory(
  directoryInput: string,
  format: ClubFormat,
): Promise<PhotoGalleryImage[]> {
  const relDir = normaliseGalleryDirectoryInput(directoryInput);
  // A copies folder is never an album: its files are copies of photos listed
  // with their originals, not photos of their own.
  const absDir = resolveAlbumPathInImagesRoot(relDir);
  if (!absDir) {
    return [];
  }

  let entries;
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = entries.filter(
    (entry) =>
      entry.isFile() &&
      ALLOWED_IMAGE_EXTS.has(path.extname(entry.name).toLowerCase()),
  );

  const derivatives = await listImageDerivatives(absDir);
  const images = await Promise.all(
    files.map(async (entry) => {
      // absDir is resolveInImagesRoot-contained; entry.name comes from readdir
      // of that directory (filtered to allowed image extensions), not input.
      const filePath = path.join(absDir, entry.name);
      const dimensions = await readImageFileDimensions(filePath);
      const copies = await currentGalleryCopies(
        absDir,
        filePath,
        derivatives.get(entry.name) ?? [],
      );

      return {
        src: imagePublicUrl(filePath),
        alt: entry.name,
        width: dimensions?.width ?? 1200,
        height: dimensions?.height ?? 900,
        ...(copies.length > 0 ? { copies } : {}),
      } satisfies PhotoGalleryImage;
    }),
  );

  // Alphabetical in the CLUB's language (#3566, owner decision 6), not a
  // hard-coded New Zealand English collation.
  images.sort((a, b) => a.alt.localeCompare(b.alt, format.locale));
  return images;
}

async function resolveGalleryImages(
  parameter: string | undefined,
  inlineImages: PhotoGalleryImage[],
  useInlineFallback: boolean,
  format: ClubFormat,
): Promise<PhotoGalleryImage[]> {
  if (parameter) {
    return listPhotoGalleryImagesFromDirectory(parameter, format);
  }

  return useInlineFallback ? inlineImages : [];
}

export async function buildEmbeddedBody(contentHtml: string) {
  // The club's format (#3565), resolved once per render pass and shared with
  // the page through `cache()`; every fee token below renders with it.
  const format = await clubFormatValues();
  const htmlWithTextTokens = await resolveTextTokens(contentHtml, format);
  const matches = Array.from(htmlWithTextTokens.matchAll(EMBED_TOKEN_REGEX));
  const hasInlineGalleryToken = matches.some((match) => {
    const parsed = parseTokenMatch(match);
    return (
      (parsed.token === "photo-gallery" ||
        parsed.token === "photo-slideshow") &&
      !parsed.parameter
    );
  });

  const { cleanedHtml, images: inlineImages } = hasInlineGalleryToken
    ? extractInlinePhotoGalleryImages(htmlWithTextTokens)
    : { cleanedHtml: htmlWithTextTokens, images: [] as PhotoGalleryImage[] };

  const parts: EmbeddedBodyPart[] = [];
  let lastIndex = 0;

  for (const match of cleanedHtml.matchAll(EMBED_TOKEN_REGEX)) {
    const startIndex = match.index ?? 0;
    const before = cleanedHtml.slice(lastIndex, startIndex);
    if (before.trim().length > 0) {
      parts.push({ type: "html", value: before });
    }

    const parsed = parseTokenMatch(match);
    if (parsed.token === "committee-members-cards") {
      parts.push({ type: "committee" });
    } else if (
      parsed.token === "member-application-form" ||
      parsed.token === "join-apply-form"
    ) {
      parts.push({ type: "member-application-form" });
    } else if (parsed.token === "skifield-conditions") {
      parts.push({ type: "skifield-conditions", dataHash: parsed.parameter });
    } else if (parsed.token === "skifield-whakapapa") {
      parts.push({ type: "skifield-whakapapa" });
    } else if (parsed.token === "photo-gallery") {
      parts.push({
        type: "photo-gallery",
        images: await resolveGalleryImages(
          parsed.parameter,
          inlineImages,
          hasInlineGalleryToken,
          format,
        ),
      });
    } else if (parsed.token === "photo-slideshow") {
      parts.push({
        type: "photo-slideshow",
        images: await resolveGalleryImages(
          parsed.parameter,
          inlineImages,
          hasInlineGalleryToken,
          format,
        ),
      });
    } else if (parsed.token === "annual-fees" || parsed.token === "membership-types") {
      // {{membership-types}} is a deprecated alias of {{annual-fees}}.
      const feeParams = resolveFeeTokenParameters(parsed.parameter);
      parts.push({ type: "annual-fees", groups: await loadPublicAnnualFees(format, { typeKey: feeParams.type, components: feeParams.components }) });
    } else if (parsed.token === "first-year-costs") {
      const feeParams = resolveFeeTokenParameters(parsed.parameter);
      parts.push({ type: "first-year-costs", groups: await loadPublicFirstYearCosts(format, { typeKey: feeParams.type }) });
    } else if (parsed.token === "joining-fees" || parsed.token === "entrance-fees") {
      // {{entrance-fees}} is a deprecated alias of {{joining-fees}}.
      const feeParams = resolveFeeTokenParameters(parsed.parameter);
      parts.push({ type: "joining-fees", groups: await loadPublicJoiningFees(format, { typeKey: feeParams.type, byAge: feeParams.groupBy.has("age") }) });
    } else if (parsed.token === "hut-fees") {
      const feeParams = resolveFeeTokenParameters(parsed.parameter);
      parts.push({ type: "hut-fees", tables: await loadPublicHutFees(format, feeParams.lodge, { typeKey: feeParams.type, groupBy: feeParams.groupBy }) });
    } else if (parsed.token === "booking-policy-summary") {
      parts.push({ type: "booking-policy-summary", policy: await loadPublicBookingPolicy(format, parsed.parameter) });
    } else if (parsed.token === "cancellation-policy") {
      parts.push({ type: "cancellation-policy", policy: await loadPublicCancellationPolicy(format, parsed.parameter) });
    } else if (parsed.token === "contact-form") {
      parts.push({ type: "contact-form" });
    } else if (parsed.token === "booking-requests") {
      parts.push({ type: "booking-requests" });
    } else if (parsed.token === "school-bookings") {
      parts.push({ type: "school-bookings" });
    } else {
      // Catalogue and renderer should evolve together. If they drift, retain
      // the already-sanitised literal instead of accidentally rendering a
      // privileged or interactive component.
      parts.push({ type: "html", value: match[0] });
    }

    lastIndex = startIndex + match[0].length;
  }

  const trailing = cleanedHtml.slice(lastIndex);
  if (trailing.trim().length > 0) {
    parts.push({ type: "html", value: trailing });
  }

  return parts;
}
