import { JSDOM } from "jsdom";
import logger from "@/lib/logger";
import {
  emptyWhakapapaCurlData,
  resolveWhakapapaRedirectTarget,
  validateWhakapapaSourceUrl,
  WHAKAPAPA_DEFAULT_SELECTORS,
  WHAKAPAPA_DEFAULT_SOURCE_URL,
  WHAKAPAPA_MAX_REDIRECTS,
  WHAKAPAPA_SELECTOR_KEYS,
  type WhakapapaCondition,
  type WhakapapaCurlData,
  type WhakapapaFacilityItem,
  type WhakapapaRoadStatus,
  type WhakapapaSelectorConfig,
  type WhakapapaSelectorKey,
  type WhakapapaTrail,
  type WhakapapaTrailArea,
} from "@/lib/whakapapa-report";

// `trailsHeadingId` is passed to getElementById (any string is a valid id), so
// it is not a CSS selector and must not be compiled as one.
const NON_SELECTOR_KEYS = new Set<WhakapapaSelectorKey>(["trailsHeadingId"]);

/**
 * Compile each supplied selector override against the SAME engine the scraper
 * uses (a JSDOM document's querySelector), and return the keys whose value would
 * throw. This makes a save-time check mean precisely "will this throw when we
 * scrape with it" — so a malformed selector is refused up front instead of
 * saving cleanly and then throwing on every scrape (a stale public widget and a
 * 500 on Update from upstream).
 */
export function findInvalidSelectorOverrides(
  overrides: Partial<Record<WhakapapaSelectorKey, string>> | null | undefined,
): WhakapapaSelectorKey[] {
  if (!overrides || typeof overrides !== "object") {
    return [];
  }

  const { document } = new JSDOM(
    "<!doctype html><html><body></body></html>",
  ).window;
  const invalid: WhakapapaSelectorKey[] = [];

  for (const key of WHAKAPAPA_SELECTOR_KEYS) {
    if (NON_SELECTOR_KEYS.has(key)) {
      continue;
    }
    const value = overrides[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      continue;
    }
    try {
      document.querySelector(value);
    } catch {
      invalid.push(key);
    }
  }

  return invalid;
}

export interface WhakapapaFetchOptions {
  /** Report URL to scrape. Falls back to the default (and is re-validated). */
  sourceUrl?: string;
  /** Resolved selector map. Falls back to the built-in hash-agnostic defaults. */
  selectors?: WhakapapaSelectorConfig;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeLabel(value: string): string {
  return value.replace(/:\s*$/, "").trim().toLowerCase();
}

function resolveSourceUrl(candidate: string | undefined): string {
  const validated = validateWhakapapaSourceUrl(candidate);
  // Defence in depth: the admin save path already rejects out-of-allowlist
  // URLs, but if a bad value ever reaches here we fall back to the safe default
  // rather than fetch an attacker-controlled host.
  return validated.ok ? validated.url : WHAKAPAPA_DEFAULT_SOURCE_URL;
}

function parseFacilityItems(
  section: ParentNode,
  selectors: WhakapapaSelectorConfig,
): WhakapapaFacilityItem[] {
  return Array.from(section.querySelectorAll(selectors.item))
    .map((node) => ({
      name: normalizeText(node.querySelector(selectors.itemName)?.textContent),
      status: normalizeText(
        node.querySelector(selectors.itemStatus)?.textContent,
      ),
    }))
    .filter((item) => item.name.length > 0 || item.status.length > 0);
}

function findMetricValue(container: ParentNode, title: string): string {
  const target = normalizeLabel(title);
  const titleNodes = Array.from(container.querySelectorAll("div"));

  for (const node of titleNodes) {
    const nodeLabel = normalizeLabel(normalizeText(node.textContent));
    if (nodeLabel !== target) {
      continue;
    }

    const nextSiblingText = normalizeText(node.nextElementSibling?.textContent);
    if (nextSiblingText) {
      return nextSiblingText;
    }

    const parent = node.parentElement;
    if (!parent) {
      continue;
    }

    const parentChildren = Array.from(parent.children);
    const nodeIndex = parentChildren.indexOf(node);
    if (nodeIndex >= 0) {
      for (let i = nodeIndex + 1; i < parentChildren.length; i += 1) {
        const siblingText = normalizeText(parentChildren[i]?.textContent);
        if (siblingText && normalizeLabel(siblingText) !== target) {
          return siblingText;
        }
      }
    }
  }

  return "";
}

// Difficulty is drawn as a coloured SVG grade marker whose shape carries an
// id/colour on the upstream report:
//   green circle (id "green")            -> Beginner
//   blue square  (id "blue")             -> Intermediate
//   black diamond (a path with NO id)    -> Advanced
//   red diamond  (id "diamond_left"/…)   -> Expert
// Read the shape rather than any hashed class so it survives an upstream rebuild.
function parseTrailDifficulty(iconEl: Element | null): string {
  if (!iconEl) {
    return "";
  }

  const shapes = Array.from(
    iconEl.querySelectorAll("circle, ellipse, rect, path, polygon"),
  );
  if (shapes.length === 0) {
    return "";
  }

  // 1) By shape id keyword — robust to both the current lowercase ids
  //    (green / blue / diamond_left / diamond_right) and Capitalised variants
  //    (Green_circle / Blue_square / Diamond_left).
  for (const shape of shapes) {
    const id = normalizeText(shape.id).toLowerCase();
    if (id.includes("green")) return "Beginner";
    if (id.includes("blue")) return "Intermediate";
    if (id.includes("diamond")) return "Expert";
    if (id.includes("black")) return "Advanced";
  }

  // 2) Fall back to the shape kind: a circle is a green (Beginner) run, a
  //    rect a blue (Intermediate) run, and an id-less diamond path/polygon is
  //    the black (Advanced) marker.
  for (const shape of shapes) {
    const tag = shape.tagName.toLowerCase();
    if (tag === "circle" || tag === "ellipse") return "Beginner";
    if (tag === "rect") return "Intermediate";
    if (tag === "path" || tag === "polygon") return "Advanced";
  }

  return "";
}

function parseTrailSubInfo(raw: string): { groomed: boolean; size: string } {
  const parts = raw
    .split(/\s*-\s*/)
    .map(normalizeText)
    .filter((part) => part.length > 0);

  let groomed = false;
  const sizeParts: string[] = [];
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "groomed") {
      groomed = true;
    } else if (lower === "ungroomed") {
      groomed = false;
    } else {
      // Anything that is not the groomed flag (e.g. a park size) becomes size.
      sizeParts.push(part);
    }
  }

  return { groomed, size: sizeParts.join(" - ") };
}

function parseTrailItem(
  el: Element,
  selectors: WhakapapaSelectorConfig,
): WhakapapaTrail {
  const subInfo = parseTrailSubInfo(
    normalizeText(el.querySelector(selectors.trailSubInfo)?.textContent),
  );

  return {
    name: normalizeText(el.querySelector(selectors.itemName)?.textContent),
    status: normalizeText(el.querySelector(selectors.itemStatus)?.textContent),
    groomed: subInfo.groomed,
    difficulty: parseTrailDifficulty(
      el.querySelector(selectors.trailDifficultyIcon),
    ),
    size: subInfo.size,
  };
}

function parseTrailAreas(
  document: Document,
  selectors: WhakapapaSelectorConfig,
): WhakapapaTrailArea[] {
  const heading = document.getElementById(selectors.trailsHeadingId);
  const wrapper =
    heading?.closest(selectors.sectionWrapper) ??
    heading?.parentElement ??
    null;
  if (!wrapper) {
    return [];
  }

  const areaEls = Array.from(wrapper.querySelectorAll(selectors.trailArea));
  // If the collapsable sub-area structure changes, fall back to treating the
  // whole trails wrapper as one unnamed area so trails still surface.
  const areaSources: ParentNode[] = areaEls.length > 0 ? areaEls : [wrapper];

  const areas: WhakapapaTrailArea[] = [];
  for (const areaEl of areaSources) {
    const areaName = normalizeText(
      (areaEl as Element).querySelector(selectors.trailAreaName)?.textContent,
    );
    const trails = Array.from(areaEl.querySelectorAll(selectors.item))
      .map((el) => parseTrailItem(el, selectors))
      .filter((trail) => trail.name.length > 0);

    if (trails.length > 0) {
      areas.push({ name: areaName, trails });
    }
  }

  return areas;
}

// ---------------------------------------------------------------------------
// Trails via the upstream JSON API (fork #45).
//
// Whakapapa's UI update moved the Trails area behind collapsible sections
// whose content is EMPTY in the served HTML — a Lit app renders it
// client-side from the site's own same-origin JSON endpoint, /api/report.
// A fetch-and-JSDOM scraper cannot "expand" anything (there is no JavaScript
// execution and no per-section fetch to mimic), so when the DOM parse finds
// no trails the scraper reads the SAME JSON the page renders from. The
// payload is XML-shaped JSON: a single child arrives as an OBJECT and
// several as an ARRAY, so every list is coerced one-or-many.
// ---------------------------------------------------------------------------

const WHAKAPAPA_REPORT_API_PATH = "/api/report";

function objectField(value: unknown, key: string): unknown {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function coerceOneOrMany(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === "object",
    );
  }
  if (value && typeof value === "object") {
    return [value as Record<string, unknown>];
  }
  return [];
}

function stringField(value: unknown, key: string): string {
  const raw = objectField(value, key);
  return normalizeText(typeof raw === "string" ? raw : "");
}

// The JSON spells difficulty in lowercase ("beginner"); the DOM path's
// vocabulary (parseTrailDifficulty) is capitalised, and downstream consumers
// key off those exact strings, so the two sources must agree.
function normalizeJsonDifficulty(value: unknown): string {
  const raw = normalizeText(typeof value === "string" ? value : "").toLowerCase();
  if (raw === "beginner") return "Beginner";
  if (raw === "intermediate") return "Intermediate";
  if (raw === "advanced") return "Advanced";
  if (raw === "expert") return "Expert";
  // Unknown words map to "" exactly as the DOM path's parseTrailDifficulty
  // does: the widget's DifficultyMarker renders nothing for an unrecognised
  // word but TrailCard still prints the separator for any truthy difficulty,
  // so passing one through would render a bare "· Groomed" row. Keeping the
  // two sources byte-identical in behaviour is the contract (review item 3).
  return "";
}

/** test seam — maps the /api/report payload's areas into trail areas. */
export function mapWhakapapaReportApiTrailAreas(
  payload: unknown,
): WhakapapaTrailArea[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  // Everything nests under one resort key ({ "whakapapa": {...} }); take the
  // first object value that actually carries a facilities node rather than
  // hard-coding the resort name — so a sibling object key added ahead of the
  // resort key cannot silently empty the trails (review item 5).
  const resort = Object.values(payload as Record<string, unknown>).find(
    (value) => Boolean(objectField(value, "facilities")),
  );
  const areaNodes = coerceOneOrMany(
    objectField(objectField(objectField(resort, "facilities"), "areas"), "area"),
  );

  const areas: WhakapapaTrailArea[] = [];
  for (const areaNode of areaNodes) {
    const trails: WhakapapaTrail[] = coerceOneOrMany(
      objectField(objectField(areaNode, "trails"), "trail"),
    )
      .map((trailNode) => ({
        name: stringField(trailNode, "name"),
        status: stringField(trailNode, "status"),
        groomed: stringField(trailNode, "groomed").toLowerCase() === "yes",
        difficulty: normalizeJsonDifficulty(objectField(trailNode, "difficulty")),
        // The JSON carries no groomed/size descriptor line; size only ever
        // came from the DOM sub-info text, so it stays empty here.
        size: "",
      }))
      .filter((trail) => trail.name.length > 0);

    if (trails.length > 0) {
      areas.push({ name: stringField(areaNode, "name"), trails });
    }
  }
  return areas;
}

/**
 * Fetch trails from `<source-origin>/api/report`, through the SAME
 * allowlisted, manual-redirect fetcher as the HTML — the SSRF guard applies
 * to every hop of this request exactly as it does to the page itself.
 */
async function fetchTrailAreasFromReportApi(
  sourceUrl: string,
): Promise<WhakapapaTrailArea[]> {
  const apiUrl = new URL(WHAKAPAPA_REPORT_API_PATH, sourceUrl).toString();
  // Ask for JSON on this hop: the default Accept ranks XML above the
  // wildcard, and a backend that honoured it for this XML-shaped-JSON feed
  // would hand back XML that .json() cannot parse (review item 1).
  const response = await fetchAllowlistedReport(apiUrl, "application/json");
  if (!response.ok) {
    // The error body is never read; release the socket rather than leaving
    // it pinned until GC — the same guard the redirect path carries.
    response.body?.cancel().catch(() => {});
    throw new Error(
      `Whakapapa report API fetch failed (status ${response.status}).`,
    );
  }
  const payload: unknown = await response.json();
  return mapWhakapapaReportApiTrailAreas(payload);
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status <= 399;
}

/**
 * Fetch the report, applying the host allowlist to EVERY hop rather than only to
 * the URL we were handed.
 *
 * `redirect: "manual"` is the load-bearing part. With the default
 * `redirect: "follow"`, `sourceUrl` is checked once and the upstream server then
 * picks every subsequent destination — and because this response is cached and
 * served publicly, a redirect to an internal address would be readable rather
 * than blind. Here a 30x is handed back to us, its `Location` is re-validated
 * through the same allowlist, and anything that leaves the allowed hosts throws
 * instead of being fetched (#2841, CodeQL `js/request-forgery`). Why the alert
 * itself is a false positive, and why this residual underneath it was not, is
 * recorded once in docs/SECURITY-ATTACK-SURFACE.md -> "CodeQL And Semgrep Alert
 * Backlog Triage".
 */
async function fetchAllowlistedReport(
  startUrl: string,
  accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
): Promise<Response> {
  let target = startUrl;

  for (let hop = 0; hop <= WHAKAPAPA_MAX_REDIRECTS; hop += 1) {
    const response = await fetch(target, {
      method: "GET",
      headers: {
        Accept: accept,
        "User-Agent": "AlpineClubBookingsNZ/1.0 (+whakapapa-report)",
      },
      cache: "no-store",
      redirect: "manual",
    });

    if (!isRedirectStatus(response.status)) {
      return response;
    }

    const next = resolveWhakapapaRedirectTarget(
      response.headers.get("location"),
      target,
    );
    // The redirect body is never read; release the socket rather than leaving it
    // pinned until GC.
    response.body?.cancel().catch(() => {});

    if (!next.ok) {
      throw new Error(`Whakapapa report redirect refused: ${next.error}`);
    }
    target = next.url;
  }

  throw new Error(
    `Whakapapa report fetch exceeded ${WHAKAPAPA_MAX_REDIRECTS} redirects.`,
  );
}

export async function fetchWhakapapaCurlData(
  options: WhakapapaFetchOptions = {},
): Promise<WhakapapaCurlData> {
  const sourceUrl = resolveSourceUrl(options.sourceUrl);
  const selectors = options.selectors ?? WHAKAPAPA_DEFAULT_SELECTORS;

  const upstream = await fetchAllowlistedReport(sourceUrl);

  const html = await upstream.text();
  if (!upstream.ok || html.trim().length === 0) {
    throw new Error(
      `Whakapapa report fetch failed (status ${upstream.status}).`,
    );
  }

  const dom = new JSDOM(html);
  const { document } = dom.window;

  const roadStatus: WhakapapaRoadStatus = {
    name: normalizeText(
      document.querySelector(selectors.roadAreaTitle)?.textContent?.split(":")[0],
    ),
    status: normalizeText(
      document.querySelector(selectors.roadStatus)?.textContent,
    ),
    wheelRequirements: normalizeText(
      document.querySelector(selectors.roadWheelRequirements)?.textContent,
    ),
    roadContent: normalizeText(
      document.querySelector(selectors.roadContent)?.textContent,
    ),
  };

  const facilities: WhakapapaFacilityItem[] = [];
  const foodAndDrink: WhakapapaFacilityItem[] = [];
  const lifts: WhakapapaFacilityItem[] = [];

  // The report groups status items into Facilities, Food & Drink, and Lifts.
  // Anchor on each group's titled heading (stable id, falling back to heading
  // text) then read the sibling items container from the enclosing wrapper.
  // Iterating headings (not wrappers) keeps a single hit per group even when
  // the hash-agnostic wrapper selector matches nested wrappers.
  const headings = Array.from(
    document.querySelectorAll(selectors.sectionHeading),
  );
  for (const heading of headings) {
    const headingId = heading.id ?? "";
    const headingLabel = normalizeLabel(normalizeText(heading.textContent));

    let bucket: WhakapapaFacilityItem[] | null = null;
    if (headingId === "facilities" || headingLabel === "facilities") {
      bucket = facilities;
    } else if (headingId === "food-drink" || headingLabel === "food & drink") {
      bucket = foodAndDrink;
    } else if (headingId === "lifts" || headingLabel === "lifts") {
      bucket = lifts;
    }
    if (!bucket) {
      continue;
    }

    const wrapper =
      heading.closest(selectors.sectionWrapper) ?? heading.parentElement;
    const itemsContainer = wrapper?.querySelector(selectors.sectionItems);
    if (!itemsContainer) {
      continue;
    }

    bucket.push(...parseFacilityItems(itemsContainer, selectors));
  }

  const conditionNodes = Array.from(
    document.querySelectorAll(selectors.conditionRow),
  );
  const conditions: WhakapapaCondition[] = conditionNodes
    .map((node) => ({
      name: normalizeText(
        node.querySelector(selectors.conditionTitle)?.textContent,
      ),
      temperature: normalizeText(
        node.querySelector(selectors.conditionTemperature)?.textContent,
      ),
      wind: findMetricValue(node, "Wind"),
      snowBase: findMetricValue(node, "Snow Base"),
      snowfall24h: findMetricValue(node, "24 hr Snowfall"),
      snowfall7d: findMetricValue(node, "7 day Snowfall"),
    }))
    .filter((item) => item.name.length > 0);

  let trails = parseTrailAreas(document, selectors);
  if (trails.length === 0) {
    // Fork #45: the collapsed-UI case — the trail rows are not in the HTML at
    // all, so read the JSON the page itself renders them from. DOM-first, so
    // an upstream revert resumes the original scrape with no extra request;
    // a JSON failure degrades to the pre-#45 (trail-less) report rather than
    // failing the whole scrape, and says so in the log.
    try {
      trails = await fetchTrailAreasFromReportApi(sourceUrl);
    } catch (error) {
      logger.warn(
        { err: error },
        "Whakapapa trails JSON fallback failed; report continues without trails (fork #45)",
      );
    }
  }

  const curlData = emptyWhakapapaCurlData();
  curlData.updated = new Date().toISOString();
  curlData.roadStatus = roadStatus;
  curlData.facilities = facilities;
  curlData.foodAndDrink = foodAndDrink;
  curlData.lifts = lifts;
  curlData.conditions = conditions;
  curlData.trails = trails;

  return curlData;
}
