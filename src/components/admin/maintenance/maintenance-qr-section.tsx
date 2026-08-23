"use client";

import { useCallback, useEffect, useState } from "react";
import { toDataURL } from "qrcode";
import { Check, Copy, Printer, QrCode, RefreshCw } from "lucide-react";

import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { useClubTime } from "@/components/club-time-provider";

/**
 * QR sign management (#2780, owner decision 5). Lodge Operations.
 *
 * WHAT AN OPERATOR DOES HERE: create a sign for a lodge, print it, put it on the
 * wall. Each lodge has at most one live sign; creating a second one rotates the
 * first out of existence, which is the tool an operator reaches for when a sign
 * has leaked or walked out of the building.
 *
 * THE RAW TOKEN EXISTS FOR EXACTLY ONE RENDER. The mint endpoint returns the
 * finished sign URL once, and it is held only in component state — never fetched
 * again, never persisted client-side, never put in an address the browser would
 * keep in history. The QR bitmap is drawn from that URL in the browser with the
 * `qrcode` library, so the token is never sent to an image service. Close the
 * page without printing and the only remedy is Rotate, which is the same remedy
 * as losing the printed sign — deliberately, because both mean the same thing.
 *
 * PAUSE IS NOT REVOCATION, and the copy says so where the buttons are. Pausing a
 * sign turns the same token off and on; Rotate is what kills a leaked one. An
 * operator who reaches for the wrong one has been handed the wrong tool, so the
 * two are labelled by what they actually do.
 */

type SignStatus = {
  active: boolean;
  createdAt: string;
  rotatedAt: string | null;
  lastUsedAt: string | null;
};

type SignRow = {
  lodgeId: string;
  lodgeName: string;
  sign: SignStatus | null;
};

type Minted = {
  lodgeId: string;
  lodgeName: string;
  signUrl: string;
  rotated: boolean;
};

const ENDPOINT = "/api/admin/maintenance-reports/tokens";

/**
 * Open the printable sign in its own window. Self-contained HTML with the QR
 * bitmap inlined as a data URL — no external asset, nothing the print window has
 * to fetch. Returns false when a popup blocker refused the window, so the caller
 * can tell the operator to allow it.
 */
function printSign(lodgeName: string, qrDataUrl: string): boolean {
  const win = window.open("", "_blank", "noopener,noreferrer,width=720,height=900");
  if (!win) return false;
  const safeName = lodgeName.replace(/[&<>"]/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "&quot;",
  );
  win.document.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>Maintenance sign — ${safeName}</title>` +
      `<style>` +
      `*{box-sizing:border-box}` +
      `body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:48px;text-align:center;color:#111}` +
      `h1{font-size:34px;margin:0 0 8px}` +
      `h2{font-size:22px;font-weight:600;margin:0 0 32px;color:#333}` +
      `img{width:340px;height:340px;margin:0 auto;display:block;border:1px solid #ddd;padding:12px}` +
      `p{font-size:19px;margin:28px auto 0;max-width:460px;line-height:1.5}` +
      `.hint{font-size:15px;color:#555;margin-top:40px}` +
      `@media print{.hint{display:none}}` +
      `</style></head><body>` +
      `<h1>Something need fixing?</h1>` +
      `<h2>${safeName}</h2>` +
      `<img src="${qrDataUrl}" alt="QR code to report a maintenance issue">` +
      `<p>Scan this code with your phone camera to tell us about anything at the lodge that needs attention. You do not need an account.</p>` +
      `<p class="hint">Use your browser's Print command if printing does not start automatically.</p>` +
      `</body></html>`,
  );
  win.document.close();
  win.focus();
  // Give the image a tick to decode before printing.
  win.setTimeout(() => win.print(), 300);
  return true;
}

/**
 * A maintenance stamp in the club's own time.
 *
 * Every value below is a real INSTANT (`createdAt`, `rotatedAt`, `lastUsedAt`,
 * `capturedAt`, `expiresAt`), so it projects through the club's PERSISTED
 * timezone (CT-4, #2870; INV-CONFIG-002) rather than the container's `TZ`. Same
 * shape as before; only the zone's AUTHORITY moved. A hook because that setting
 * reaches the browser as data through `ClubTimeProvider`.
 */
function useMaintenanceStampFormatter() {
  const clubTime = useClubTime();
  return (value: Date) => clubTime.instantDateTime(value);
}

export function MaintenanceQrSection() {
  const formatStamp = useMaintenanceStampFormatter();
  const canEdit = useAdminAreaEditAccess("lodge");

  const [rows, setRows] = useState<SignRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyLodgeId, setBusyLodgeId] = useState<string | null>(null);

  const [minted, setMinted] = useState<Minted | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [printWarning, setPrintWarning] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(ENDPOINT);
      if (!res.ok) throw new Error("Failed to load the signs");
      setRows(((await res.json()) as { signs: SignRow[] }).signs);
    } catch {
      setError("The signs could not be loaded. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Draw the QR bitmap whenever a fresh URL is revealed. Kept in an effect so the
  // async render never blocks the mint response landing in state.
  useEffect(() => {
    if (!minted) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    // margin: 4 bakes the QR spec's recommended 4-module white quiet zone INTO
    // the (opaque-white) bitmap, so the code stays scannable without a raw white
    // background utility behind it — which would not follow the club theme
    // (brand-color contract). The preview img below therefore needs no raw
    // neutral and rides on a theme-token border alone.
    void toDataURL(minted.signUrl, { width: 512, margin: 4 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [minted]);

  async function mint(lodgeId: string) {
    setBusyLodgeId(lodgeId);
    setError("");
    setPrintWarning("");
    setCopied(false);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lodgeId }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: unknown };
        throw new Error(
          typeof data.error === "string" ? data.error : "Failed to create the sign",
        );
      }
      const data = (await res.json()) as Minted;
      setMinted(data);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create the sign");
    } finally {
      setBusyLodgeId(null);
    }
  }

  async function setActive(lodgeId: string, active: boolean) {
    setBusyLodgeId(lodgeId);
    setError("");
    try {
      const res = await fetch(ENDPOINT, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lodgeId, active }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: unknown };
        throw new Error(
          typeof data.error === "string" ? data.error : "That change was refused.",
        );
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That change could not be saved.");
    } finally {
      setBusyLodgeId(null);
    }
  }

  async function copyUrl() {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted.signUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setPrintWarning(
        "The link could not be copied automatically. Select and copy it by hand.",
      );
    }
  }

  return (
    <div>
      <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
        You can see the lodge signs but not create, replace or pause them. Ask an
        administrator with Lodge Operations access.
      </AdminViewOnlySectionBanner>

      {error ? (
        <Alert variant="error" className="mb-4">
          {error}
        </Alert>
      ) : null}

      {minted ? (
        <Card className="mb-4 border-primary/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <QrCode className="h-5 w-5" aria-hidden="true" />
              {minted.rotated ? "New sign for" : "Sign for"} {minted.lodgeName}
            </CardTitle>
            <CardDescription>
              This is the only time this code is shown. Print it now, or copy the
              link. If you lose it, make a new one — the old one stops working the
              moment you do.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {qrDataUrl ? (
              <div className="flex flex-col items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element -- a QR bitmap
                    drawn in the browser as a data URL; next/image cannot optimise
                    one. */}
                <img
                  src={qrDataUrl}
                  alt={`QR code for reporting a maintenance issue at ${minted.lodgeName}`}
                  className="h-56 w-56 rounded-md border"
                />
              </div>
            ) : (
              <div className="py-6 text-center">
                <Spinner />
              </div>
            )}

            <div className="rounded-md border bg-muted px-3 py-2 text-sm break-all">
              {minted.signUrl}
            </div>

            {printWarning ? (
              <p className="text-sm text-warning-11">{printWarning}</p>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => void copyUrl()}>
                {copied ? (
                  <Check className="mr-2 h-4 w-4" aria-hidden="true" />
                ) : (
                  <Copy className="mr-2 h-4 w-4" aria-hidden="true" />
                )}
                {copied ? "Copied" : "Copy link"}
              </Button>
              <Button
                size="sm"
                disabled={!qrDataUrl}
                onClick={() => {
                  if (!qrDataUrl) return;
                  const ok = printSign(minted.lodgeName, qrDataUrl);
                  if (!ok) {
                    setPrintWarning(
                      "The print window was blocked. Allow pop-ups for this site, or copy the link and make your own sign.",
                    );
                  }
                }}
              >
                <Printer className="mr-2 h-4 w-4" aria-hidden="true" />
                Print sign
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setMinted(null)}>
                Done
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Printed lodge signs</CardTitle>
          <CardDescription>
            A sign lets anyone at the lodge report a fault by scanning it, without an
            account — only while &quot;report from a QR code&quot; is switched on in
            the settings above. Each lodge has its own.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="py-8 text-center">
              <Spinner />
            </div>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              There are no active lodges to make a sign for.
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {rows.map((row) => {
                const busy = busyLodgeId === row.lodgeId;
                return (
                  <li
                    key={row.lodgeId}
                    className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{row.lodgeName}</span>
                        {row.sign === null ? (
                          <Badge variant="outline">No sign yet</Badge>
                        ) : row.sign.active ? (
                          <Badge>Active</Badge>
                        ) : (
                          <Badge variant="secondary">Paused</Badge>
                        )}
                      </div>
                      {row.sign ? (
                        <p className="text-xs text-muted-foreground">
                          {row.sign.rotatedAt
                            ? `Last replaced ${formatStamp(new Date(row.sign.rotatedAt))}`
                            : `Created ${formatStamp(new Date(row.sign.createdAt))}`}
                          {row.sign.lastUsedAt
                            ? ` · last scanned ${formatStamp(new Date(row.sign.lastUsedAt))}`
                            : " · never scanned"}
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          No printable sign has been made for this lodge.
                        </p>
                      )}
                    </div>

                    <div className="flex shrink-0 flex-wrap gap-2">
                      {row.sign && row.sign.active ? (
                        <ViewOnlyActionButton
                          canEdit={canEdit}
                          describeReason={false}
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => void setActive(row.lodgeId, false)}
                        >
                          Pause
                        </ViewOnlyActionButton>
                      ) : row.sign ? (
                        <ViewOnlyActionButton
                          canEdit={canEdit}
                          describeReason={false}
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => void setActive(row.lodgeId, true)}
                        >
                          Resume
                        </ViewOnlyActionButton>
                      ) : null}
                      <ViewOnlyActionButton
                        canEdit={canEdit}
                        describeReason={false}
                        size="sm"
                        disabled={busy}
                        onClick={() => void mint(row.lodgeId)}
                      >
                        {row.sign ? (
                          <>
                            <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
                            Replace
                          </>
                        ) : (
                          <>
                            <QrCode className="mr-2 h-4 w-4" aria-hidden="true" />
                            Create sign
                          </>
                        )}
                      </ViewOnlyActionButton>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <p className="mt-4 text-xs text-muted-foreground">
            <strong>Replace</strong> makes a brand-new code and stops the old one
            working straight away — use it if a sign has gone missing.{" "}
            <strong>Pause</strong> only switches a sign off temporarily; the same code
            works again when you resume it, so it does not help with a lost sign.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
