// @vitest-environment jsdom

import html2canvas from "html2canvas";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureViewportScreenshotWithFallbacks,
  sanitizeClonedDocumentForHtml2Canvas,
} from "@/lib/report-issue-screenshot-capture";

vi.mock("html2canvas", () => ({
  default: vi.fn(),
}));

const mockedHtml2Canvas = vi.mocked(html2canvas);

function makeComputedStyle(
  values: Record<string, string>,
  customPropertyNames: string[] = []
) {
  return {
    getPropertyValue: (name: string) => values[name] ?? "",
    [Symbol.iterator]: function* iterator() {
      yield* customPropertyNames;
    },
  } as CSSStyleDeclaration;
}

function makeRect(): DOMRect {
  return {
    bottom: 10,
    height: 10,
    left: 0,
    right: 10,
    top: 0,
    width: 10,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  };
}

function makeCanvas() {
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "width", { configurable: true, value: 120 });
  Object.defineProperty(canvas, "height", { configurable: true, value: 80 });
  return canvas;
}

afterEach(() => {
  document.body.innerHTML = "";
  mockedHtml2Canvas.mockReset();
  vi.restoreAllMocks();
});

describe("report issue screenshot capture", () => {
  it("sanitizes cloned html2canvas pseudo-elements before parsing", () => {
    const pseudoElement = document.createElement("html2canvaspseudoelement");
    const normalElement = document.createElement("div");
    document.body.append(pseudoElement, normalElement);

    vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
      makeComputedStyle(
        element === pseudoElement
          ? {
              color: "lab(52% 12 18)",
              "background-image": "linear-gradient(lab(52% 12 18), white)",
            }
          : {
              color: "lab(60% 10 20)",
            }
      )
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

    sanitizeClonedDocumentForHtml2Canvas(document);

    expect(pseudoElement.style.getPropertyValue("color")).toBe("rgb(0, 0, 0)");
    expect(pseudoElement.style.getPropertyValue("background-image")).toBe("none");
    expect(normalElement.style.getPropertyValue("color")).toBe("");
  });

  it("can sanitize every cloned element on the full-document fallback", () => {
    const element = document.createElement("div");
    document.body.append(element);

    vi.spyOn(window, "getComputedStyle").mockReturnValue(
      makeComputedStyle({
        "background-color": "color-mix(in srgb, red, white)",
        color: "lab(52% 12 18)",
      })
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

    sanitizeClonedDocumentForHtml2Canvas(document, { sanitizeAllElements: true });

    expect(element.style.getPropertyValue("background-color")).toBe(
      "transparent"
    );
    expect(element.style.getPropertyValue("color")).toBe("rgb(0, 0, 0)");
  });

  it("retries with the full sanitizer when html2canvas rejects modern colors", async () => {
    document.body.innerHTML = "<main><p>Booking detail</p></main>";
    const canvas = makeCanvas();

    vi.spyOn(window, "getComputedStyle").mockReturnValue(makeComputedStyle({}));
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      makeRect()
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
      "data:image/jpeg;base64,screen"
    );
    mockedHtml2Canvas
      .mockRejectedValueOnce(
        new Error('Attempting to parse an unsupported color function "lab"')
      )
      .mockResolvedValueOnce(canvas);

    await expect(captureViewportScreenshotWithFallbacks()).resolves.toBe(
      "data:image/jpeg;base64,screen"
    );
    expect(mockedHtml2Canvas).toHaveBeenCalledTimes(2);
  });
});
