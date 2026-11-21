import { describe, expect, it } from "vitest";
import sharp from "sharp";

import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
import { detectImageContentType, stripImageMetadata } from "@/lib/image-metadata";

// #5244: an SVG is rebuilt from drawing elements and attributes; editor
// metadata, comments, titles, scripts and stray text go, the drawing stays.

const EDITOR_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Created by Jane Member on JANES-LAPTOP -->
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
  xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
  viewBox="0 0 200 100" width="200" height="100"
  inkscape:export-filename="/home/jane/Documents/club-logo.png" sodipodi:docname="logo.svg" onload="alert(1)">
  <title>Jane's private title</title><desc>made at 12 Home St</desc>
  <metadata><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/">Jane Member</dc:creator></rdf:RDF></metadata>
  <sodipodi:namedview inkscape:window-width="1920">stray note from Jane</sodipodi:namedview>
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="200" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#06c"/><stop offset="1" stop-color="#0c6"/></linearGradient>
    <clipPath id="c"><rect width="200" height="80"/></clipPath>
    <style>/* Jane's stylesheet */ .a{fill:url(#g)} .b > .c{stroke:#fff}</style>
  </defs>
  <script>alert(document.domain)</script>
  <g clip-path="url(#c)" data-name="Jane layer"><rect class="a" width="200" height="100" onclick="x()"/>
    <path d="M10 10 L 190 90" stroke="#fff" stroke-width="6" style="opacity:.9 /* by Jane */"/></g>
  <text x="20" y="60" font-family="sans-serif" font-size="24" fill="#fff">Club &amp; Lodge</text>
  <use xlink:href="#c"/><image href="file:///home/jane/photo.png" width="1" height="1"/>
  <foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">hidden html</div></foreignObject>
</svg>
`;

function strip(svg: string | Buffer): string | null {
  const result = stripImageMetadata(Buffer.from(svg), "image/svg+xml");
  return result.ok ? result.bytes.toString("utf8") : null;
}

function svgWith(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10">${inner}</svg>`;
}

describe("SVG hidden-data removal", () => {
  it("removes editor metadata, comments, titles, scripts and stray text", () => {
    const cleaned = strip(EDITOR_SVG);
    expect(cleaned).not.toBeNull();
    for (const secret of [
      "Jane", "JANES-LAPTOP", "Home St", "/home/jane", "inkscape", "sodipodi",
      "alert", "onclick", "onload", "data-name", "DOCTYPE", "<?xml", "hidden html",
      "foreignObject", "<title", "<desc", "<metadata", "<!--", "/*",
    ]) {
      expect(cleaned).not.toContain(secret);
    }
  });

  it("keeps the drawing: shapes, gradients, clip paths, styles, links and text", async () => {
    const cleaned = strip(EDITOR_SVG)!;
    expect(cleaned).toMatch(/^<svg /);
    for (const kept of [
      'viewBox="0 0 200 100"', "<linearGradient", "<clipPath", 'clip-path="url(#c)"',
      ".a{fill:url(#g)}", ".b &gt; .c{stroke:#fff}", "Club &amp; Lodge",
      'xlink:href="#c"', 'style="opacity:.9 "',
    ]) {
      expect(cleaned).toContain(kept);
    }
    expect(detectImageContentType(Buffer.from(cleaned))).toBe("image/svg+xml");
    const meta = await sharp(Buffer.from(cleaned)).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["svg", 200, 100]);
  });

  it("is identical on a second pass", () => {
    const once = strip(EDITOR_SVG)!;
    expect(strip(once)).toBe(once);
  });

  it("re-embeds an embedded photo with its EXIF removed", async () => {
    const photo = await sharp({ create: { width: 4, height: 4, channels: 3, background: "red" } })
      .withExif({ IFD0: { Artist: "EMBEDDEDOWNER" } })
      .jpeg()
      .toBuffer();
    expect(photo.toString("latin1")).toContain("EMBEDDEDOWNER");
    const cleaned = strip(svgWith(
      `<image width="4" height="4" xlink:href="data:image/jpeg;base64,${photo.toString("base64")}"/>`,
    ))!;
    const embedded = /base64,([^"]+)"/.exec(cleaned)?.[1];
    expect(embedded).toBeDefined();
    const bytes = Buffer.from(embedded!, "base64");
    expect(bytes.toString("latin1")).not.toContain("EMBEDDEDOWNER");
    expect((await sharp(bytes).metadata()).width).toBe(4);
  });

  it.each([
    ["CSS @import", svgWith("<style>@import url(#x);</style>")],
    ["an external url() in CSS", svgWith("<style>.a{fill:url(http://example.test/a.svg#p)}</style>")],
    ["an external url() in an attribute", svgWith('<rect fill="url(https://example.test/p)"/>')],
    ["a CSS escape", svgWith("<style>.a{background:u\\72l(x)}</style>")],
    ["an unterminated CSS comment", svgWith("<style>.a{fill:red} /* Jane</style>")],
    ["an @import split by a character reference", svgWith("<style>@imp&#111;rt u&#114;l(https://example.test/x.css);</style>")],
    ["an @import split by XML comments", svgWith("<style>@imp<!-- x -->ort url(#a);</style>")],
    ["an external url() split across CDATA sections", svgWith(
      "<style><![CDATA[.a{fill:u]]><![CDATA[rl(https://example.test/t.png)}]]></style>",
    )],
    ["image-set() in CSS", svgWith("<style>.a{fill:image-set('file:///C:/Users/jane/a.png' 1x)}</style>")],
    ["an element nested inside a style element", svgWith("<style>.a{fill:red}<rect/></style>")],
    ["an embedded SVG image", svgWith('<image href="data:image/svg+xml;base64,PHN2Zy8+"/>')],
    ["an embedded image that is not an image", svgWith('<image href="data:image/png;base64,bm90IGFuIGltYWdl"/>')],
    ["no svg root", "<html><body>not a drawing</body></html>"],
    ["an svg root whose default namespace is XHTML",
      '<svg xmlns="http://www.w3.org/1999/xhtml" width="10" height="10"><script>alert(1)</script></svg>'],
    ["an svg root with no namespace", '<svg width="10" height="10"><rect width="1" height="1"/></svg>'],
    ["a prefixed svg root under an XHTML default namespace",
      '<svg:svg xmlns:svg="http://www.w3.org/2000/svg" xmlns="http://www.w3.org/1999/xhtml" width="10" height="10">' +
      "<script>alert(1)</script><svg:rect width=\"1\" height=\"1\"/></svg:svg>"],
    ["a prefixed svg root with a prefixed script",
      '<s:svg xmlns:s="http://www.w3.org/2000/svg" width="10" height="10"><s:script>alert(1)</s:script></s:svg>'],
    ["invalid UTF-8", Buffer.concat([Buffer.from(svgWith("<text>")), Buffer.from([0xc3, 0x28]), Buffer.from("</text></svg>")])],
  ])("refuses an SVG with %s", (_label, svg) => {
    const bytes = Buffer.from(svg);
    const result = stripImageMetadata(bytes, "image/svg+xml");
    expect(result.ok).toBe(false);
    expect(result.bytes.equals(bytes)).toBe(true);
  });

  // Known SVG script and exfiltration routes (security review of #5244): the
  // allow-list drops each; these pin it so a widened list is caught.
  it.each([
    ["a javascript: href on <use>", svgWith('<use href="javascript:alert(1)"/><rect width="1" height="1"/>')],
    ["a javascript: xlink:href on <use>", svgWith('<use xlink:href="javascript:alert(1)"/><rect width="1" height="1"/>')],
    ["a javascript: href on <image>", svgWith('<image href="javascript:alert(1)" width="1" height="1"/><rect width="1" height="1"/>')],
    ["a javascript: xlink:href on <image>",
      svgWith('<image xlink:href="javascript:alert(1)" width="1" height="1"/><rect width="1" height="1"/>')],
    ["<set attributeName=\"href\">",
      svgWith('<a href="#r"><set attributeName="href" to="javascript:alert(1)"/><rect id="r" width="1" height="1"/></a>')],
    ["<animate attributeName=\"href\">",
      svgWith('<a href="#r"><animate attributeName="href" values="javascript:alert(1)"/><rect id="r" width="1" height="1"/></a>')],
    ["an <?xml-stylesheet?> instruction",
      '<?xml-stylesheet type="text/css" href="https://example.test/x.css"?>' + svgWith('<rect width="1" height="1"/>')],
    ["a prefixed svg:script element",
      svgWith('<svg:script xmlns:svg="http://www.w3.org/2000/svg">alert(1)</svg:script><rect width="1" height="1"/>')],
  ])("removes %s and keeps the drawing", (_label, svg) => {
    const cleaned = strip(svg);
    expect(cleaned).not.toBeNull();
    for (const gone of ["javascript", "alert", "<set", "<animate", "attributeName", "xml-stylesheet", "example.test", "script"]) {
      expect(cleaned).not.toContain(gone);
    }
    expect(cleaned).toMatch(/<rect [^>]*width="1"/);
    expect(strip(cleaned!)).toBe(cleaned);
  });

  it("removes a CSS comment split by XML comments, checking the style text whole", () => {
    const once = strip(svgWith("<style>.a{fill:red} /<!---->* Jane *<!---->/</style>"));
    expect(once).not.toBeNull();
    expect(once).not.toContain("Jane");
    expect(strip(once!)).toBe(once);
  });

  it("refuses a long run of unclosed url( in linear time", () => {
    // A backtracking pattern took minutes on a 2 MB upload, stalling the
    // server for everyone.
    const svg = svgWith(`<rect style="fill:${"url(".repeat(200_000)}"/>`);
    const start = process.hrtime.bigint();
    expect(stripImageMetadata(Buffer.from(svg), "image/svg+xml").ok).toBe(false);
    expect(realElapsedMs(start)).toBeLessThan(1_000);
  });

  it("refuses a long run of unclosed CSS comments in linear time", () => {
    const svg = svgWith(`<g style="${"/*a".repeat(200_000)}"/>`);
    const start = process.hrtime.bigint();
    expect(stripImageMetadata(Buffer.from(svg), "image/svg+xml").ok).toBe(false);
    expect(realElapsedMs(start)).toBeLessThan(1_000);
  });

  it("escapes markup smuggled into a style element instead of emitting it", () => {
    const cleaned = strip(svgWith(
      "<style><![CDATA[.a{fill:red}</style><script>alert(1)</script>]]></style><rect class=\"a\"/>",
    ));
    expect(cleaned).not.toBeNull();
    expect(cleaned).not.toContain("<script");
  });
});
