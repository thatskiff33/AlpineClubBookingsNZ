import sanitizeHtml from "sanitize-html";

/**
 * Hidden-data removal for SVG drawings (#5244), behind `stripImageMetadata` in
 * `@/lib/image-metadata`.
 *
 * An SVG is a text document, so anything can ride in it: `<metadata>` RDF with
 * the author's name, `<title>`/`<desc>`, comments, editor attributes holding
 * the author's file paths (`inkscape:export-filename`, `sodipodi:docname`),
 * `data-*` attributes and stray text. Rather than hunting for each of those,
 * the drawing is rebuilt from an allow-list: only drawing elements and drawing
 * attributes survive, the way `src/lib/page-content-html.ts` rebuilds page
 * HTML. Everything not listed — comments, the DOCTYPE, processing
 * instructions, `on*` handlers, `data-*`, editor namespaces, `<a>`, `<script>`
 * — goes by not being listed; `script`, `metadata`, `title`, `desc` and
 * `foreignObject` go together with their contents. Text survives only inside
 * `text`, `tspan` and `textPath`, where it is part of the drawing.
 *
 * References are narrowed to the document itself: `href`/`xlink:href` and
 * every `url(...)` must point at an `#id`. The one exception is an `<image>`
 * holding an embedded PNG, JPEG, WebP or GIF as a base64 `data:` URI, which is
 * cleaned by the caller's raster cleaner and re-embedded. An external link is
 * removed (it may be a local file path from the author's machine).
 *
 * Fail-CLOSED, returning `null` for the caller to refuse: bytes that are not
 * valid UTF-8, CSS holding `@import`, an escape, an unterminated comment or a
 * `url()` that is not `#id`, an embedded image that cannot be cleaned, or
 * output without an `<svg` root in the SVG namespace. A second pass returns
 * identical bytes.
 */

/** Cleans an embedded raster image; `null` when it cannot be confirmed clean. */
export type EmbeddedImageCleaner = (bytes: Buffer) => { bytes: Buffer; contentType: string } | null;

const TEXT_ELEMENTS = new Set(["text", "tspan", "textPath"]);

// `style` element text is emitted raw (unescaped) by sanitize-html, which is
// unsafe in an XML document, so the element is renamed to this placeholder
// while sanitising (its text then goes through the escaping path and
// `textFilter`) and renamed back afterwards. The placeholder cannot occur in
// the output any other way: every `<` in text and attributes is escaped.
const STYLE_PLACEHOLDER = "x-svg-style";

const ALLOWED_TAGS = [
  "svg", "g", "defs", "symbol", "use", "switch",
  "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "image",
  "text", "tspan", "textPath",
  "linearGradient", "radialGradient", "stop",
  "clipPath", "mask", "pattern", "marker",
  "filter", "feBlend", "feColorMatrix", "feComponentTransfer", "feComposite",
  "feConvolveMatrix", "feDiffuseLighting", "feDisplacementMap",
  "feDistantLight", "feDropShadow", "feFlood", "feFuncA", "feFuncB", "feFuncG",
  "feFuncR", "feGaussianBlur", "feImage", "feMerge", "feMergeNode",
  "feMorphology", "feOffset", "fePointLight", "feSpecularLighting",
  "feSpotLight", "feTile", "feTurbulence",
  STYLE_PLACEHOLDER,
];

const ALLOWED_ATTRIBUTES = [
  // Structure and references
  "id", "class", "style", "href", "xlink:href", "xmlns", "xmlns:xlink",
  "version", "xml:space",
  // Geometry
  "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "fx", "fy",
  "fr", "width", "height", "d", "points", "pathLength", "viewBox",
  "preserveAspectRatio", "transform", "transform-origin",
  // Painting
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width",
  "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray",
  "stroke-dashoffset", "stroke-opacity", "opacity", "color", "display",
  "visibility", "overflow", "clip", "clip-path", "clip-rule", "mask",
  "filter", "marker-start", "marker-mid", "marker-end", "paint-order",
  "vector-effect", "shape-rendering", "image-rendering", "color-interpolation",
  "color-interpolation-filters", "mix-blend-mode", "isolation",
  // Gradients, patterns, markers, clips and masks
  "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform",
  "spreadMethod", "patternUnits", "patternContentUnits", "patternTransform",
  "clipPathUnits", "maskUnits", "maskContentUnits", "markerUnits",
  "markerWidth", "markerHeight", "refX", "refY", "orient",
  // Text
  "font-family", "font-size", "font-weight", "font-style", "font-variant",
  "font-stretch", "text-anchor", "dominant-baseline", "alignment-baseline",
  "baseline-shift", "letter-spacing", "word-spacing", "text-decoration",
  "writing-mode", "direction", "unicode-bidi", "dx", "dy", "rotate",
  "textLength", "lengthAdjust", "startOffset", "method", "spacing", "side",
  // Filter primitives
  "filterUnits", "primitiveUnits", "in", "in2", "result", "mode", "operator",
  "k1", "k2", "k3", "k4", "values", "type", "tableValues", "slope",
  "intercept", "amplitude", "exponent", "stdDeviation", "edgeMode", "order",
  "kernelMatrix", "divisor", "bias", "targetX", "targetY", "preserveAlpha",
  "surfaceScale", "diffuseConstant", "specularConstant", "specularExponent",
  "kernelUnitLength", "lighting-color", "flood-color", "flood-opacity",
  "azimuth", "elevation", "z", "pointsAtX", "pointsAtY", "pointsAtZ",
  "limitingConeAngle", "scale", "xChannelSelector", "yChannelSelector",
  "radius", "baseFrequency", "numOctaves", "seed", "stitchTiles",
];

const NAMESPACE_VALUES: Record<string, string> = {
  xmlns: "http://www.w3.org/2000/svg",
  "xmlns:xlink": "http://www.w3.org/1999/xlink",
};

const LOCAL_REFERENCE = /^#[^\s()'"\\]+$/;
// Any image type: the caller's cleaner decides which it accepts.
const EMBEDDED_IMAGE = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i;

class UnconfirmedSvg extends Error {}

/**
 * Throws when a CSS or attribute value can reach outside the drawing: an
 * escape (which can spell the rest in a form these checks miss), `@import`,
 * `image-set()`, or a `url()` that is not an `#id`. A linear scan, so a long
 * run of unclosed `url(` cannot stall the server.
 */
function assertNoOutsideReach(value: string): void {
  if (value.includes("\\")) throw new UnconfirmedSvg("CSS escape");
  if (/@import|image-set\s*\(/i.test(value)) throw new UnconfirmedSvg("CSS import");
  const opener = /url\s*\(/gi;
  for (let match = opener.exec(value); match; match = opener.exec(value)) {
    const close = value.indexOf(")", opener.lastIndex);
    if (close === -1) throw new UnconfirmedSvg("unterminated url()");
    const target = value.slice(opener.lastIndex, close).trim().replace(/^(['"])(.*)\1$/, "$2");
    if (!LOCAL_REFERENCE.test(target.trim())) throw new UnconfirmedSvg("external url()");
    opener.lastIndex = close + 1;
  }
}

/** CSS with comments removed, or a throw when it reaches outside the drawing. */
function cleanCss(css: string): string {
  // A linear scan, not a lazy regex: an unterminated run of `/*` would make
  // the regex retry from every opener.
  let withoutComments = "";
  let from = 0;
  for (let open = css.indexOf("/*"); open !== -1; open = css.indexOf("/*", from)) {
    const close = css.indexOf("*/", open + 2);
    if (close === -1) throw new UnconfirmedSvg("unterminated CSS comment");
    withoutComments += css.slice(from, open);
    from = close + 2;
  }
  withoutComments += css.slice(from);
  assertNoOutsideReach(withoutComments);
  return withoutComments;
}

function cleanEmbeddedImage(value: string, cleanImage: EmbeddedImageCleaner): string {
  const match = EMBEDDED_IMAGE.exec(value.trim());
  if (!match?.[1]) throw new UnconfirmedSvg("embedded image is not a base64 data URI");
  const cleaned = cleanImage(Buffer.from(match[1].replace(/\s+/g, ""), "base64"));
  if (!cleaned) throw new UnconfirmedSvg("embedded image could not be cleaned");
  return `data:${cleaned.contentType};base64,${cleaned.bytes.toString("base64")}`;
}

function cleanAttributes(
  tagName: string,
  attribs: sanitizeHtml.Attributes,
  cleanImage: EmbeddedImageCleaner,
): sanitizeHtml.Attributes {
  const cleaned: sanitizeHtml.Attributes = {};
  for (const [name, value] of Object.entries(attribs)) {
    if (name in NAMESPACE_VALUES) {
      if (value === NAMESPACE_VALUES[name]) cleaned[name] = value;
    } else if (name === "href" || name === "xlink:href") {
      if (LOCAL_REFERENCE.test(value.trim())) {
        cleaned[name] = value.trim();
      } else if (tagName === "image" && /^\s*data:/i.test(value)) {
        cleaned[name] = cleanEmbeddedImage(value, cleanImage);
      }
      // Anything else is an external link: removed.
    } else if (name === "style") {
      cleaned[name] = cleanCss(value);
    } else {
      assertNoOutsideReach(value);
      cleaned[name] = value;
    }
  }
  return cleaned;
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new UnconfirmedSvg("not UTF-8");
  }
}

function rebuildSvg(bytes: Buffer, cleanImage: EmbeddedImageCleaner): Buffer {
  const source = decodeUtf8(bytes);
  // sanitize-html's callbacks cannot abort the parse, so a doubt raised inside
  // one is recorded here and acted on once the rebuild finishes.
  let doubt: unknown = null;
  const guard = <T>(fallback: T, run: () => T): T => {
    try {
      return run();
    } catch (error) {
      doubt ??= error;
      return fallback;
    }
  };

  const rebuilt = sanitizeHtml(source, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { "*": ALLOWED_ATTRIBUTES },
    nonTextTags: ["script", "metadata", "title", "desc", "foreignObject"],
    allowedSchemes: [],
    allowedSchemesByTag: { image: ["data"] },
    allowProtocolRelative: false,
    parseStyleAttributes: false,
    parser: {
      xmlMode: true,
      lowerCaseTags: false,
      lowerCaseAttributeNames: false,
      decodeEntities: true,
    },
    transformTags: {
      style: (_tagName, attribs) => ({ tagName: STYLE_PLACEHOLDER, attribs }),
      "*": (tagName, attribs) => ({
        tagName,
        attribs: guard({}, () => cleanAttributes(tagName, attribs, cleanImage)),
      }),
    },
    textFilter: (text, tagName) => {
      // Style text arrives in pieces (split at entities, comments and CDATA),
      // so it is checked whole, per element, once the rebuild is done.
      if (tagName === "style" || tagName === STYLE_PLACEHOLDER) return text;
      if (TEXT_ELEMENTS.has(tagName)) return text;
      return text.trim() === "" ? text : "";
    },
  });

  if (doubt) throw doubt;
  const output = cleanStyleElements(rebuilt).trim();
  // The root must be in the SVG namespace: `cleanAttributes` drops any other
  // `xmlns`, so an `<svg>` declared as XHTML (or with none) has no drawing.
  const rootTag = /^<svg(?:\s[^>]*)?>/.exec(output)?.[0];
  if (!rootTag?.includes(` xmlns="${NAMESPACE_VALUES.xmlns}"`)) {
    throw new UnconfirmedSvg("no <svg> root in the SVG namespace");
  }
  return Buffer.from(output, "utf8");
}

/**
 * Every `<style>` element's whole text run through `cleanCss`, and the
 * placeholder renamed back. Text and attribute values are escaped, so a
 * style element's body holds no `<` unless an element was nested inside it —
 * which is refused rather than left unchecked.
 */
function cleanStyleElements(rebuilt: string): string {
  const opened = rebuilt.split(`<${STYLE_PLACEHOLDER}`).length - 1;
  let checked = 0;
  const cleaned = rebuilt.replace(
    new RegExp(`<${STYLE_PLACEHOLDER}([^>]*)>([^<]*)</${STYLE_PLACEHOLDER}>`, "g"),
    (_element, attributes: string, css: string) => {
      checked += 1;
      return `<style${attributes}>${cleanCss(css)}</style>`;
    },
  );
  if (checked !== opened) throw new UnconfirmedSvg("markup inside a style element");
  return cleaned;
}

/**
 * The SVG rebuilt from drawing elements and attributes only, or `null` when
 * it cannot be confirmed clean.
 */
export function stripSvgMetadata(
  bytes: Buffer,
  cleanImage: EmbeddedImageCleaner,
): Buffer | null {
  try {
    const cleaned = rebuildSvg(bytes, cleanImage);
    // A clean drawing rebuilds to itself. Anything else means some input
    // reshaped on the way through, so what was checked is not what is stored.
    if (!rebuildSvg(cleaned, cleanImage).equals(cleaned)) return null;
    return cleaned;
  } catch (error) {
    if (error instanceof UnconfirmedSvg) return null;
    throw error;
  }
}
