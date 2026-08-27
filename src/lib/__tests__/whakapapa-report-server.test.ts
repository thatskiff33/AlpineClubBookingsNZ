import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mapWhakapapaReportApiTrailAreas,
  fetchWhakapapaCurlData,
  findInvalidSelectorOverrides,
} from "@/lib/whakapapa-report.server";

// Regression coverage for the upstream Whakapapa report scraper (PR #1581,
// #1657). The parser routes the three status groups by heading id AND falls
// back to the heading text so an upstream markup id change does not silently
// drop a group. Both routing paths are pinned here over a fixture DOM.

type SectionSpec = { id: string; label: string; items: [string, string][] };

function section({ id, label, items }: SectionSpec): string {
  const itemHtml = items
    .map(
      ([name, status]) => `
      <div class="item_3CiH98">
        <div class="name_3CiH98">${name}</div>
        <div class="status_3CiH98">${status}</div>
      </div>`,
    )
    .join("");
  const idAttr = id ? ` id="${id}"` : "";
  return `
    <div class="wrapper_2hnOFJ">
      <div class="title_2hnOFJ"${idAttr}>${label}</div>
      <div class="items_2hnOFJ">${itemHtml}</div>
    </div>`;
}

function metric(label: string, value: string): string {
  return `<div class="metric"><div>${label}</div><div>${value}</div></div>`;
}

function conditionRow(name: string): string {
  return `
    <div class="locationRow_1pp0Bo">
      <div class="locationTitle_1pp0Bo">${name}</div>
      <div class="temperature_1pp0Bo">-3°C</div>
      ${metric("Wind", "25 km/h")}
      ${metric("Snow Base", "120 cm")}
      ${metric("24 hr Snowfall", "5 cm")}
      ${metric("7 day Snowfall", "30 cm")}
    </div>`;
}

function buildHtml(
  sections: SectionSpec[],
  conditionNames: string[],
  trailsHtml = "",
): string {
  return `<!doctype html><html><body>
    <div class="areaTitle_3oPk4X">Bruce Road</div>
    <span class="open_3oPk4X">Open</span>
    <div class="wheelRequirements_3oPk4X">Chains must be carried</div>
    <div class="roadContent_3oPk4X">Sealed to the car park.</div>
    ${sections.map(section).join("")}
    ${conditionNames.map(conditionRow).join("")}
    ${trailsHtml}
  </body></html>`;
}

// The difficulty SVG markers exactly as the upstream report draws them: a green
// circle (id "green"), a blue square (id "blue"), an id-LESS black diamond path,
// and a red diamond drawn as diamond_left/diamond_right paths.
const DIFFICULTY_SVG: Record<string, string> = {
  beginner: '<svg viewBox="0 0 600 600"><circle id="green" cx="300" cy="300" r="250"/></svg>',
  intermediate:
    '<svg viewBox="0 0 600 600"><rect id="blue" x="66" y="66" width="472" height="472"/></svg>',
  advanced:
    '<svg viewBox="0 0 600 600"><path d="M300,575l275,-275l-275,-275l-275,275l275,275Z"/></svg>',
  expert:
    '<svg viewBox="0 0 600 600"><path id="diamond_left" d="M155,560l135,-260l-135,-260l-135,260l135,260Z"/><path id="diamond_right" d="M445,560l135,-260l-135,-260l-135,260l135,260Z"/></svg>',
};

type TrailSpec = {
  name: string;
  status: string;
  /** Difficulty the marker should encode: beginner|intermediate|advanced|expert. */
  grade: keyof typeof DIFFICULTY_SVG;
  subInfo: string;
  statusClass: string;
};

// Mirror the upstream Trails DOM: a `wrapper_` (lowercase w) section holding a
// `#trails` heading inside a `titleWrapper_` (capital W, so it is skipped by the
// wrapper selector), then collapsable sub-areas of items. Difficulty is a
// coloured SVG grade marker; groomed/size live in a subInfo line.
function trailsSection(areaName: string, trails: TrailSpec[]): string {
  const items = trails
    .map(
      (trail) => `
        <div class="item_3CiH98">
          <div class="iconWrapper_3CiH98">${DIFFICULTY_SVG[trail.grade]}</div>
          <div class="textWrapper_3CiH98">
            <div class="name_3CiH98">${trail.name}</div>
            <div class="subInfo_3CiH98">${trail.subInfo}</div>
          </div>
          <div class="status_3CiH98 ${trail.statusClass}">${trail.status}</div>
        </div>`,
    )
    .join("");
  return `
    <div class="wrapper_3WEWyU">
      <div class="titleWrapper_3WEWyU"><div id="trails" class="title_3WEWyU">Trails</div></div>
      <div class="collapsableSection_3WEWyU">
        <div class="title_3WEWyU">${areaName}</div>
        <div class="collapsableContent_3WEWyU">
          <div class="items_3WEWyU">${items}</div>
        </div>
      </div>
    </div>`;
}

function mockFetchHtml(
  html: string,
  init: { ok?: boolean; status?: number } = {},
) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      text: async () => html,
    }),
  );
}

type MockResponseSpec = {
  status?: number;
  html?: string;
  location?: string;
  /** JSON payload for the #45 /api/report fallback request. */
  json?: unknown;
};

/**
 * Queue of upstream responses, so a redirect chain can be exercised hop by hop.
 * Returns the fetch spy, which is what pins the request options (the SSRF fix
 * turns on `redirect: "manual"`, so its absence must fail a test).
 */
// The spy is typed with fetch's real argument tuple (and the stub's own return
// shape, which is not a full `Response`) so `mock.calls` carries those
// arguments: the assertions below read calls[n][0] (the URL) and calls[n][1]
// (the init, which is what carries `redirect: "manual"`). An argument-less mock
// types every call as an empty tuple and those reads stop compiling.
type MockFetchImpl = (...args: Parameters<typeof fetch>) => Promise<{
  ok: boolean;
  status: number;
  headers: Headers;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
  body: null;
}>;

function mockFetchSequence(responses: MockResponseSpec[]) {
  const queue = [...responses];
  const fetchMock = vi.fn<MockFetchImpl>(async () => {
    const next = queue.shift();
    if (!next) {
      throw new Error("fetch was called more times than the test queued");
    }
    const status = next.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(next.location ? { location: next.location } : {}),
      text: async () => next.html ?? "",
      json: async () => {
        if (next.json === undefined) {
          throw new Error("response has no JSON payload");
        }
        return next.json;
      },
      body: null,
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const CANONICAL_SECTIONS: SectionSpec[] = [
  { id: "facilities", label: "Facilities", items: [["Ticket Office", "Open"]] },
  {
    id: "food-drink",
    label: "Food & Drink",
    items: [["Knoll Ridge Cafe", "Closed"]],
  },
  { id: "lifts", label: "Lifts", items: [["Sky Waka", "Open"]] },
];


// One populated trails section for fixtures whose test is NOT about trails:
// with it present, the #45 JSON fallback stays dormant and call-count
// assertions keep measuring what their test names.
const TRAILS_PRESENT = trailsSection("Sky Waka Area", [
  {
    name: "Hut Flat",
    status: "Open",
    grade: "beginner",
    subInfo: "Groomed",
    statusClass: "open_3CiH98",
  },
]);

describe("fetchWhakapapaCurlData", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("parses road status, groups, and conditions from the report DOM", async () => {
    mockFetchHtml(buildHtml(CANONICAL_SECTIONS, ["Top of Waterfall"], TRAILS_PRESENT));

    const data = await fetchWhakapapaCurlData();

    expect(data.roadStatus).toEqual({
      name: "Bruce Road",
      status: "Open",
      wheelRequirements: "Chains must be carried",
      roadContent: "Sealed to the car park.",
    });
    expect(data.conditions).toEqual([
      {
        name: "Top of Waterfall",
        temperature: "-3°C",
        wind: "25 km/h",
        snowBase: "120 cm",
        snowfall24h: "5 cm",
        snowfall7d: "30 cm",
      },
    ]);
    // `updated` is stamped from the fetch time.
    expect(data.updated).not.toBe("");
  });

  it("routes the three groups by heading id", async () => {
    mockFetchHtml(buildHtml(CANONICAL_SECTIONS, [], TRAILS_PRESENT));

    const data = await fetchWhakapapaCurlData();

    expect(data.facilities).toEqual([{ name: "Ticket Office", status: "Open" }]);
    expect(data.foodAndDrink).toEqual([
      { name: "Knoll Ridge Cafe", status: "Closed" },
    ]);
    expect(data.lifts).toEqual([{ name: "Sky Waka", status: "Open" }]);
  });

  it("falls back to heading text when the upstream ids change (pins the fallback)", async () => {
    // Simulate an upstream markup change: the ids are renamed/removed but the
    // human-readable heading text is unchanged. Routing must still work so a
    // group is never silently dropped.
    const renamed: SectionSpec[] = [
      { id: "", label: "Facilities", items: [["Ticket Office", "Open"]] },
      {
        id: "group-2",
        label: "Food & Drink",
        items: [["Knoll Ridge Cafe", "Closed"]],
      },
      { id: "", label: "Lifts", items: [["Sky Waka", "Open"]] },
    ];
    mockFetchHtml(buildHtml(renamed, [], TRAILS_PRESENT));

    const data = await fetchWhakapapaCurlData();

    expect(data.facilities).toEqual([{ name: "Ticket Office", status: "Open" }]);
    expect(data.foodAndDrink).toEqual([
      { name: "Knoll Ridge Cafe", status: "Closed" },
    ]);
    expect(data.lifts).toEqual([{ name: "Sky Waka", status: "Open" }]);
  });

  it("ignores groups whose id and text both fail to match a known group", async () => {
    const unknown: SectionSpec[] = [
      { id: "weather", label: "Weather", items: [["Cloud", "High"]] },
      { id: "lifts", label: "Lifts", items: [["Sky Waka", "Open"]] },
    ];
    mockFetchHtml(buildHtml(unknown, [], TRAILS_PRESENT));

    const data = await fetchWhakapapaCurlData();

    expect(data.facilities).toEqual([]);
    expect(data.foodAndDrink).toEqual([]);
    expect(data.lifts).toEqual([{ name: "Sky Waka", status: "Open" }]);
  });

  it("drops condition rows without a name and returns '' for absent metrics", async () => {
    const html = `<!doctype html><html><body>
      <div class="locationRow_1pp0Bo">
        <div class="locationTitle_1pp0Bo">Top</div>
        ${metric("Wind", "10 km/h")}
      </div>
      <div class="locationRow_1pp0Bo">
        <div class="locationTitle_1pp0Bo"></div>
        ${metric("Wind", "40 km/h")}
      </div>
      ${TRAILS_PRESENT}
    </body></html>`;
    mockFetchHtml(html);

    const data = await fetchWhakapapaCurlData();

    expect(data.conditions).toEqual([
      {
        name: "Top",
        temperature: "",
        wind: "10 km/h",
        snowBase: "",
        snowfall24h: "",
        snowfall7d: "",
      },
    ]);
  });

  it("still parses after the upstream style-name hashes rotate (resilience)", async () => {
    // The upstream site is CSS-modules: every class carries a build-hash suffix
    // that rotates on each deploy (e.g. `areaTitle_3oPk4X` -> `areaTitle_4xD33B`),
    // which is what repeatedly broke the scraper. The hash-agnostic selectors
    // must match on the stable prefix regardless of the suffix.
    const rotated = buildHtml(CANONICAL_SECTIONS, ["Top of Waterfall"], TRAILS_PRESENT)
      .replace(/_3CiH98/g, "_9aa11Z")
      .replace(/_3oPk4X/g, "_4xD33B")
      .replace(/_2hnOFJ/g, "_kk22QQ")
      .replace(/_1pp0Bo/g, "_zz99PP");
    mockFetchHtml(rotated);

    const data = await fetchWhakapapaCurlData();

    expect(data.roadStatus.name).toBe("Bruce Road");
    expect(data.roadStatus.status).toBe("Open");
    expect(data.roadStatus.wheelRequirements).toBe("Chains must be carried");
    expect(data.facilities).toEqual([{ name: "Ticket Office", status: "Open" }]);
    expect(data.lifts).toEqual([{ name: "Sky Waka", status: "Open" }]);
    expect(data.conditions[0]?.name).toBe("Top of Waterfall");
  });

  it("parses trails grouped by sub-area with difficulty, groomed, and size", async () => {
    const trails = trailsSection("Happy Valley Area", [
      {
        name: "Happy Valley",
        status: "Open",
        grade: "beginner", // green circle
        subInfo: "Groomed",
        statusClass: "open_3CiH98",
      },
      {
        name: "Tennants Valley",
        status: "Coming Soon",
        grade: "advanced", // id-less black diamond path
        subInfo: "Ungroomed",
        statusClass: "inactive_3CiH98",
      },
      {
        name: "Big Park",
        status: "Open",
        grade: "intermediate", // blue square
        subInfo: "Groomed - Large",
        statusClass: "open_3CiH98",
      },
      {
        name: "Waterfall",
        status: "Coming Soon",
        grade: "expert", // red diamond (diamond_left/diamond_right paths)
        subInfo: "Ungroomed",
        statusClass: "inactive_3CiH98",
      },
    ]);
    mockFetchHtml(buildHtml(CANONICAL_SECTIONS, [], trails));

    const data = await fetchWhakapapaCurlData();

    expect(data.trails).toEqual([
      {
        name: "Happy Valley Area",
        trails: [
          {
            name: "Happy Valley",
            status: "Open",
            groomed: true,
            difficulty: "Beginner",
            size: "",
          },
          {
            name: "Tennants Valley",
            status: "Coming Soon",
            groomed: false,
            difficulty: "Advanced",
            size: "",
          },
          {
            name: "Big Park",
            status: "Open",
            groomed: true,
            difficulty: "Intermediate",
            size: "Large",
          },
          {
            name: "Waterfall",
            status: "Coming Soon",
            groomed: false,
            difficulty: "Expert",
            size: "",
          },
        ],
      },
    ]);
    // The road-status open badge must not swallow a trail's `open_` status class.
    expect(data.roadStatus.status).toBe("Open");
  });

  it("throws when the upstream response is not ok", async () => {
    mockFetchHtml("<html></html>", { ok: false, status: 503 });
    await expect(fetchWhakapapaCurlData()).rejects.toThrow(/status 503/);
  });

  it("throws when the upstream response body is empty", async () => {
    mockFetchHtml("   ", { ok: true, status: 200 });
    await expect(fetchWhakapapaCurlData()).rejects.toThrow(
      /Whakapapa report fetch failed/,
    );
  });
});

// #2841 (CodeQL js/request-forgery, alert 29). The host allowlist used to be
// applied to the FIRST url only: `fetch` defaults to `redirect: "follow"`, so
// after a 30x the upstream server chose the destination. This response is cached
// and served publicly from /api/skifield-whakapapa, so that is a readable SSRF,
// not a blind one. Every hop is now re-validated against the same allowlist.
describe("fetchWhakapapaCurlData redirect handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("never lets the upstream follow redirects for us", async () => {
    const fetchMock = mockFetchSequence([
      {
        status: 200,
        html: buildHtml(CANONICAL_SECTIONS, ["Top of Waterfall"], TRAILS_PRESENT),
      },
    ]);

    await fetchWhakapapaCurlData();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      redirect: "manual",
    });
  });

  it("follows a redirect that stays on an allowlisted host", async () => {
    const fetchMock = mockFetchSequence([
      { status: 301, location: "https://www.snow.nz/report" },
      {
        status: 200,
        html: buildHtml(CANONICAL_SECTIONS, ["Top of Waterfall"], TRAILS_PRESENT),
      },
    ]);

    const data = await fetchWhakapapaCurlData();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://www.snow.nz/report");
    expect(data.lifts).toEqual([{ name: "Sky Waka", status: "Open" }]);
  });

  it("resolves a relative redirect against the hop that issued it", async () => {
    const fetchMock = mockFetchSequence([
      { status: 302, location: "/report/summer" },
      { status: 200, html: buildHtml(CANONICAL_SECTIONS, ["Top of Waterfall"]) },
    ]);

    await fetchWhakapapaCurlData();

    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://www.whakapapa.com/report/summer",
    );
  });

  it("refuses a redirect to a host outside the allowlist, and does not fetch it", async () => {
    const fetchMock = mockFetchSequence([
      { status: 302, location: "http://169.254.169.254/latest/meta-data/" },
    ]);

    await expect(fetchWhakapapaCurlData()).rejects.toThrow(
      /redirect refused/i,
    );
    // The decisive assertion: the second request never happens.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a protocol-relative redirect that swaps the host", async () => {
    const fetchMock = mockFetchSequence([
      { status: 302, location: "//evil.example.com/report" },
    ]);

    await expect(fetchWhakapapaCurlData()).rejects.toThrow(
      /redirect refused/i,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a lookalike host that only suffixes an allowlisted one", async () => {
    const fetchMock = mockFetchSequence([
      { status: 302, location: "https://evilwhakapapa.com/report" },
    ]);

    await expect(fetchWhakapapaCurlData()).rejects.toThrow(
      /redirect refused/i,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect with no Location header", async () => {
    mockFetchSequence([{ status: 302 }]);

    await expect(fetchWhakapapaCurlData()).rejects.toThrow(
      /redirect refused/i,
    );
  });

  it("gives up on a redirect loop rather than looping forever", async () => {
    const fetchMock = mockFetchSequence(
      Array.from({ length: 6 }, () => ({
        status: 302,
        location: "https://www.whakapapa.com/report",
      })),
    );

    await expect(fetchWhakapapaCurlData()).rejects.toThrow(
      /exceeded 3 redirects/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe("findInvalidSelectorOverrides", () => {
  it("flags a selector that throws in the scraper engine (querySelector)", () => {
    // A syntactically valid CSS selector compiles; a malformed one throws when
    // the scraper calls querySelector — which is exactly what this reports.
    const invalid = findInvalidSelectorOverrides({
      item: '[class*="item_"]', // valid
      itemName: "[[not-a-selector", // malformed -> throws
      itemStatus: "div > :::bad", // malformed -> throws
    });
    expect(invalid).toEqual(["itemName", "itemStatus"]);
  });

  it("ignores blank overrides and the non-selector trailsHeadingId", () => {
    const invalid = findInvalidSelectorOverrides({
      item: "   ", // blank -> skipped (falls back to default)
      trailsHeadingId: "!!! not a css selector but a plain id", // getElementById, not compiled
    });
    expect(invalid).toEqual([]);
  });

  it("returns [] for no overrides", () => {
    expect(findInvalidSelectorOverrides({})).toEqual([]);
    expect(findInvalidSelectorOverrides(null)).toEqual([]);
  });
});


// ---------------------------------------------------------------------------
// Fork #45 — trails from the upstream /api/report JSON when the DOM has none.
// Whakapapa's collapsible-UI update ships the Trails sections as EMPTY Lit
// placeholders, so the scraper reads the same JSON the page renders from.
// ---------------------------------------------------------------------------

// XML-shaped JSON exactly as the live endpoint serves it: a single child is
// an OBJECT (Happy Valley's one trail), several are an ARRAY.
const REPORT_API_PAYLOAD = {
  whakapapa: {
    name: "Whakapapa",
    facilities: {
      areas: {
        area: [
          {
            name: "Happy Valley Area",
            trails: {
              trail: {
                name: "Happy Valley",
                status: "Open",
                comment: "",
                groomed: "yes",
                difficulty: "beginner",
              },
            },
          },
          {
            name: "Sky Waka Area",
            trails: {
              trail: [
                {
                  name: "Hut Flat",
                  status: "Open",
                  groomed: "yes",
                  difficulty: "intermediate",
                },
                {
                  name: "Broken Leg Gully",
                  status: "Closed",
                  groomed: "no",
                  difficulty: "expert",
                },
              ],
            },
          },
          { name: "Empty Area", trails: {} },
        ],
      },
    },
  },
};

describe("fetchWhakapapaCurlData trails JSON fallback (#45)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps the payload's areas, coercing one-or-many and the vocabulary", () => {
    expect(mapWhakapapaReportApiTrailAreas(REPORT_API_PAYLOAD)).toEqual([
      {
        name: "Happy Valley Area",
        trails: [
          {
            name: "Happy Valley",
            status: "Open",
            groomed: true,
            difficulty: "Beginner",
            size: "",
          },
        ],
      },
      {
        name: "Sky Waka Area",
        trails: [
          {
            name: "Hut Flat",
            status: "Open",
            groomed: true,
            difficulty: "Intermediate",
            size: "",
          },
          {
            name: "Broken Leg Gully",
            status: "Closed",
            groomed: false,
            difficulty: "Expert",
            size: "",
          },
        ],
      },
    ]);
  });

  it("maps an UNRECOGNISED difficulty word to \"\", matching the DOM path", () => {
    // parseTrailDifficulty returns "" for anything outside its vocabulary; the
    // widget renders a bare separator for any truthy difficulty, so the JSON
    // path must degrade identically (review item 3).
    const areas = mapWhakapapaReportApiTrailAreas({
      whakapapa: {
        facilities: {
          areas: {
            area: {
              name: "New Area",
              trails: { trail: { name: "New Trail", status: "Open", difficulty: "gnarly" } },
            },
          },
        },
      },
    });
    expect(areas[0]?.trails[0]?.difficulty).toBe("");
  });

  it("finds the resort node by its facilities key, not by position", () => {
    // A sibling object key ordered before the resort key must not empty the
    // trails (review item 5).
    const areas = mapWhakapapaReportApiTrailAreas({
      meta: { generated: "2026-08-27" },
      whakapapa: {
        facilities: {
          areas: {
            area: {
              name: "Delta Area",
              trails: { trail: { name: "Delta", status: "Open", difficulty: "expert" } },
            },
          },
        },
      },
    });
    expect(areas).toEqual([
      {
        name: "Delta Area",
        trails: [
          { name: "Delta", status: "Open", groomed: false, difficulty: "Expert", size: "" },
        ],
      },
    ]);
  });

  it("returns [] for junk payloads rather than throwing", () => {
    expect(mapWhakapapaReportApiTrailAreas(null)).toEqual([]);
    expect(mapWhakapapaReportApiTrailAreas("nope")).toEqual([]);
    expect(mapWhakapapaReportApiTrailAreas({ whakapapa: { facilities: 3 } })).toEqual([]);
  });

  it("falls back to /api/report when the DOM carries no trails, with the SSRF options pinned", async () => {
    const fetchMock = mockFetchSequence([
      { status: 200, html: buildHtml(CANONICAL_SECTIONS, ["Top of Waterfall"]) },
      { status: 200, json: REPORT_API_PAYLOAD },
    ]);

    const data = await fetchWhakapapaCurlData();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://www.whakapapa.com/api/report",
    );
    // The fallback rides the SAME allowlisted fetcher: manual redirects, or
    // an upstream 30x could point this cached, publicly-served read anywhere.
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ redirect: "manual" });
    // The API hop asks for JSON: the page-fetch Accept ranks XML above the
    // wildcard, and a backend honouring it would break .json() (review item 1).
    expect(
      (fetchMock.mock.calls[1]?.[1] as { headers: Record<string, string> })
        .headers.Accept,
    ).toBe("application/json");
    expect(data.trails.map((area) => area.name)).toEqual([
      "Happy Valley Area",
      "Sky Waka Area",
    ]);
    // The rest of the report still comes from the DOM parse.
    expect(data.lifts).toEqual([{ name: "Sky Waka", status: "Open" }]);
  });

  it("does NOT call the JSON endpoint when the DOM already has trails", async () => {
    const fetchMock = mockFetchSequence([
      {
        status: 200,
        html: buildHtml(CANONICAL_SECTIONS, ["Top of Waterfall"], TRAILS_PRESENT),
      },
    ]);

    const data = await fetchWhakapapaCurlData();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(data.trails).toHaveLength(1);
  });

  it("degrades to a trail-less report when the JSON endpoint fails, keeping everything else", async () => {
    const fetchMock = mockFetchSequence([
      { status: 200, html: buildHtml(CANONICAL_SECTIONS, ["Top of Waterfall"]) },
      { status: 503 },
    ]);

    const data = await fetchWhakapapaCurlData();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(data.trails).toEqual([]);
    expect(data.lifts).toEqual([{ name: "Sky Waka", status: "Open" }]);
    expect(data.conditions).toHaveLength(1);
  });
});
