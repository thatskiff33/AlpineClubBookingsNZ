"use client";

import { useEffect, useState } from "react";
import { toDataURL } from "qrcode";

/**
 * A QR code for `value`, drawn in the browser as a PNG data URL, or null while
 * it is drawing, when there is no value, or when drawing failed.
 *
 * The one place the app draws a QR code (#4952): the maintenance sign and the
 * two-factor setup key. Drawing stays in the browser, so what the code encodes
 * — a TOTP secret, an unguessable sign link — never goes to a third-party
 * service.
 *
 * `margin: 4` bakes the QR spec's recommended 4-module white quiet zone INTO
 * the opaque-white bitmap, so the code stays scannable on any club theme
 * without a raw white background utility behind it (brand-color contract).
 * Callers' `<img>` therefore need only a theme-token border.
 *
 * The result is keyed to the value it was drawn for, so a changed value never
 * shows the previous value's code while the new one draws.
 */
export function useQrDataUrl(value: string | null, width: number): string | null {
  const [drawn, setDrawn] = useState<{ value: string; width: number; url: string } | null>(null);

  useEffect(() => {
    if (!value) return;
    let cancelled = false;
    void toDataURL(value, { width, margin: 4 })
      .then((url) => {
        if (!cancelled) setDrawn({ value, width, url });
      })
      .catch(() => {
        if (!cancelled) setDrawn(null);
      });
    return () => {
      cancelled = true;
    };
  }, [value, width]);

  return value && drawn?.value === value && drawn.width === width ? drawn.url : null;
}
