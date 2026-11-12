import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Mutable identity state so URL-token tests can vary the configured values;
// getters make the mocked module read the current state on every access.
// `facebookUrl` here is the DB-set value surfaced through getClubIdentity() —
// the {{facebook-url}} token now resolves DB-first (C5 #1984), NOT from the
// static CLUB_FACEBOOK_URL config constant (kept below only to prove the token
// no longer reads it). `publicUrl` is the fallback the token uses when no
// facebook link is configured — as of C6 #1985 that too comes from the resolved
// getClubIdentity().publicUrl (the bootstrap origin), NOT a static config const.
const identityState = vi.hoisted(() => ({
  facebookUrl: undefined as string | undefined,
  publicUrl: "https://club.example.org",
}));

vi.mock("@/config/club-identity", () => ({
  CLUB_NAME: "Club <Name>",
  // A distinct sentinel: the token must NOT read this static constant anymore.
  CLUB_FACEBOOK_URL: "https://config-only.example/should-not-appear",
}));
// {{club-name}}/{{hut-leader}}/{{facebook-url}} now resolve DB-first via
// getClubIdentity (E3 #1929, C5 #1984, C6 #1985). socialLinks.facebook mirrors
// the DB row; publicUrl is the resolved bootstrap origin used as the token's
// last-resort URL fallback.
vi.mock("@/lib/club-identity-settings", () => ({
  getClubIdentity: vi.fn(async () => ({
    name: "Club <Name>",
    hutLeaderLabel: "Hut Leader",
    publicUrl: identityState.publicUrl,
    socialLinks: identityState.facebookUrl
      ? { facebook: identityState.facebookUrl }
      : {},
  })),
}));
vi.mock("@/lib/lodge-capacity", () => ({
  getDefaultLodgeCapacity: vi.fn(async () => 42),
  getLodgeCapacity: vi.fn(async (lodgeId: string) =>
    lodgeId === "lodge-2" ? 18 : 0,
  ),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    lodge: {
      findUnique: vi.fn(async ({ where }: { where: { slug: string } }) =>
        where.slug === "river-lodge" ? { id: "lodge-2" } : null,
      ),
    },
  },
}));
vi.mock("@/lib/club-format-server", async () => {
  const { bindClubFormat } = await import("@/lib/club-format-bound");
  const { CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture");
  return {
    clubFormatValues: vi.fn(async () => CLUB_FORMAT_TEST),
    clubFormat: vi.fn(async () => bindClubFormat(CLUB_FORMAT_TEST)),
  };
});
vi.mock("@/lib/public-first-year-costs", () => ({
  loadPublicFirstYearCosts: vi.fn(async (_format: unknown, options?: { typeKey?: string }) => [
    { heading: "Joining fee plus first year's subscription", rows: [{ label: options?.typeKey ?? "all", fee: { amountCents: 50000, label: "$500.00" } }] },
  ]),
}));
vi.mock("@/lib/public-page-content-tokens", () => ({
  loadPublicAnnualFees: vi.fn(async () => [{ heading: "Annual membership fees", rows: [{ label: "Public member", fee: { amountCents: 1000, label: "$10.00" } }] }]),
  loadPublicJoiningFees: vi.fn(async () => [{ heading: "Adult", rows: [] }]),
  loadPublicHutFees: vi.fn(async (_format: unknown, slug?: string) => [{ heading: slug ?? "all", rowHeading: "Age", columns: [], rows: [] }]),
  loadPublicBookingPolicy: vi.fn(async (slug?: string) => ({ lodge: slug ?? null })),
  loadPublicCancellationPolicy: vi.fn(async (_format: unknown, slug?: string) => ({ lodge: slug ?? null })),
}));
// sanitizePageContentHtml is pure but its module imports the prisma client.

import {
  buildEmbeddedBody,
  deriveAltFromImageSrc,
  resolveTextTokens,
} from "../page-content-embeds";
import { sanitizePageContentHtml } from "../page-content-html";
import { starterSiteContent } from "../../../prisma/starter-site-content";
import logger from "@/lib/logger";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { writeImageDerivatives } from "@/lib/image-derivatives";
import { IMAGES_ROOT, IMAGE_DERIVATIVES_DIRECTORY } from "@/lib/image-storage";

describe("buildEmbeddedBody", () => {
  it("maps every public data token, including lodge variants, through the shared registry", async () => {
    const parts = await buildEmbeddedBody(
      "<p>Start</p>{{membership-types}}{{entrance-fees}}{{hut-fees}}{{hut-fees:river-lodge}}{{booking-policy-summary}}{{booking-policy-summary:river-lodge}}{{cancellation-policy}}{{cancellation-policy:river-lodge}}<p>End</p>",
    );
    // {{membership-types}} and {{entrance-fees}} are deprecated aliases (#1933,
    // E7) that resolve to the annual-fees and joining-fees parts respectively.
    expect(parts.map((part) => part.type)).toEqual([
      "html", "annual-fees", "joining-fees", "hut-fees", "hut-fees",
      "booking-policy-summary", "booking-policy-summary", "cancellation-policy",
      "cancellation-policy", "html",
    ]);
    // The positional back-compat slug still flows to loadPublicHutFees.
    expect(parts[4]).toEqual({
      type: "hut-fees",
      tables: [{ heading: "river-lodge", rowHeading: "Age", columns: [], rows: [] }],
    });
  });

  it("preserves mixed rich HTML and repeated tokens without falling back to contact form", async () => {
    const parts = await buildEmbeddedBody("<h2>Fees</h2>{{entrance-fees}}<p>Again</p>{{entrance-fees}}");
    expect(parts.map((part) => part.type)).toEqual(["html", "joining-fees", "html", "joining-fees"]);
    expect(parts.some((part) => part.type === "contact-form")).toBe(false);
  });
  it("preserves inline images when no gallery token is present", async () => {
    const parts = await buildEmbeddedBody(
      '<div class="col_display_body"><p><img src="/api/images/uploaded/Lodge_Winter.jpg" width="463" height="169" /><br></p><p>Our Ski Lodge is located on Mt Ruapehu on the Whakapapa ski field, just 5 minutes from the top overnight carpark.</p></div>',
    );

    expect(parts).toEqual([
      {
        type: "html",
        value:
          '<div class="col_display_body"><p><img src="/api/images/uploaded/Lodge_Winter.jpg" width="463" height="169" /><br></p><p>Our Ski Lodge is located on Mt Ruapehu on the Whakapapa ski field, just 5 minutes from the top overnight carpark.</p></div>',
      },
    ]);
  });

  it("extracts inline images for gallery tokens", async () => {
    const parts = await buildEmbeddedBody(
      '<p>Before</p><img src="/api/images/uploaded/gallery.jpg" alt="Gallery image" width="640" height="480" />{{photo-gallery}}<p>After</p>',
    );

    expect(parts).toEqual([
      { type: "html", value: "<p>Before</p>" },
      {
        type: "photo-gallery",
        images: [
          {
            src: "/api/images/uploaded/gallery.jpg",
            alt: "Gallery image",
            width: 640,
            height: 480,
          },
        ],
      },
      { type: "html", value: "<p>After</p>" },
    ]);
  });

  it("extracts inline images for slideshow tokens", async () => {
    const parts = await buildEmbeddedBody(
      '<p>Before</p><img src="/api/images/uploaded/slideshow.jpg" alt="Slideshow image" width="800" height="600" />{{photo-slideshow}}',
    );

    expect(parts).toEqual([
      { type: "html", value: "<p>Before</p>" },
      {
        type: "photo-slideshow",
        images: [
          {
            src: "/api/images/uploaded/slideshow.jpg",
            alt: "Slideshow image",
            width: 800,
            height: 600,
          },
        ],
      },
    ]);
  });

  it("backfills a filename-derived alt for gallery images with no alt attribute (#1947)", async () => {
    const parts = await buildEmbeddedBody(
      '<p>Before</p><img src="/api/images/uploaded/Lodge_Winter-Sunset.jpg" width="640" height="480" />{{photo-gallery}}',
    );

    expect(parts).toEqual([
      { type: "html", value: "<p>Before</p>" },
      {
        type: "photo-gallery",
        images: [
          {
            src: "/api/images/uploaded/Lodge_Winter-Sunset.jpg",
            alt: "Lodge Winter Sunset",
            width: 640,
            height: 480,
          },
        ],
      },
    ]);
  });

  it("preserves an explicit empty alt (decorative marker) on gallery images (#1947)", async () => {
    const parts = await buildEmbeddedBody(
      '<p>Before</p><img src="/api/images/uploaded/gallery.jpg" alt="" width="640" height="480" />{{photo-gallery}}',
    );

    expect(parts).toEqual([
      { type: "html", value: "<p>Before</p>" },
      {
        type: "photo-gallery",
        images: [
          { src: "/api/images/uploaded/gallery.jpg", alt: "", width: 640, height: 480 },
        ],
      },
    ]);
  });

  it("leaves the alt empty for a base64 data: gallery image with no alt (#1947)", async () => {
    const parts = await buildEmbeddedBody(
      '<p>Before</p><img src="data:image/png;base64,iVBORw0KGgoAAAANSU" width="10" height="10" />{{photo-gallery}}',
    );

    expect(parts).toEqual([
      { type: "html", value: "<p>Before</p>" },
      {
        type: "photo-gallery",
        images: [
          { src: "data:image/png;base64,iVBORw0KGgoAAAANSU", alt: "", width: 10, height: 10 },
        ],
      },
    ]);
  });

  it("does not activate single-brace photo gallery tokens", async () => {
    const contentHtml =
      '<p>Before</p><img src="/api/images/uploaded/gallery.jpg" alt="Gallery image" width="640" height="480" />{photo-gallery}<p>After</p>';

    const parts = await buildEmbeddedBody(contentHtml);

    expect(parts).toEqual([{ type: "html", value: contentHtml }]);
  });

  it("does not activate single-brace photo slideshow tokens", async () => {
    const contentHtml =
      '<p>Before</p><img src="/api/images/uploaded/slideshow.jpg" alt="Slideshow image" width="800" height="600" />{photo-slideshow}<p>After</p>';

    const parts = await buildEmbeddedBody(contentHtml);

    expect(parts).toEqual([{ type: "html", value: contentHtml }]);
  });

  it("keeps legacy single-brace non-photo tokens working", async () => {
    const parts = await buildEmbeddedBody(
      "<p>Before</p>{contact-form}<p>After</p>",
    );

    expect(parts).toEqual([
      { type: "html", value: "<p>Before</p>" },
      { type: "contact-form" },
      { type: "html", value: "<p>After</p>" },
    ]);
  });

  it("resolves live text tokens as escaped html", async () => {
    const parts = await buildEmbeddedBody(
      "<p>{{club-name}} sleeps {{lodge-capacity}} and charges {{currency}}.</p>",
    );

    expect(parts).toEqual([
      {
        type: "html",
        // `{{currency}}` is the club's STORED code since #3565 (the `club-format-server`
        // mock above), not the environment's; a validated ISO 4217 code can never
        // carry a character that needs escaping, so the escaping proof on this line
        // is the club name's.
        value: "<p>Club &lt;Name&gt; sleeps 42 and charges NZD.</p>",
      },
    ]);
  });

  it("resolves {{lodge-capacity:slug}} against the named lodge", async () => {
    const parts = await buildEmbeddedBody(
      "<p>River sleeps {{lodge-capacity:river-lodge}}; main lodge {{lodge-capacity}}.</p>",
    );

    expect(parts).toEqual([
      { type: "html", value: "<p>River sleeps 18; main lodge 42.</p>" },
    ]);
  });

  it("falls back to the default lodge for an unknown slug", async () => {
    const parts = await buildEmbeddedBody(
      "<p>Sleeps {{lodge-capacity:no-such-lodge}}.</p>",
    );

    expect(parts).toEqual([{ type: "html", value: "<p>Sleeps 42.</p>" }]);
  });
});

describe("{{first-year-costs}} embed (#4295)", () => {
  it("resolves to its own part and passes the type parameter to the loader", async () => {
    const parts = await buildEmbeddedBody("<p>Cost</p>{{first-year-costs:type=family}}<p>End</p>");
    expect(parts.map((part) => part.type)).toEqual(["html", "first-year-costs", "html"]);
    expect(parts[1]).toEqual({
      type: "first-year-costs",
      groups: [{ heading: "Joining fee plus first year's subscription", rows: [{ label: "family", fee: { amountCents: 50000, label: "$500.00" } }] }],
    });
  });
});

describe("fee-embed block placement contract (D-R8, #1933)", () => {
  it("renders a fee block before all other content", async () => {
    const parts = await buildEmbeddedBody("{{annual-fees}}<p>Body</p>");
    expect(parts.map((part) => part.type)).toEqual(["annual-fees", "html"]);
  });

  it("renders a fee block between two paragraphs, preserving document order", async () => {
    const parts = await buildEmbeddedBody("<p>Before</p>{{annual-fees}}<p>After</p>");
    expect(parts.map((part) => part.type)).toEqual(["html", "annual-fees", "html"]);
    expect(parts[0]).toEqual({ type: "html", value: "<p>Before</p>" });
    expect(parts[2]).toEqual({ type: "html", value: "<p>After</p>" });
  });

  it("renders multiple fee blocks on one page, each independently, in token order", async () => {
    const parts = await buildEmbeddedBody("{{joining-fees}}<p>Mid</p>{{annual-fees}}<p>End</p>{{hut-fees}}");
    expect(parts.map((part) => part.type)).toEqual([
      "joining-fees", "html", "annual-fees", "html", "hut-fees",
    ]);
  });

  it("splits a fee token placed mid-paragraph into repaired HTML fragments around the block", async () => {
    // buildEmbeddedBody splits at the token, so the surrounding <p> is emitted
    // as two unbalanced fragments (opening then closing). Each is rendered via
    // dangerouslySetInnerHTML, and the browser repairs the fragments; the block
    // itself still renders in document order between them.
    const parts = await buildEmbeddedBody("<p>Fees: {{annual-fees}} shown here</p>");
    expect(parts.map((part) => part.type)).toEqual(["html", "annual-fees", "html"]);
    expect(parts[0]).toEqual({ type: "html", value: "<p>Fees: " });
    expect(parts[2]).toEqual({ type: "html", value: " shown here</p>" });
  });
});

describe("deprecated fee-token aliases render identically (#1933)", () => {
  it("{{entrance-fees}} resolves to the same part as {{joining-fees}}", async () => {
    const alias = await buildEmbeddedBody("{{entrance-fees}}");
    const canonical = await buildEmbeddedBody("{{joining-fees}}");
    expect(alias).toEqual(canonical);
    expect(alias[0].type).toBe("joining-fees");
  });

  it("{{membership-types}} resolves to the same part as {{annual-fees}}", async () => {
    const alias = await buildEmbeddedBody("{{membership-types}}");
    const canonical = await buildEmbeddedBody("{{annual-fees}}");
    expect(alias).toEqual(canonical);
    expect(alias[0].type).toBe("annual-fees");
  });
});

describe("resolveTextTokens URL scheme validation", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    identityState.facebookUrl = undefined;
    identityState.publicUrl = "https://club.example.org";
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("passes an http(s) facebook URL through unchanged", async () => {
    identityState.facebookUrl = "https://www.facebook.com/exampleclub";

    const resolved = await resolveTextTokens(
      '<a href="{{facebook-url}}">Facebook</a>',
      CLUB_FORMAT_TEST,
    );

    expect(resolved).toBe(
      '<a href="https://www.facebook.com/exampleclub">Facebook</a>',
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("prefers the DB-set facebook URL over the static config constant", async () => {
    identityState.facebookUrl = "https://www.facebook.com/db-club";

    const resolved = await resolveTextTokens(
      '<a href="{{facebook-url}}">Facebook</a>',
      CLUB_FORMAT_TEST,
    );

    expect(resolved).toBe(
      '<a href="https://www.facebook.com/db-club">Facebook</a>',
    );
    // Proves the token no longer sources CLUB_FACEBOOK_URL (the config mock's
    // sentinel value must never appear).
    expect(resolved).not.toContain("config-only.example");
  });

  it("passes a mailto value through unchanged", async () => {
    identityState.facebookUrl = "mailto:social@example.org";

    const resolved = await resolveTextTokens(
      '<a href="{{facebook-url}}">Contact</a>',
      CLUB_FORMAT_TEST,
    );

    expect(resolved).toBe('<a href="mailto:social@example.org">Contact</a>');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("falls back to the public URL when no facebook URL is configured", async () => {
    const resolved = await resolveTextTokens(
      '<a href="{{facebook-url}}">Facebook</a>',
      CLUB_FORMAT_TEST,
    );

    expect(resolved).toBe(
      '<a href="https://club.example.org">Facebook</a>',
    );
  });

  it("replaces a javascript: facebook URL with the public URL and warns once", async () => {
    identityState.facebookUrl = "javascript:alert(document.cookie)";

    const first = await resolveTextTokens(
      '<a href="{{facebook-url}}">Facebook</a>',
      CLUB_FORMAT_TEST,
    );
    const second = await resolveTextTokens(
      '<a href="{{facebook-url}}">Facebook</a>',
      CLUB_FORMAT_TEST,
    );

    expect(first).toBe('<a href="https://club.example.org">Facebook</a>');
    expect(second).toBe(first);
    expect(first).not.toContain("javascript:");
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back to # when the public URL is also unsafe", async () => {
    identityState.facebookUrl = "javascript:void(0)";
    identityState.publicUrl = "javascript:bad()";

    const resolved = await resolveTextTokens(
      '<a href="{{facebook-url}}">Facebook</a>',
      CLUB_FORMAT_TEST,
    );

    expect(resolved).toBe('<a href="#">Facebook</a>');
    expect(resolved).not.toContain("javascript:");
  });

  it("never renders a javascript: href through the footer path", async () => {
    identityState.facebookUrl = "javascript:alert(1)";
    // The starter affiliations column carried this markup until #2490 emptied
    // it (a fresh install now lists no affiliations), so the stored HTML an
    // admin writes stands in for it here — the render path is what is under
    // test, and {{facebook-url}} is still offered to admins as a footer token.
    const storedFooterHtml =
      '<h3>Affiliations</h3><ul><li><a href="{{facebook-url}}" target="_blank" rel="noopener noreferrer">Facebook</a></li></ul>';

    // Mirrors renderFooterSection in site-content.ts: sanitise the stored
    // HTML first, then resolve text tokens on the sanitised output.
    const sanitised = sanitizePageContentHtml(storedFooterHtml);
    const resolved = await resolveTextTokens(sanitised, CLUB_FORMAT_TEST);

    expect(resolved).not.toContain("javascript:");
    expect(resolved).toContain('href="https://club.example.org"');
  });

  it("has no token left to resolve in the starter footer sections (#2490)", async () => {
    // The seed ships no affiliations at all now, so nothing in the starter
    // footer resolves a URL-bearing token on a fresh install.
    for (const section of starterSiteContent) {
      const resolved = await resolveTextTokens(
        sanitizePageContentHtml(section.contentHtml),
        CLUB_FORMAT_TEST,
      );
      expect(resolved).not.toContain("{{");
      expect(resolved).not.toMatch(/RMCA|Ruapehu|Federated Mountain Clubs/i);
    }
  });
});

describe("deriveAltFromImageSrc (#1947)", () => {
  it("humanises a path-based image filename", () => {
    expect(deriveAltFromImageSrc("/api/images/uploaded/Lodge_Winter.jpg")).toBe(
      "Lodge Winter",
    );
    expect(deriveAltFromImageSrc("/images/mt-ruapehu-sunset.PNG")).toBe(
      "mt ruapehu sunset",
    );
  });

  it("strips query and hash before deriving the name", () => {
    expect(deriveAltFromImageSrc("/images/gallery.webp?v=3#frag")).toBe("gallery");
  });

  it("decodes percent-encoded filenames", () => {
    expect(deriveAltFromImageSrc("/images/Whakapapa%20Lodge.jpg")).toBe(
      "Whakapapa Lodge",
    );
  });

  it("returns empty for a base64 data: URI (no filename to derive)", () => {
    expect(
      deriveAltFromImageSrc("data:image/png;base64,iVBORw0KGgoAAAANSU"),
    ).toBe("");
  });
});

// #4935 (INV-PUB-004): a directory gallery lists real files, so these use a
// unique folder under the real (gitignored) images root and remove it after.
describe("{{photo-gallery: <folder>}} website-sized copies (#4935)", () => {
  const folder = `vitest-gallery-${process.pid}`;
  const absDir = path.join(IMAGES_ROOT, folder);

  beforeEach(async () => {
    await fs.mkdir(absDir, { recursive: true });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(absDir, { recursive: true, force: true });
  });

  async function store(name: string, width: number, height: number) {
    const bytes = await sharp({
      create: { width, height, channels: 3, background: "#335577" },
    })
      .jpeg()
      .toBuffer();
    await fs.writeFile(path.join(absDir, name), bytes);
    return bytes;
  }

  async function galleryImages() {
    const parts = await buildEmbeddedBody(`{{photo-gallery: ${folder}}}`);
    expect(parts).toHaveLength(1);
    const [part] = parts;
    if (part?.type !== "photo-gallery") throw new Error("expected a gallery");
    return part.images;
  }

  it("lists each photo's current copies with their own dimensions, and never a copy as a photo", async () => {
    const bytes = await store("lodge.jpg", 2000, 1500);
    await writeImageDerivatives(bytes, absDir, "lodge.jpg");
    await store("small.jpg", 300, 200);

    const images = await galleryImages();
    expect(images.map((image) => image.alt)).toEqual(["lodge.jpg", "small.jpg"]);
    const base = `/api/images/uploaded/${folder}`;
    expect(images[0]).toEqual({
      src: `${base}/lodge.jpg`,
      alt: "lodge.jpg",
      width: 2000,
      height: 1500,
      copies: [
        { src: `${base}/${IMAGE_DERIVATIVES_DIRECTORY}/lodge.jpg.400.webp`, width: 400, height: 300 },
        { src: `${base}/${IMAGE_DERIVATIVES_DIRECTORY}/lodge.jpg.800.webp`, width: 800, height: 600 },
        { src: `${base}/${IMAGE_DERIVATIVES_DIRECTORY}/lodge.jpg.1600.webp`, width: 1600, height: 1200 },
      ],
    });
    // No copies, no `copies` key: the gallery renders the original as before.
    expect(images[1]).toEqual({
      src: `${base}/small.jpg`,
      alt: "small.jpg",
      width: 300,
      height: 200,
    });
  });

  it("ignores copies older than their original (replaced by code that made none)", async () => {
    const bytes = await store("lodge.jpg", 2000, 1500);
    await writeImageDerivatives(bytes, absDir, "lodge.jpg");
    const copy = await fs.stat(
      path.join(absDir, IMAGE_DERIVATIVES_DIRECTORY, "lodge.jpg.400.webp"),
    );
    const later = new Date(copy.mtimeMs + 60_000);
    await fs.utimes(path.join(absDir, "lodge.jpg"), later, later);

    const [image] = await galleryImages();
    expect(image).not.toHaveProperty("copies");
  });

  it("reads each photo's dimensions from a bounded header read, never the whole file", async () => {
    const bytes = await store("lodge.jpg", 2000, 1500);
    await writeImageDerivatives(bytes, absDir, "lodge.jpg");
    const readFile = vi.spyOn(fs, "readFile");
    const open = vi.spyOn(fs, "open");

    const [image] = await galleryImages();
    expect(image?.width).toBe(2000);
    expect(image?.copies).toHaveLength(3);
    expect(readFile).not.toHaveBeenCalled();
    // The spies see the module's own fs: one header read per photo and copy.
    expect(open).toHaveBeenCalledTimes(4);
  });

  it("still reads a JPEG whose frame header sits past the first 64 KB", async () => {
    // An upload from before metadata stripping: a large APP segment (here a
    // 65,000-byte APP1 plus a second one) ahead of the frame header.
    const bytes = await sharp({
      create: { width: 900, height: 1200, channels: 3, background: "#335577" },
    })
      .jpeg()
      .toBuffer();
    const app = (marker: number) => {
      const segment = Buffer.alloc(2 + 2 + 65_000);
      segment.writeUInt8(0xff, 0);
      segment.writeUInt8(marker, 1);
      segment.writeUInt16BE(2 + 65_000, 2);
      return segment;
    };
    const padded = Buffer.concat([
      bytes.subarray(0, 2),
      app(0xe1),
      app(0xed),
      bytes.subarray(2),
    ]);
    await fs.writeFile(path.join(absDir, "old.jpg"), padded);

    const [image] = await galleryImages();
    expect(image).toMatchObject({ width: 900, height: 1200 });
  });

  it("does not open the copies folder as a gallery", async () => {
    const bytes = await store("lodge.jpg", 2000, 1500);
    await writeImageDerivatives(bytes, absDir, "lodge.jpg");
    const parts = await buildEmbeddedBody(
      `{{photo-gallery: ${folder}/${IMAGE_DERIVATIVES_DIRECTORY}}}`,
    );
    expect(parts).toEqual([{ type: "photo-gallery", images: [] }]);
  });
});
