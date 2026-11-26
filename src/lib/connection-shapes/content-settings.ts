/**
 * What the site settings, site style and mountain conditions actions send an
 * AI app connection (ALP-723, `INV-MCP-006`).
 *
 * Left out on purpose: the site style's inline logo (`logoDataUrl`), image
 * bytes of up to 900 KB that an app has no use for and never saves (the logo
 * is a file, changed on the website). `logoUrl` says which uploaded logo is in
 * use.
 */
import type { ContrastWarning, ClubThemeValues } from "@/lib/club-theme-schema";
import {
  completeConnectionShapeFor,
  type CompleteConnectionShapeFor,
  eachEntry,
  type ConnectionShape,
} from "@/lib/connection-projection";
import type { PrivacyHostingValues } from "@/lib/privacy-hosting";
import type { PublicContentSettingsValues } from "@/lib/admin-content-api/settings";
import type {
  WhakapapaCurlData,
  WhakapapaSectionVisibility,
  WhakapapaSourceConfig,
} from "@/lib/whakapapa-report";

// ---------------------------------------------------------------------------
// Public fee and policy sections, and the Book Now button
// ---------------------------------------------------------------------------

const PUBLIC_CONTENT_SETTINGS_SHAPE = {
  membershipTypes: true,
  entranceFees: true,
  hutFees: true,
  bookingPolicySummary: true,
  cancellationPolicy: true,
  annualFees: true,
  showBookNow: true,
  bookNowTarget: true,
  bookNowPageId: true,
  committeePhotoDisplay: true,
} as const satisfies CompleteConnectionShapeFor<PublicContentSettingsValues>;

/** The settings, and the published pages Book Now may point at. */
export const PUBLIC_CONTENT_SETTINGS_READ_CONNECTION_SHAPE = completeConnectionShapeFor<{
  settings: PublicContentSettingsValues;
  pages: Array<{ id: string; title: string; path: string }>;
}>({
  settings: PUBLIC_CONTENT_SETTINGS_SHAPE,
  pages: { id: true, title: true, path: true },
});

export const PUBLIC_CONTENT_SETTINGS_SAVED_CONNECTION_SHAPE: ConnectionShape = {
  settings: PUBLIC_CONTENT_SETTINGS_SHAPE,
};

// ---------------------------------------------------------------------------
// Contact page committee role
// ---------------------------------------------------------------------------

export const CLUB_CONTACT_READ_CONNECTION_SHAPE = completeConnectionShapeFor<{
  contactCommitteeRoleKey: string | null;
  roles: Array<{ key: string; name: string }>;
}>({
  contactCommitteeRoleKey: true,
  roles: { key: true, name: true },
});

export const CLUB_CONTACT_SAVED_CONNECTION_SHAPE = completeConnectionShapeFor<{
  contactCommitteeRoleKey: string | null;
}>({ contactCommitteeRoleKey: true });

// ---------------------------------------------------------------------------
// Club identity
// ---------------------------------------------------------------------------

interface ClubIdentityValues {
  name: string | null;
  shortName: string | null;
  hutLeaderLabel: string | null;
  facebookUrl: string | null;
  legalName: string | null;
  postalAddress: string | null;
}

export const CLUB_IDENTITY_CONNECTION_SHAPE = completeConnectionShapeFor<{ settings: ClubIdentityValues }>({
  settings: {
    name: true,
    shortName: true,
    hutLeaderLabel: true,
    facebookUrl: true,
    legalName: true,
    postalAddress: true,
  },
});

// ---------------------------------------------------------------------------
// Privacy page hosting disclosure
// ---------------------------------------------------------------------------

export const PRIVACY_HOSTING_CONNECTION_SHAPE = completeConnectionShapeFor<{ settings: PrivacyHostingValues }>({
  settings: { hostingProvider: true, dataLocation: true },
});

// ---------------------------------------------------------------------------
// Site style
// ---------------------------------------------------------------------------

type ClubThemeAnswer = Omit<ClubThemeValues, "logoDataUrl"> & {
  completedAt: string | null;
  contrastWarnings: ContrastWarning[];
};

export const SITE_STYLE_CONNECTION_SHAPE = completeConnectionShapeFor<{ theme: ClubThemeAnswer }>({
  theme: {
    brandGold: true,
    brandDeep: true,
    brandSafety: true,
    headingFontKey: true,
    bodyFontKey: true,
    logoUrl: true,
    rawCss: true,
    completedAt: true,
    contrastWarnings: { id: true, label: true, ratio: true, message: true },
  },
});

// ---------------------------------------------------------------------------
// Mountain conditions (the ski field report the public widget shows)
// ---------------------------------------------------------------------------

const VISIBILITY_SHAPE = {
  roadStatus: true,
  lifts: true,
  facilities: true,
  foodAndDrink: true,
  conditions: true,
  trails: true,
} as const satisfies CompleteConnectionShapeFor<WhakapapaSectionVisibility>;

const FACILITY_SHAPE = { name: true, status: true } as const;

const REPORT_SHAPE = {
  updated: true,
  roadStatus: { name: true, status: true, wheelRequirements: true, roadContent: true },
  facilities: FACILITY_SHAPE,
  foodAndDrink: FACILITY_SHAPE,
  lifts: FACILITY_SHAPE,
  conditions: {
    name: true,
    temperature: true,
    wind: true,
    snowBase: true,
    snowfall24h: true,
    snowfall7d: true,
  },
  trails: {
    name: true,
    trails: { name: true, status: true, groomed: true, difficulty: true, size: true },
  },
  visibility: VISIBILITY_SHAPE,
} as const satisfies CompleteConnectionShapeFor<WhakapapaCurlData>;

const SOURCE_CONFIG_SHAPE = {
  sourceUrl: true,
  selectorOverrides: eachEntry(true),
} as const satisfies CompleteConnectionShapeFor<WhakapapaSourceConfig>;

interface MountainConditionsRecord {
  source: string;
  payload: WhakapapaCurlData;
  config: WhakapapaSourceConfig;
  fetchedAt: string;
  frozenUntil: string | null;
  updatedAt: string;
}

const RECORD_SHAPE = {
  source: true,
  payload: REPORT_SHAPE,
  config: SOURCE_CONFIG_SHAPE,
  fetchedAt: true,
  frozenUntil: true,
  updatedAt: true,
} as const satisfies CompleteConnectionShapeFor<MountainConditionsRecord>;

/** Null `record` until the report is first fetched or saved. */
export const MOUNTAIN_CONDITIONS_READ_CONNECTION_SHAPE: ConnectionShape = { record: RECORD_SHAPE };

export const MOUNTAIN_CONDITIONS_SAVED_CONNECTION_SHAPE: ConnectionShape = {
  record: RECORD_SHAPE,
  message: true,
};
