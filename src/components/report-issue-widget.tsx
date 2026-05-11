"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Bug, Camera, LoaderCircle, Send, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  containsUnsupportedColorFunction,
  normalizeUnsupportedColorFunctions,
} from "@/lib/screenshot-color-sanitizer";

const MAX_SCREENSHOT_DATA_URL_LENGTH = 1_500_000;
const SCREENSHOT_CAPTURE_ID_ATTRIBUTE = "data-report-issue-capture-id";
const VIEWPORT_STYLE_OVERRIDE_PADDING_PX = 160;
const SCROLL_KEYS = new Set([
  " ",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
]);
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextFrame() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

async function loadHtml2Canvas() {
  const html2CanvasModule = await import("html2canvas");
  return html2CanvasModule.default;
}

class BlankScreenshotError extends Error {
  constructor() {
    super("Screenshot capture produced a blank image. Please try again.");
  }
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

function createCssColorConverter() {
  const canvas = document.createElement("canvas");
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

function collectResolvedStyleOverrides(
  element: HTMLElement,
  convertColor: (colorExpression: string) => string | null
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
    if (
      !rawValue ||
      (!rawValue.includes("var(") && !containsUnsupportedColorFunction(rawValue))
    ) {
      continue;
    }

    const normalizedValue = normalizeUnsupportedColorFunctions(
      rawValue,
      convertColor,
      getCssVariableValue
    );
    const normalizedValueHasUnsupportedColor =
      containsUnsupportedColorFunction(normalizedValue);
    if (normalizedValue !== rawValue || normalizedValueHasUnsupportedColor) {
      overrides.set(
        propertyName,
        normalizedValueHasUnsupportedColor
          ? fallbackHtml2CanvasStyleValue(propertyName)
          : normalizedValue
      );
    }
  }

  return Array.from(overrides.entries());
}

function applyResolvedStyleOverrides(
  element: HTMLElement,
  resolvedEntries: Array<[string, string]>
) {
  for (const [propertyName, resolvedValue] of resolvedEntries) {
    element.style.setProperty(propertyName, resolvedValue);
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

async function captureViewportScreenshot(options?: {
  resolveUnsupportedColors?: boolean;
  includeOffscreenStyleOverrides?: boolean;
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

async function captureViewportScreenshotWithFallbacks(): Promise<string> {
  try {
    return await captureViewportScreenshot({ resolveUnsupportedColors: true });
  } catch (error) {
    if (error instanceof BlankScreenshotError) {
      throw error;
    }
  }

  return captureViewportScreenshot({
    resolveUnsupportedColors: true,
    includeOffscreenStyleOverrides: true,
  });
}

export function ReportIssueWidget({
  avoidDesktopSidebar = false,
}: {
  avoidDesktopSidebar?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [description, setDescription] = useState("");
  const [pageUrl, setPageUrl] = useState("");
  const [pageTitle, setPageTitle] = useState("");
  const [screenshotDataUrl, setScreenshotDataUrl] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);

  useEffect(() => {
    if (!capturing) {
      return;
    }

    const preventScroll = (event: Event) => {
      if (event.cancelable) {
        event.preventDefault();
      }
    };
    const preventKeyboardScroll = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key) && event.cancelable) {
        event.preventDefault();
      }
    };
    const options = { capture: true, passive: false } as AddEventListenerOptions;

    document.addEventListener("wheel", preventScroll, options);
    document.addEventListener("touchmove", preventScroll, options);
    document.addEventListener("keydown", preventKeyboardScroll, true);

    return () => {
      document.removeEventListener("wheel", preventScroll, options);
      document.removeEventListener("touchmove", preventScroll, options);
      document.removeEventListener("keydown", preventKeyboardScroll, true);
    };
  }, [capturing]);

  function resetForm() {
    setDescription("");
    setPageUrl("");
    setPageTitle("");
    setScreenshotDataUrl(null);
    setCaptureError(null);
  }

  async function runCapture(options?: { closeDialogFirst?: boolean }) {
    setCapturing(true);
    setCaptureError(null);

    try {
      if (options?.closeDialogFirst) {
        setOpen(false);
        await sleep(180);
      }

      setPageUrl(window.location.href);
      setPageTitle(document.title);

      await nextFrame();
      await nextFrame();
      const dataUrl = await captureViewportScreenshotWithFallbacks();
      setScreenshotDataUrl(dataUrl);
    } catch (error) {
      setCaptureError(
        error instanceof Error
          ? error.message
          : "Automatic screenshot capture failed. You can still submit the report."
      );
    } finally {
      setCapturing(false);
      setOpen(true);
    }
  }

  async function startReport() {
    resetForm();
    await runCapture();
  }

  async function handleSubmit() {
    const trimmedDescription = description.trim();
    if (trimmedDescription.length < 10) {
      toast.error("Please describe the issue in a bit more detail.");
      return;
    }

    setSubmitting(true);

    try {
      const response = await fetch("/api/issue-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pageUrl,
          pageTitle,
          description: trimmedDescription,
          screenshotDataUrl: screenshotDataUrl ?? undefined,
        }),
      });

      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error ?? "Failed to submit issue report");
      }

      toast.success("Issue report submitted.");
      resetForm();
      setOpen(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to submit issue report"
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      {capturing ? (
        <div
          className="fixed inset-0 z-[49] cursor-progress touch-none"
          aria-hidden="true"
          data-report-issue-ignore="true"
        />
      ) : null}
      <div
        className={
          avoidDesktopSidebar
            ? "fixed bottom-20 right-5 z-50 sm:bottom-6 sm:left-6 sm:right-auto md:left-[16.5rem]"
            : "fixed bottom-20 right-5 z-50 sm:bottom-6 sm:left-6 sm:right-auto"
        }
        data-report-issue-ignore="true"
      >
        <Button
          type="button"
          size="sm"
          className="gap-2 rounded-full px-4 shadow-lg"
          disabled={capturing}
          onClick={startReport}
        >
          {capturing ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <Bug className="h-4 w-4" />
          )}
          <span className="hidden sm:inline">
            {capturing ? "Capturing..." : "Report issue"}
          </span>
        </Button>
      </div>

      <Dialog open={open} onOpenChange={(nextOpen) => !submitting && setOpen(nextOpen)}>
        <DialogContent
          className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
          data-report-issue-ignore="true"
        >
          <DialogHeader>
            <DialogTitle>Report an Issue</DialogTitle>
            <DialogDescription>
              Describe what went wrong on this page. The current view is captured automatically when possible.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
              <p className="font-medium text-slate-900">{pageTitle || "Current page"}</p>
              <p className="mt-1 break-all text-xs text-slate-500">{pageUrl}</p>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm font-medium text-slate-900">
                  <Camera className="h-4 w-4" />
                  Screenshot
                </div>
                <div className="flex items-center gap-2">
                  {screenshotDataUrl ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="gap-2"
                      onClick={() => setScreenshotDataUrl(null)}
                      disabled={capturing || submitting}
                    >
                      <X className="h-4 w-4" />
                      Remove
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => runCapture({ closeDialogFirst: true })}
                    disabled={capturing || submitting}
                  >
                    {capturing ? "Retaking..." : "Retake"}
                  </Button>
                </div>
              </div>

              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                Screenshots may include names, booking details, or payment context visible on the page.
              </div>

              {screenshotDataUrl ? (
                <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={screenshotDataUrl}
                    alt="Page screenshot preview"
                    className="block w-full"
                  />
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-500">
                  No screenshot captured yet.
                </div>
              )}

              {captureError ? (
                <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <p>{captureError}</p>
                </div>
              ) : null}
            </div>

            <div className="space-y-2">
              <label htmlFor="issue-description" className="text-sm font-medium text-slate-900">
                What happened?
              </label>
              <Textarea
                id="issue-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Tell us what you expected, what happened instead, and any steps that reproduce it."
                className="min-h-32"
                maxLength={2000}
                disabled={submitting}
              />
              <p className="text-xs text-slate-500">{description.length}/2000</p>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="gap-2"
              onClick={handleSubmit}
              disabled={submitting || capturing}
            >
              {submitting ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              {submitting ? "Submitting..." : "Submit report"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
