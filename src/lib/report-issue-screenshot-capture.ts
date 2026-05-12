import {
  containsUnsupportedColorFunction,
  normalizeUnsupportedColorFunctions,
} from "@/lib/screenshot-color-sanitizer";

const MAX_SCREENSHOT_DATA_URL_LENGTH = 1_500_000;
const SCREENSHOT_CAPTURE_ID_ATTRIBUTE = "data-report-issue-capture-id";
const VIEWPORT_STYLE_OVERRIDE_PADDING_PX = 160;
const HTML2CANVAS_PSEUDO_ELEMENT_SELECTOR = "html2canvaspseudoelement";
const SCREENSHOT_STYLE_PROPERTIES_TO_RESOLVE = [
  "color",
  "background-color",
  "background-image",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "outline-color",
  "text-decoration-color",
  "text-emphasis-color",
  "caret-color",
  "column-rule-color",
  "fill",
  "stroke",
  "box-shadow",
  "text-shadow",
  "-webkit-text-fill-color",
  "-webkit-text-stroke-color",
] as const;

type Html2CanvasColorProperty =
  (typeof SCREENSHOT_STYLE_PROPERTIES_TO_RESOLVE)[number];

type ColorConverter = (colorExpression: string) => string | null;

export class BlankScreenshotError extends Error {
  constructor() {
    super("Screenshot capture produced a blank image. Please try again.");
  }
}

async function loadHtml2Canvas() {
  const html2CanvasModule = await import("html2canvas");
  return html2CanvasModule.default;
}

function compressCanvasToDataUrl(canvas: HTMLCanvasElement): string {
  const qualities = [0.82, 0.72, 0.62];

  for (const quality of qualities) {
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    if (dataUrl.length <= MAX_SCREENSHOT_DATA_URL_LENGTH) {
      return dataUrl;
    }
  }

  return canvas.toDataURL("image/jpeg", 0.55);
}

function formatCanvasAlpha(alpha: number) {
  return String(Math.round(alpha * 1000) / 1000);
}

function createCssColorConverter(ownerDocument: Document = document) {
  const canvas = ownerDocument.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  const cache = new Map<string, string | null>();

  if (!context) {
    return () => null;
  }

  return (colorExpression: string) => {
    const trimmedExpression = colorExpression.trim();
    if (!trimmedExpression) {
      return null;
    }

    if (cache.has(trimmedExpression)) {
      return cache.get(trimmedExpression) ?? null;
    }

    try {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "rgb(1, 2, 3)";
      const sentinelFillStyle = context.fillStyle;
      context.fillStyle = trimmedExpression;

      if (context.fillStyle === sentinelFillStyle) {
        cache.set(trimmedExpression, null);
        return null;
      }

      context.fillRect(0, 0, 1, 1);
      const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
      const resolvedColor =
        alpha === 255
          ? `rgb(${red}, ${green}, ${blue})`
          : `rgba(${red}, ${green}, ${blue}, ${formatCanvasAlpha(alpha / 255)})`;

      cache.set(trimmedExpression, resolvedColor);
      return resolvedColor;
    } catch {
      cache.set(trimmedExpression, null);
      return null;
    }
  };
}

function fallbackHtml2CanvasStyleValue(propertyName: string) {
  if (propertyName === "background-image" || propertyName.endsWith("shadow")) {
    return "none";
  }

  if (
    propertyName === "background-color" ||
    propertyName.includes("border") ||
    propertyName.includes("outline") ||
    propertyName.includes("decoration") ||
    propertyName.includes("emphasis") ||
    propertyName.includes("stroke")
  ) {
    return "transparent";
  }

  return "rgb(0, 0, 0)";
}

function normalizeHtml2CanvasStyleValue(
  propertyName: Html2CanvasColorProperty,
  rawValue: string,
  convertColor: ColorConverter,
  getCssVariableValue: (name: string) => string | null,
  options?: { forceSafeColorFallbacks?: boolean }
) {
  if (options?.forceSafeColorFallbacks) {
    return fallbackHtml2CanvasStyleValue(propertyName);
  }

  if (
    !rawValue ||
    (!rawValue.includes("var(") && !containsUnsupportedColorFunction(rawValue))
  ) {
    return null;
  }

  const normalizedValue = normalizeUnsupportedColorFunctions(
    rawValue,
    convertColor,
    getCssVariableValue
  );

  if (containsUnsupportedColorFunction(normalizedValue)) {
    return fallbackHtml2CanvasStyleValue(propertyName);
  }

  return normalizedValue !== rawValue ? normalizedValue : null;
}

function collectResolvedStyleOverrides(
  element: HTMLElement,
  convertColor: ColorConverter
) {
  const computedStyle = getComputedStyle(element);
  const overrides = new Map<string, string>();
  const getCssVariableValue = (name: string) =>
    computedStyle.getPropertyValue(name).trim() || null;

  for (const propertyName of Array.from(computedStyle).filter((name) =>
    name.startsWith("--")
  )) {
    const rawValue = computedStyle.getPropertyValue(propertyName).trim();
    if (!rawValue) {
      continue;
    }

    const normalizedValue = normalizeUnsupportedColorFunctions(
      rawValue,
      convertColor,
      getCssVariableValue
    );
    if (
      normalizedValue !== rawValue &&
      !containsUnsupportedColorFunction(normalizedValue)
    ) {
      overrides.set(propertyName, normalizedValue);
    }
  }

  for (const propertyName of SCREENSHOT_STYLE_PROPERTIES_TO_RESOLVE) {
    const rawValue = computedStyle.getPropertyValue(propertyName).trim();
    const resolvedValue = normalizeHtml2CanvasStyleValue(
      propertyName,
      rawValue,
      convertColor,
      getCssVariableValue
    );

    if (resolvedValue) {
      overrides.set(propertyName, resolvedValue);
    }
  }

  return Array.from(overrides.entries());
}

function applyResolvedStyleOverrides(
  element: HTMLElement,
  resolvedEntries: Array<[string, string]>
) {
  for (const [propertyName, resolvedValue] of resolvedEntries) {
    element.style.setProperty(propertyName, resolvedValue, "important");
  }
}

function elementMayAffectViewport(element: HTMLElement) {
  if (element === document.documentElement || element === document.body) {
    return true;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return false;
  }

  return (
    rect.bottom >= -VIEWPORT_STYLE_OVERRIDE_PADDING_PX &&
    rect.right >= -VIEWPORT_STYLE_OVERRIDE_PADDING_PX &&
    rect.top <= window.innerHeight + VIEWPORT_STYLE_OVERRIDE_PADDING_PX &&
    rect.left <= window.innerWidth + VIEWPORT_STYLE_OVERRIDE_PADDING_PX
  );
}

function prepareResolvedStyleOverrides(options?: { includeOffscreen?: boolean }) {
  const convertColor = createCssColorConverter();
  const previousAttributeValues = new Map<HTMLElement, string | null>();
  const overridesByCaptureId = new Map<string, Array<[string, string]>>();

  const cleanup = () => {
    for (const [element, previousValue] of previousAttributeValues) {
      if (previousValue === null) {
        element.removeAttribute(SCREENSHOT_CAPTURE_ID_ATTRIBUTE);
      } else {
        element.setAttribute(SCREENSHOT_CAPTURE_ID_ATTRIBUTE, previousValue);
      }
    }
  };

  try {
    const elements = Array.from(
      document.querySelectorAll<HTMLElement>("html, body, body *")
    );

    for (const [index, element] of elements.entries()) {
      if (!options?.includeOffscreen && !elementMayAffectViewport(element)) {
        continue;
      }

      const captureId = `${index}`;
      previousAttributeValues.set(
        element,
        element.getAttribute(SCREENSHOT_CAPTURE_ID_ATTRIBUTE)
      );
      element.setAttribute(SCREENSHOT_CAPTURE_ID_ATTRIBUTE, captureId);

      const resolvedOverrides = collectResolvedStyleOverrides(
        element,
        convertColor
      );
      if (resolvedOverrides.length > 0) {
        overridesByCaptureId.set(captureId, resolvedOverrides);
      }
    }
  } catch (error) {
    cleanup();
    throw error;
  }

  return {
    applyToClone(clonedDocument: Document) {
      for (const [captureId, overrides] of overridesByCaptureId) {
        const clonedElement = clonedDocument.querySelector<HTMLElement>(
          `[${SCREENSHOT_CAPTURE_ID_ATTRIBUTE}="${captureId}"]`
        );
        if (!clonedElement) {
          continue;
        }

        applyResolvedStyleOverrides(clonedElement, overrides);
        clonedElement.removeAttribute(SCREENSHOT_CAPTURE_ID_ATTRIBUTE);
      }
    },
    cleanup() {
      cleanup();
    },
  };
}

function getComputedStyleForElement(element: Element) {
  const ownerWindow = element.ownerDocument.defaultView;
  if (!ownerWindow) {
    return null;
  }

  return ownerWindow.getComputedStyle(element);
}

function sanitizeElementStyleForHtml2Canvas(
  element: Element,
  convertColor: ColorConverter,
  options?: { forceSafeColorFallbacks?: boolean }
) {
  const styledElement = element as HTMLElement;
  if (!("style" in styledElement)) {
    return;
  }

  const computedStyle = getComputedStyleForElement(element);
  if (!computedStyle) {
    return;
  }

  const getCssVariableValue = (name: string) =>
    computedStyle.getPropertyValue(name).trim() || null;

  for (const propertyName of Array.from(computedStyle).filter((name) =>
    name.startsWith("--")
  )) {
    const rawValue = computedStyle.getPropertyValue(propertyName).trim();
    if (!rawValue) {
      continue;
    }

    const normalizedValue = normalizeUnsupportedColorFunctions(
      rawValue,
      convertColor,
      getCssVariableValue
    );
    if (
      normalizedValue !== rawValue &&
      !containsUnsupportedColorFunction(normalizedValue)
    ) {
      styledElement.style.setProperty(propertyName, normalizedValue, "important");
    }
  }

  for (const propertyName of SCREENSHOT_STYLE_PROPERTIES_TO_RESOLVE) {
    const rawValue = computedStyle.getPropertyValue(propertyName).trim();
    const resolvedValue = normalizeHtml2CanvasStyleValue(
      propertyName,
      rawValue,
      convertColor,
      getCssVariableValue,
      options
    );

    if (resolvedValue) {
      styledElement.style.setProperty(propertyName, resolvedValue, "important");
    }
  }
}

export function sanitizeClonedDocumentForHtml2Canvas(
  clonedDocument: Document,
  options?: {
    forceSafeColorFallbacks?: boolean;
    sanitizeAllElements?: boolean;
  }
) {
  const convertColor = createCssColorConverter(clonedDocument);
  const selector = options?.sanitizeAllElements
    ? "html, body, body *"
    : HTML2CANVAS_PSEUDO_ELEMENT_SELECTOR;

  for (const element of clonedDocument.querySelectorAll(selector)) {
    sanitizeElementStyleForHtml2Canvas(element, convertColor, options);
  }
}

function canvasLooksBlankBlack(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context || canvas.width === 0 || canvas.height === 0) {
    return false;
  }

  const columns = 10;
  const rows = 10;
  let sampledPixels = 0;
  let blackPixels = 0;

  try {
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const x = Math.min(
          canvas.width - 1,
          Math.round((canvas.width * (column + 0.5)) / columns)
        );
        const y = Math.min(
          canvas.height - 1,
          Math.round((canvas.height * (row + 0.5)) / rows)
        );
        const [red, green, blue, alpha] = context.getImageData(x, y, 1, 1).data;
        sampledPixels += 1;

        if (alpha > 245 && red < 12 && green < 12 && blue < 12) {
          blackPixels += 1;
        }
      }
    }
  } catch {
    return false;
  }

  return sampledPixels > 0 && blackPixels / sampledPixels > 0.9;
}

function isBlankScreenshotError(error: unknown) {
  return error instanceof BlankScreenshotError;
}

async function captureViewportScreenshot(options?: {
  forceSafeColorFallbacks?: boolean;
  includeOffscreenStyleOverrides?: boolean;
  resolveUnsupportedColors?: boolean;
  sanitizeAllClonedElements?: boolean;
}): Promise<string> {
  const colorOverrides = options?.resolveUnsupportedColors
    ? prepareResolvedStyleOverrides({
        includeOffscreen: options.includeOffscreenStyleOverrides,
      })
    : null;
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  try {
    const html2canvas = await loadHtml2Canvas();
    const viewportCanvas = await html2canvas(document.documentElement, {
      useCORS: true,
      backgroundColor: "#ffffff",
      logging: false,
      x: scrollX,
      y: scrollY,
      width: viewportWidth,
      height: viewportHeight,
      scrollX,
      scrollY,
      windowWidth: viewportWidth,
      windowHeight: viewportHeight,
      ignoreElements: (element) =>
        element instanceof HTMLElement &&
        element.dataset.reportIssueIgnore === "true",
      onclone: (clonedDocument) => {
        colorOverrides?.applyToClone(clonedDocument);
        sanitizeClonedDocumentForHtml2Canvas(clonedDocument, {
          forceSafeColorFallbacks: options?.forceSafeColorFallbacks,
          sanitizeAllElements: options?.sanitizeAllClonedElements,
        });
      },
    });

    if (canvasLooksBlankBlack(viewportCanvas)) {
      throw new BlankScreenshotError();
    }

    return compressCanvasToDataUrl(viewportCanvas);
  } finally {
    colorOverrides?.cleanup();
  }
}

export async function captureViewportScreenshotWithFallbacks(): Promise<string> {
  try {
    return await captureViewportScreenshot({ resolveUnsupportedColors: true });
  } catch (error) {
    if (isBlankScreenshotError(error)) {
      throw error;
    }
  }

  try {
    return await captureViewportScreenshot({
      resolveUnsupportedColors: true,
      includeOffscreenStyleOverrides: true,
      sanitizeAllClonedElements: true,
    });
  } catch (error) {
    if (isBlankScreenshotError(error)) {
      throw error;
    }
  }

  return captureViewportScreenshot({
    resolveUnsupportedColors: true,
    includeOffscreenStyleOverrides: true,
    sanitizeAllClonedElements: true,
    forceSafeColorFallbacks: true,
  });
}
