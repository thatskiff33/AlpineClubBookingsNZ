import "server-only";

import fs from "fs/promises";
import path from "path";
import {
  ALLOWED_IMAGE_EXTS,
  imagePublicUrl,
  resolveInImagesRoot,
} from "@/lib/image-storage";
import { getClubIdentity } from "@/lib/club-identity-settings";
import { APP_CURRENCY } from "@/config/operational";
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
import { resolveFeeTokenParameters } from "@/lib/token-parameters";

export type PhotoGalleryImage = {
  src: string;
  alt: string;
  width: number | null;
  height: number | null;
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
  // Three fee embeds (#1933, E7). {{membership-types}} is a deprecated alias of
  // {{annual-fees}} and {{entrance-fees}} of {{joining-fees}} — the aliases
  // resolve to the same part/renderer. Joining and annual fees share the
  // grouped definition-list view model; hut fees carry the tabular
  // membership-type x age-tier view model instead (#2129).
  | { type: "hut-fees"; tables: PublicFeeTable[] }
  | { type: "joining-fees"; groups: PublicFeeGroup[] }
  | { type: "annual-fees"; groups: PublicFeeGroup[] }
  | { type: "booking-policy-summary"; policy: PublicBookingPolicy | null }
  | { type: "cancellation-policy"; policy: PublicCancellationPolicy | null };

type ParsedEmbedToken = {
  token: string;
  parameter: string | undefined;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
export async function resolveTextTokens(contentHtml: string): Promise<string> {
  TEXT_TOKEN_REGEX.lastIndex = 0;
  const matches = Array.from(contentHtml.matchAll(TEXT_TOKEN_REGEX));
  if (matches.length === 0) {
    return contentHtml;
  }

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
          return escapeHtmlText(APP_CURRENCY);
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
      const alt = altMatch ? altMatch[1] : deriveAltFromImageSrc(src);
      images.push({
        src,
        alt,
        width: widthMatch ? Number.parseInt(widthMatch[1], 10) : null,
        height: heightMatch ? Number.parseInt(heightMatch[1], 10) : null,
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

async function listPhotoGalleryImagesFromDirectory(
  directoryInput: string,
): Promise<PhotoGalleryImage[]> {
  const relDir = normaliseGalleryDirectoryInput(directoryInput);
  const absDir = resolveInImagesRoot(relDir);
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

  const images = await Promise.all(
    files.map(async (entry) => {
      // absDir is resolveInImagesRoot-contained; entry.name comes from readdir
      // of that directory (filtered to allowed image extensions), not input.
      const filePath = path.join(absDir, entry.name);
      const bytes = await fs.readFile(filePath);
      const ext = path.extname(entry.name).toLowerCase();
      const contentType =
        ext === ".jpg" || ext === ".jpeg"
          ? "image/jpeg"
          : ext === ".png"
            ? "image/png"
            : ext === ".gif"
              ? "image/gif"
              : ext === ".webp"
                ? "image/webp"
                : ext === ".avif"
                  ? "image/avif"
                  : null;
      const dimensions = contentType
        ? extractImageDimensions(bytes, contentType)
        : null;

      return {
        src: imagePublicUrl(filePath),
        alt: entry.name,
        width: dimensions?.width ?? 1200,
        height: dimensions?.height ?? 900,
      } satisfies PhotoGalleryImage;
    }),
  );

  images.sort((a, b) => a.alt.localeCompare(b.alt, "en-NZ"));
  return images;
}

async function resolveGalleryImages(
  parameter: string | undefined,
  inlineImages: PhotoGalleryImage[],
  useInlineFallback: boolean,
): Promise<PhotoGalleryImage[]> {
  if (parameter) {
    return listPhotoGalleryImagesFromDirectory(parameter);
  }

  return useInlineFallback ? inlineImages : [];
}

export async function buildEmbeddedBody(contentHtml: string) {
  const htmlWithTextTokens = await resolveTextTokens(contentHtml);
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
        ),
      });
    } else if (parsed.token === "photo-slideshow") {
      parts.push({
        type: "photo-slideshow",
        images: await resolveGalleryImages(
          parsed.parameter,
          inlineImages,
          hasInlineGalleryToken,
        ),
      });
    } else if (parsed.token === "annual-fees" || parsed.token === "membership-types") {
      // {{membership-types}} is a deprecated alias of {{annual-fees}}.
      const feeParams = resolveFeeTokenParameters(parsed.parameter);
      parts.push({ type: "annual-fees", groups: await loadPublicAnnualFees({ typeKey: feeParams.type, components: feeParams.components }) });
    } else if (parsed.token === "joining-fees" || parsed.token === "entrance-fees") {
      // {{entrance-fees}} is a deprecated alias of {{joining-fees}}.
      const feeParams = resolveFeeTokenParameters(parsed.parameter);
      parts.push({ type: "joining-fees", groups: await loadPublicJoiningFees({ typeKey: feeParams.type, byAge: feeParams.groupBy.has("age") }) });
    } else if (parsed.token === "hut-fees") {
      const feeParams = resolveFeeTokenParameters(parsed.parameter);
      parts.push({ type: "hut-fees", tables: await loadPublicHutFees(feeParams.lodge, { typeKey: feeParams.type, groupBy: feeParams.groupBy }) });
    } else if (parsed.token === "booking-policy-summary") {
      parts.push({ type: "booking-policy-summary", policy: await loadPublicBookingPolicy(parsed.parameter) });
    } else if (parsed.token === "cancellation-policy") {
      parts.push({ type: "cancellation-policy", policy: await loadPublicCancellationPolicy(parsed.parameter) });
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
