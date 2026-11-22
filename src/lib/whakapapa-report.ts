export interface WhakapapaRoadStatus {
  name: string;
  status: string;
  wheelRequirements: string;
  roadContent: string;
}

export interface WhakapapaFacilityItem {
  name: string;
  status: string;
}

export interface WhakapapaCondition {
  name: string;
  temperature: string;
  wind: string;
  snowBase: string;
  snowfall24h: string;
  snowfall7d: string;
}

export interface WhakapapaTrail {
  name: string;
  status: string;
  groomed: boolean;
  difficulty: string;
  size: string;
}

/**
 * Trails are grouped into named sub-areas on the upstream report (e.g.
 * "Happy Valley Area", "Sky Waka Area"), each holding its own list of trails.
 */
export interface WhakapapaTrailArea {
  name: string;
  trails: WhakapapaTrail[];
}

/**
 * Controls which articles the public widget renders. Each flag maps to one
 * article; `true` shows the article and `false` hides it. Missing flags default
 * to visible so legacy cached payloads keep rendering every section.
 */
export interface WhakapapaSectionVisibility {
  roadStatus: boolean;
  lifts: boolean;
  facilities: boolean;
  foodAndDrink: boolean;
  conditions: boolean;
  trails: boolean;
}

export interface WhakapapaCurlData {
  updated: string;
  roadStatus: WhakapapaRoadStatus;
  facilities: WhakapapaFacilityItem[];
  foodAndDrink: WhakapapaFacilityItem[];
  lifts: WhakapapaFacilityItem[];
  conditions: WhakapapaCondition[];
  trails: WhakapapaTrailArea[];
  visibility: WhakapapaSectionVisibility;
}

export function emptyWhakapapaSectionVisibility(): WhakapapaSectionVisibility {
  return {
    roadStatus: true,
    lifts: true,
    facilities: true,
    foodAndDrink: true,
    conditions: true,
    trails: true,
  };
}

export function coerceWhakapapaSectionVisibility(
  value: unknown,
): WhakapapaSectionVisibility {
  const defaults = emptyWhakapapaSectionVisibility();
  if (!value || typeof value !== "object") {
    return defaults;
  }

  const entry = value as Partial<
    Record<keyof WhakapapaSectionVisibility, unknown>
  >;
  const resolve = (key: keyof WhakapapaSectionVisibility): boolean =>
    typeof entry[key] === "boolean" ? (entry[key] as boolean) : defaults[key];

  return {
    roadStatus: resolve("roadStatus"),
    lifts: resolve("lifts"),
    facilities: resolve("facilities"),
    foodAndDrink: resolve("foodAndDrink"),
    conditions: resolve("conditions"),
    trails: resolve("trails"),
  };
}

export function emptyWhakapapaCurlData(): WhakapapaCurlData {
  return {
    updated: "",
    roadStatus: {
      name: "",
      status: "",
      wheelRequirements: "",
      roadContent: "",
    },
    facilities: [],
    foodAndDrink: [],
    lifts: [],
    conditions: [],
    trails: [],
    visibility: emptyWhakapapaSectionVisibility(),
  };
}

export function coerceWhakapapaCurlData(
  payload: unknown,
): WhakapapaCurlData | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const data = payload as Partial<WhakapapaCurlData> & {
    roadStatus?: Partial<WhakapapaRoadStatus>;
    chairlifts?: unknown;
    visibility?: unknown;
  };

  if (!data.roadStatus || typeof data.roadStatus !== "object") {
    return null;
  }

  const facilities = coerceFacilityItems(data.facilities);
  const foodAndDrink = coerceFacilityItems(data.foodAndDrink);
  // Legacy payloads (cached or admin-frozen before the grouped split) stored
  // every item under `chairlifts`. Fall back to those so the widget keeps
  // showing lift data until the next upstream refresh.
  const lifts = Array.isArray(data.lifts)
    ? coerceFacilityItems(data.lifts)
    : coerceFacilityItems(data.chairlifts);

  const conditions = Array.isArray(data.conditions)
    ? data.conditions
        .map((item) => {
          if (!item || typeof item !== "object") {
            return null;
          }
          const entry = item as Partial<WhakapapaCondition>;
          return {
            name: typeof entry.name === "string" ? entry.name : "",
            temperature:
              typeof entry.temperature === "string" ? entry.temperature : "",
            wind: typeof entry.wind === "string" ? entry.wind : "",
            snowBase: typeof entry.snowBase === "string" ? entry.snowBase : "",
            snowfall24h:
              typeof entry.snowfall24h === "string" ? entry.snowfall24h : "",
            snowfall7d:
              typeof entry.snowfall7d === "string" ? entry.snowfall7d : "",
          };
        })
        .filter((item): item is WhakapapaCondition => item !== null)
    : [];

  const trails = coerceTrailAreas(data.trails);

  return {
    updated: typeof data.updated === "string" ? data.updated : "",
    roadStatus: {
      name:
        typeof data.roadStatus.name === "string" ? data.roadStatus.name : "",
      status:
        typeof data.roadStatus.status === "string"
          ? data.roadStatus.status
          : "",
      wheelRequirements:
        typeof data.roadStatus.wheelRequirements === "string"
          ? data.roadStatus.wheelRequirements
          : "",
      roadContent:
        typeof data.roadStatus.roadContent === "string"
          ? data.roadStatus.roadContent
          : "",
    },
    facilities,
    foodAndDrink,
    lifts,
    conditions,
    trails,
    visibility: coerceWhakapapaSectionVisibility(data.visibility),
  };
}

function coerceFacilityItems(value: unknown): WhakapapaFacilityItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const entry = item as Partial<WhakapapaFacilityItem>;
      return {
        name: typeof entry.name === "string" ? entry.name : "",
        status: typeof entry.status === "string" ? entry.status : "",
      };
    })
    .filter((item): item is WhakapapaFacilityItem => item !== null);
}

function coerceTrails(value: unknown): WhakapapaTrail[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const entry = item as Partial<WhakapapaTrail>;
      return {
        name: typeof entry.name === "string" ? entry.name : "",
        status: typeof entry.status === "string" ? entry.status : "",
        groomed: typeof entry.groomed === "boolean" ? entry.groomed : false,
        difficulty:
          typeof entry.difficulty === "string" ? entry.difficulty : "",
        size: typeof entry.size === "string" ? entry.size : "",
      };
    })
    .filter((item): item is WhakapapaTrail => item !== null);
}

function coerceTrailAreas(value: unknown): WhakapapaTrailArea[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((area) => {
      if (!area || typeof area !== "object") {
        return null;
      }
      const entry = area as Partial<WhakapapaTrailArea>;
      return {
        name: typeof entry.name === "string" ? entry.name : "",
        trails: coerceTrails(entry.trails),
      };
    })
    .filter((area): area is WhakapapaTrailArea => area !== null);
}

// ---------------------------------------------------------------------------
// Source configuration (URL + scraping selectors)
//
// The upstream report is a Lit/CSS-modules app whose class names carry a build
// hash suffix (e.g. `item_3CiH98`, `areaTitle_4xD33B`) that rotates on every
// upstream deploy. The default selectors below therefore match on the *stable*
// prefix via `[class*="prefix_"]` instead of a specific hash, and route section
// groups by their stable heading `id`. An admin can still override any selector
// from the Mountain Conditions panel when even the stable prefix changes.
// ---------------------------------------------------------------------------

export const WHAKAPAPA_DEFAULT_SOURCE_URL =
  "https://www.whakapapa.com/report";

/** Hosts the server-side report fetch is allowed to reach (SSRF guard). */
export const WHAKAPAPA_ALLOWED_SOURCE_HOSTS = ["whakapapa.com", "snow.nz"];

export interface WhakapapaSelectorConfig {
  /** Road status: the "<road> : <status>" area title. */
  roadAreaTitle: string;
  /** Road status open/closed badge (excludes facility/trail status badges). */
  roadStatus: string;
  roadWheelRequirements: string;
  roadContent: string;
  /** Facility/Food/Lifts group wrapper (routed by heading id/text). */
  sectionWrapper: string;
  /** Heading inside a group wrapper (its id/text selects the group). */
  sectionHeading: string;
  /** Items container inside a group wrapper. */
  sectionItems: string;
  /** A single facility/lift/trail row. */
  item: string;
  /** Row name label. */
  itemName: string;
  /** Row status badge. */
  itemStatus: string;
  /** Mountain conditions location row. */
  conditionRow: string;
  conditionTitle: string;
  conditionTemperature: string;
  /** Stable id of the Trails section heading. */
  trailsHeadingId: string;
  /** A collapsable trail sub-area (e.g. "Sky Waka Area"). */
  trailArea: string;
  /** Trail sub-area name. */
  trailAreaName: string;
  /** Difficulty icon wrapper (holds the coloured SVG grade marker). */
  trailDifficultyIcon: string;
  /** Groomed/size descriptor beneath a trail name. */
  trailSubInfo: string;
}

export type WhakapapaSelectorKey = keyof WhakapapaSelectorConfig;

export const WHAKAPAPA_DEFAULT_SELECTORS: WhakapapaSelectorConfig = {
  roadAreaTitle: '[class*="areaTitle_"]',
  roadStatus:
    '[class*="open_"]:not([class*="status_"]), [class*="closed_"]:not([class*="status_"])',
  roadWheelRequirements: '[class*="wheelRequirements_"]',
  roadContent: '[class*="roadContent_"]',
  sectionWrapper: '[class*="wrapper_"]',
  sectionHeading: '[class*="title_"]',
  sectionItems: '[class*="items_"]',
  item: '[class*="item_"]',
  itemName: '[class*="name_"]',
  itemStatus: '[class*="status_"]',
  conditionRow: '[class*="locationRow_"]',
  conditionTitle: '[class*="locationTitle_"]',
  conditionTemperature: '[class*="temperature_"]',
  trailsHeadingId: "trails",
  trailArea: '[class*="collapsableSection"]',
  trailAreaName: '[class*="title_"]',
  trailDifficultyIcon: '[class*="iconWrapper_"]',
  trailSubInfo: '[class*="subInfo"]',
};

export const WHAKAPAPA_SELECTOR_KEYS = Object.keys(
  WHAKAPAPA_DEFAULT_SELECTORS,
) as WhakapapaSelectorKey[];

/** Human-readable field names for each selector, used by the admin UI and by
 * the save-time "malformed selector" error so it can name the offending field. */
export const WHAKAPAPA_SELECTOR_LABELS: Record<WhakapapaSelectorKey, string> = {
  roadAreaTitle: "Road: area title",
  roadStatus: "Road: open/closed badge",
  roadWheelRequirements: "Road: wheel requirements",
  roadContent: "Road: road content",
  sectionWrapper: "Group: section wrapper",
  sectionHeading: "Group: section heading",
  sectionItems: "Group: items container",
  item: "Item: row",
  itemName: "Item: name",
  itemStatus: "Item: status badge",
  conditionRow: "Conditions: location row",
  conditionTitle: "Conditions: location name",
  conditionTemperature: "Conditions: temperature",
  trailsHeadingId: "Trails: heading id",
  trailArea: "Trails: sub-area",
  trailAreaName: "Trails: sub-area name",
  trailDifficultyIcon: "Trails: difficulty icon",
  trailSubInfo: "Trails: groomed/size text",
};

export interface WhakapapaSourceConfig {
  sourceUrl: string;
  /** Only selectors the admin has overridden; empty means "use the default". */
  selectorOverrides: Partial<Record<WhakapapaSelectorKey, string>>;
}

export function emptyWhakapapaSourceConfig(): WhakapapaSourceConfig {
  return {
    sourceUrl: WHAKAPAPA_DEFAULT_SOURCE_URL,
    selectorOverrides: {},
  };
}

/**
 * Merge stored overrides over the built-in defaults. Blank/whitespace overrides
 * are ignored so an admin can clear a field to fall back to the default.
 */
export function resolveWhakapapaSelectors(
  overrides: Partial<Record<WhakapapaSelectorKey, string>> | null | undefined,
): WhakapapaSelectorConfig {
  const resolved: WhakapapaSelectorConfig = { ...WHAKAPAPA_DEFAULT_SELECTORS };
  if (!overrides || typeof overrides !== "object") {
    return resolved;
  }
  for (const key of WHAKAPAPA_SELECTOR_KEYS) {
    const value = overrides[key];
    if (typeof value === "string" && value.trim().length > 0) {
      resolved[key] = value.trim();
    }
  }
  return resolved;
}

export function coerceWhakapapaSourceConfig(
  value: unknown,
): WhakapapaSourceConfig {
  const config = emptyWhakapapaSourceConfig();
  if (!value || typeof value !== "object") {
    return config;
  }

  const entry = value as {
    sourceUrl?: unknown;
    selectorOverrides?: unknown;
  };

  const validated = validateWhakapapaSourceUrl(entry.sourceUrl);
  if (validated.ok) {
    config.sourceUrl = validated.url;
  }

  if (entry.selectorOverrides && typeof entry.selectorOverrides === "object") {
    const raw = entry.selectorOverrides as Record<string, unknown>;
    for (const key of WHAKAPAPA_SELECTOR_KEYS) {
      const candidate = raw[key];
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        config.selectorOverrides[key] = candidate.trim();
      }
    }
  }

  return config;
}

export type WhakapapaSourceUrlResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

/**
 * Validate an admin-supplied report URL before the server fetches it. Locks the
 * host to the Whakapapa/Snow.nz domains so an admin (or a request that reached
 * this code) cannot turn the server-side fetch into an SSRF probe of internal
 * or cloud-metadata endpoints.
 */
export function validateWhakapapaSourceUrl(
  value: unknown,
): WhakapapaSourceUrlResult {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, error: "Source URL is required." };
  }

  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return { ok: false, error: "Source URL must be a valid URL." };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, error: "Source URL must use https." };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: "Source URL must not include credentials." };
  }

  const host = parsed.hostname.toLowerCase();
  const allowed = WHAKAPAPA_ALLOWED_SOURCE_HOSTS.some(
    (candidate) => host === candidate || host.endsWith(`.${candidate}`),
  );
  if (!allowed) {
    return {
      ok: false,
      error: `Source URL host must be one of: ${WHAKAPAPA_ALLOWED_SOURCE_HOSTS.join(
        ", ",
      )}.`,
    };
  }

  return { ok: true, url: parsed.toString() };
}

/**
 * How many redirect hops the report fetch will follow before giving up. Three is
 * enough for the ordinary apex/`www`/trailing-slash shuffles a marketing site
 * does and small enough that a redirect loop terminates quickly.
 */
export const WHAKAPAPA_MAX_REDIRECTS = 3;

/**
 * Resolve a redirect `Location` against the URL that produced it, then re-apply
 * the host allowlist to the result.
 *
 * `fetch` defaults to `redirect: "follow"`, which validates only the URL the
 * caller passed: every hop after that is chosen by the upstream server. The
 * scraped body is cached and served publicly from `/api/skifield-whakapapa`, so
 * an open redirect (or a compromised page) on an allowlisted host would turn a
 * blind server-side fetch into a readable one — an attacker could point it at an
 * internal address and read the response off the public endpoint. Re-validating
 * every hop keeps the allowlist, not the upstream, in charge of what is fetched
 * (#2841, CodeQL `js/request-forgery`).
 */
export function resolveWhakapapaRedirectTarget(
  location: string | null | undefined,
  currentUrl: string,
): WhakapapaSourceUrlResult {
  if (typeof location !== "string" || location.trim().length === 0) {
    return { ok: false, error: "Redirect response had no Location header." };
  }

  let absolute: string;
  try {
    // A relative Location resolves against the hop that returned it, which is
    // itself already allowlisted; an absolute one replaces it entirely. Either
    // way the result goes back through the same host check below.
    absolute = new URL(location.trim(), currentUrl).toString();
  } catch {
    return { ok: false, error: "Redirect Location was not a valid URL." };
  }

  return validateWhakapapaSourceUrl(absolute);
}
