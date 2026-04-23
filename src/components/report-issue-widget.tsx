"use client";

import { useState } from "react";
import html2canvas from "html2canvas";
import { AlertTriangle, Bug, Camera, LoaderCircle, Send } from "lucide-react";
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

const MAX_SCREENSHOT_DATA_URL_LENGTH = 1_500_000;
const SCREENSHOT_CAPTURE_ID_ATTRIBUTE = "data-report-issue-capture-id";
const UNSUPPORTED_COLOR_FUNCTION_RE =
  /\b(?:lab|lch|oklab|oklch|color-mix)\(/i;
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

function createStyleProbe() {
  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.position = "fixed";
  probe.style.pointerEvents = "none";
  probe.style.opacity = "0";
  probe.style.inset = "-9999px";
  probe.style.width = "0";
  probe.style.height = "0";
  document.body.appendChild(probe);

  return probe;
}

function resolveColorExpression(
  probe: HTMLElement,
  expression: string
): string | null {
  probe.style.color = expression;

  const resolved = getComputedStyle(probe).color.trim();
  probe.style.removeProperty("color");

  if (!resolved || UNSUPPORTED_COLOR_FUNCTION_RE.test(resolved)) {
    return null;
  }

  return resolved;
}

function resolveStylePropertyValue(
  probe: HTMLElement,
  propertyName: string,
  value: string
) {
  probe.style.setProperty(propertyName, value);
  const resolved = getComputedStyle(probe).getPropertyValue(propertyName).trim();
  probe.style.removeProperty(propertyName);

  if (!resolved || UNSUPPORTED_COLOR_FUNCTION_RE.test(resolved)) {
    return null;
  }

  return resolved;
}

function collectResolvedStyleOverrides(
  element: HTMLElement,
  probe: HTMLElement
) {
  const computedStyle = getComputedStyle(element);
  const overrides = new Map<string, string>();

  for (const propertyName of Array.from(computedStyle).filter((name) =>
    name.startsWith("--")
  )) {
    const rawValue = computedStyle.getPropertyValue(propertyName).trim();
    if (!rawValue || !UNSUPPORTED_COLOR_FUNCTION_RE.test(rawValue)) {
      continue;
    }

    const resolvedValue = resolveColorExpression(probe, `var(${propertyName})`);
    if (resolvedValue) {
      overrides.set(propertyName, resolvedValue);
    }
  }

  for (const propertyName of SCREENSHOT_STYLE_PROPERTIES_TO_RESOLVE) {
    const rawValue = computedStyle.getPropertyValue(propertyName).trim();
    if (!rawValue || !UNSUPPORTED_COLOR_FUNCTION_RE.test(rawValue)) {
      continue;
    }

    const resolvedValue = resolveStylePropertyValue(
      probe,
      propertyName,
      rawValue
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
    element.style.setProperty(propertyName, resolvedValue);
  }
}

function prepareResolvedStyleOverrides() {
  const probe = createStyleProbe();
  const previousAttributeValues = new Map<HTMLElement, string | null>();
  const overridesByCaptureId = new Map<string, Array<[string, string]>>();

  try {
    const elements = Array.from(
      document.querySelectorAll<HTMLElement>("html, body, body *")
    );

    for (const [index, element] of elements.entries()) {
      const captureId = `${index}`;
      previousAttributeValues.set(
        element,
        element.getAttribute(SCREENSHOT_CAPTURE_ID_ATTRIBUTE)
      );
      element.setAttribute(SCREENSHOT_CAPTURE_ID_ATTRIBUTE, captureId);

      const resolvedOverrides = collectResolvedStyleOverrides(element, probe);
      if (resolvedOverrides.length > 0) {
        overridesByCaptureId.set(captureId, resolvedOverrides);
      }
    }
  } finally {
    probe.remove();
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
      for (const [element, previousValue] of previousAttributeValues) {
        if (previousValue === null) {
          element.removeAttribute(SCREENSHOT_CAPTURE_ID_ATTRIBUTE);
        } else {
          element.setAttribute(SCREENSHOT_CAPTURE_ID_ATTRIBUTE, previousValue);
        }
      }
    },
  };
}

async function captureViewportScreenshot(options?: {
  foreignObjectRendering?: boolean;
  resolveUnsupportedColors?: boolean;
}): Promise<string> {
  const colorOverrides = options?.resolveUnsupportedColors
    ? prepareResolvedStyleOverrides()
    : null;

  try {
    const viewportCanvas = await html2canvas(document.documentElement, {
      useCORS: true,
      backgroundColor: "#ffffff",
      logging: false,
      foreignObjectRendering: options?.foreignObjectRendering ?? false,
      x: window.scrollX,
      y: window.scrollY,
      width: window.innerWidth,
      height: window.innerHeight,
      windowWidth: document.documentElement.clientWidth,
      windowHeight: document.documentElement.clientHeight,
      ignoreElements: (element) =>
        element instanceof HTMLElement &&
        element.dataset.reportIssueIgnore === "true",
      onclone: (clonedDocument) => {
        colorOverrides?.applyToClone(clonedDocument);
      },
    });

    return compressCanvasToDataUrl(viewportCanvas);
  } finally {
    colorOverrides?.cleanup();
  }
}

async function captureViewportScreenshotWithFallbacks(): Promise<string> {
  try {
    return await captureViewportScreenshot({ foreignObjectRendering: true });
  } catch {
    return captureViewportScreenshot({ resolveUnsupportedColors: true });
  }
}

export function ReportIssueWidget() {
  const [open, setOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [description, setDescription] = useState("");
  const [pageUrl, setPageUrl] = useState("");
  const [pageTitle, setPageTitle] = useState("");
  const [screenshotDataUrl, setScreenshotDataUrl] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);

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
      <div
        className="fixed bottom-5 right-5 z-50"
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
