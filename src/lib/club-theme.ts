import { prisma } from "@/lib/prisma";
import {
  buildClubThemeCss,
  buildClubThemeAppCss,
  CLUB_THEME_ID,
  DEFAULT_CLUB_THEME_VALUES,
  getContrastWarnings,
  logoImageIdFromUrl,
  normaliseThemeValues,
  resolveLogoFields,
  type ClubThemeValues,
} from "@/lib/club-theme-schema";
import type { ClubThemeUpdateInput } from "@/lib/club-theme-update-schema";
import { storableLogoDataUrl } from "@/lib/image-metadata";

/** Sentinel distinguishing "the read threw" from "there is no row" (#2420 F4). */
const READ_FAILED = Symbol("club-theme-read-failed");

async function ensureClubTheme() {
  return prisma.clubTheme.upsert({
    where: { id: CLUB_THEME_ID },
    create: {
      id: CLUB_THEME_ID,
      ...DEFAULT_CLUB_THEME_VALUES,
    },
    update: {},
  });
}

export async function getClubThemeForAdmin() {
  const theme = await ensureClubTheme();
  const values = normaliseThemeValues(theme);
  return {
    ...values,
    completedAt: theme.completedAt?.toISOString() ?? null,
    contrastWarnings: getContrastWarnings(values),
  };
}

/**
 * The incoming `logoUrl` points at a MediaImage row that no longer exists —
 * typically a stale admin tab saving a logo a newer save already replaced.
 * Surfaces as a 409 rather than dangling the theme or deleting a live blob.
 */
export class MissingLogoImageError extends Error {
  constructor() {
    super("Referenced logo image no longer exists");
    this.name = "MissingLogoImageError";
  }
}

/**
 * The inline logo could not be confirmed free of hidden details (location,
 * device, owner) and was not saved (#5244). `message` is the plain-English
 * refusal the route shows the admin.
 */
export class UncleanLogoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UncleanLogoError";
  }
}

export async function saveClubTheme(input: ClubThemeUpdateInput) {
  const existing = await prisma.clubTheme.findUnique({
    where: { id: CLUB_THEME_ID },
    select: { completedAt: true, logoDataUrl: true },
  });
  const completedAt = input.completeSetup
    ? (existing?.completedAt ?? new Date())
    : (existing?.completedAt ?? null);

  // #2187: only the three seed columns are written; the four former brand
  // columns (charcoal/ridge/mist/snow surfaces) are dead to code and left to
  // their DB defaults (P4 drops them).
  // #2322: exclusivity is enforced server-side, not trusted from the client, so
  // a stale wizard cannot re-inline a logo already migrated to URL form.
  const logoFields = resolveLogoFields({
    logoUrl: input.logoUrl,
    logoDataUrl: input.logoDataUrl,
  });

  // #2242: the inline logo is image bytes that render on every public page, so
  // it is stripped of EXIF/XMP/comment metadata like every other stored image.
  // New logos normally go through POST /api/admin/site-style/logo (re-encoded by
  // sharp, metadata-free by construction) — this column is the small hand-
  // crafted/legacy escape hatch, and a hand-crafted logo can still be a phone
  // photo carrying GPS. Fail-closed like every image path (#5244): a logo that
  // cannot be confirmed clean is refused and the route shows the message.
  // Stripping only ever shrinks the value, so the route's 64KB write budget and
  // the schema's 900KB read bound both still hold. The logo already stored is
  // not cleaned again: the wizard sends the whole theme back on every save, and
  // stored images are left as they are (#5244), so a legacy logo neither churns
  // nor blocks a colour change.
  const logoUnchanged =
    logoFields.logoDataUrl !== null && logoFields.logoDataUrl === existing?.logoDataUrl;
  const cleanedLogo = logoUnchanged
    ? { ok: true as const, value: logoFields.logoDataUrl }
    : storableLogoDataUrl(logoFields.logoDataUrl);
  if (!cleanedLogo.ok) throw new UncleanLogoError(cleanedLogo.message);
  const storedLogoFields = { ...logoFields, logoDataUrl: cleanedLogo.value };

  const data = {
    brandGold: input.brandGold,
    brandDeep: input.brandDeep,
    brandSafety: input.brandSafety,
    headingFontKey: input.headingFontKey,
    bodyFontKey: input.bodyFontKey,
    ...storedLogoFields,
    rawCss: input.rawCss ?? "",
    completedAt,
  };

  // The write and the previous logo blob's cleanup share one transaction so a
  // replaced logo never orphans its MediaImage row (mirrors the member-photo
  // pattern). No external calls inside the transaction.
  //
  // Explicit timings (#2322): config-transfer apply holds this same ClubTheme
  // row for its whole bundle transaction, so Prisma's defaults (2s maxWait / 5s
  // timeout) would surface a routine concurrent import as a 500. The route maps
  // an exhausted wait to a 503 retry-later instead.
  const theme = await prisma.$transaction(
    async (tx) => {
      // FOR UPDATE locks nothing when the row does not exist, so two first-ever
      // saves would not serialise against each other. Materialise the singleton
      // first (a no-op once it exists), then lock it.
      await tx.clubTheme.createMany({
        data: [{ id: CLUB_THEME_ID, ...data }],
        skipDuplicates: true,
      });

      // Lock the theme row and read its CURRENT logo under that lock, so two
      // concurrent saves serialise instead of both deleting the same stale blob
      // and orphaning the other's new one.
      //
      // Lock raw, read typed (#2289): the raw statement selects a constant and
      // its result is never inspected — it is there for the lock — and the logo
      // comes back through the Prisma model, which owns the column mapping. The
      // value this reads decides which image blob gets DELETED, so an unchecked
      // `$queryRaw<{ logoUrl }>` cast would put a live logo one rename away from
      // being orphaned or destroyed.
      await tx.$executeRaw`SELECT 1 FROM "ClubTheme" WHERE "id" = ${CLUB_THEME_ID} FOR UPDATE`;
      const locked = await tx.clubTheme.findUnique({
        where: { id: CLUB_THEME_ID },
        select: { logoUrl: true, logoDataUrl: true },
      });
      if (logoUnchanged && locked?.logoDataUrl !== logoFields.logoDataUrl) {
        // Another save replaced the logo after it was read, so the value this
        // save sends back is no longer what is stored: clean it like a new one.
        const recleaned = storableLogoDataUrl(logoFields.logoDataUrl);
        if (!recleaned.ok) throw new UncleanLogoError(recleaned.message);
        data.logoDataUrl = recleaned.value;
      }
      const previousLogoImageId = logoImageIdFromUrl(locked?.logoUrl ?? null);
      const nextLogoImageId = logoImageIdFromUrl(logoFields.logoUrl);

      // A stale tab can post a logoUrl whose blob a newer save already deleted.
      // Writing it would dangle the theme, and on an A->B->A sequence would also
      // delete a blob that is still referenced. Verify presence under the lock
      // and refuse instead.
      if (nextLogoImageId) {
        const referenced = await tx.mediaImage.findFirst({
          where: { id: nextLogoImageId, kind: { in: ["LOGO", "CONTENT"] } },
          select: { id: true },
        });
        if (!referenced) {
          throw new MissingLogoImageError();
        }
      }

      const saved = await tx.clubTheme.update({
        where: { id: CLUB_THEME_ID },
        data,
      });

      if (previousLogoImageId && previousLogoImageId !== nextLogoImageId) {
        // Scoped to LOGO so this can never take out a CONTENT image: page HTML
        // and the image-library picker may still reference those, and a logo that
        // arrived through config transfer or the legacy data-URI path is not a
        // LOGO row at all.
        await tx.mediaImage.deleteMany({
          where: { id: previousLogoImageId, kind: "LOGO" },
        });
      }

      return saved;
    },
    { maxWait: 10_000, timeout: 15_000 },
  );

  const values = normaliseThemeValues(theme);
  return {
    ...values,
    completedAt: theme.completedAt?.toISOString() ?? null,
    contrastWarnings: getContrastWarnings(values),
  };
}

/**
 * `readFailed` exists because `isComplete: false` used to mean two different
 * things (#2420 review finding F4): "the database says this club has not
 * finished setup" and "the database did not answer". Callers that only need the
 * theme values can keep ignoring the difference — the fallback palette is right
 * either way — but any caller about to make a CLAIM ABOUT THE CLUB from it must
 * not, and one was.
 *
 * The sequence that made it matter, on a live and fully configured club:
 * `src/proxy.ts`'s setup gate holds a cached "complete" answer, so it lets the
 * request through; the database blips; this read fails a moment later inside
 * the shared public chrome's own cache refresh; the chrome concludes "setup
 * incomplete" and paints the "Site setup in progress" screen with a 200; and
 * because `/` is allow-listed as anonymously cacheable, `proxy()` stamps
 * `public, max-age=60, stale-while-revalidate=300` on it. A two-second outage
 * therefore pinned a launch-state lie into every anonymous visitor's cache for a
 * minute, and a shared cache for five.
 */
export async function getWebsiteThemeRenderState() {
  const theme = await prisma.clubTheme
    .findUnique({
      where: { id: CLUB_THEME_ID },
    })
    .catch(() => READ_FAILED);
  const readFailed = theme === READ_FAILED;
  const row = readFailed ? null : (theme as Exclude<typeof theme, symbol>);
  const values = normaliseThemeValues(row ?? DEFAULT_CLUB_THEME_VALUES);
  // A failed read renders the default palette but is not memoised: it would
  // evict the club's real stylesheets, which the next good read then rebuilds.
  const { css, appCss } = readFailed
    ? buildThemeStylesheets(values)
    : themeStylesheets(values);

  return {
    values,
    css,
    appCss,
    logoUrl: values.logoUrl,
    logoDataUrl: values.logoDataUrl,
    isComplete: Boolean(row?.completedAt),
    /** True only when the read THREW — never when it returned "no row". */
    readFailed,
  };
}

/**
 * The last theme's two stylesheets, reused while the values are unchanged
 * (#5264). Generating them runs the palette generator twice, which costs
 * hundreds of milliseconds of CPU, logo or not. The values change only when an
 * administrator saves a new site style, but every 15-second cache refill of
 * the theme rebuilt both. That work blocks the server's only thread, so every
 * request arriving meanwhile waited for it. Both builders are pure functions of
 * the values, so reusing the last output is exact.
 */
let lastThemeStylesheets: {
  values: ClubThemeValues;
  css: string;
  appCss: string;
} | null = null;

function themeStylesheets(values: ClubThemeValues) {
  if (
    lastThemeStylesheets &&
    sameThemeValues(lastThemeStylesheets.values, values)
  ) {
    return lastThemeStylesheets;
  }

  lastThemeStylesheets = buildThemeStylesheets(values);
  return lastThemeStylesheets;
}

function buildThemeStylesheets(values: ClubThemeValues) {
  return {
    values,
    css: buildClubThemeCss(values),
    appCss: buildClubThemeAppCss(values),
  };
}

// test seam
export function resetThemeStylesheetCache() {
  lastThemeStylesheets = null;
}

function sameThemeValues(a: ClubThemeValues, b: ClubThemeValues) {
  const keys = Object.keys(a) as (keyof ClubThemeValues)[];
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.is(a[key], b[key]))
  );
}

/**
 * Whether setup is complete, from `completedAt` alone (#5264). This is the
 * proxy's setup gate's read on every refresh, and on a live club it is the only
 * one: it never loads the logo or builds the theme CSS that
 * `getWebsiteThemeRenderState()` does. `readFailed` keeps "the database did not
 * answer" apart from "not complete", for the reason given above that function.
 */
export async function readSetupCompletion(): Promise<
  { readFailed: true } | { readFailed: false; isComplete: boolean }
> {
  const row = await prisma.clubTheme
    .findUnique({
      where: { id: CLUB_THEME_ID },
      select: { completedAt: true },
    })
    .catch(() => READ_FAILED);

  if (typeof row === "symbol") {
    return { readFailed: true };
  }

  return { readFailed: false, isComplete: Boolean(row?.completedAt) };
}
