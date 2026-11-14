"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { BackLink } from "@/components/admin/back-link";
import { adminLink } from "@/lib/admin-hubs";

// Sandboxed template preview host (LTV-036, ADR-003 §5). Previews now render
// AUTHORED admin HTML/CSS, so they must NOT run in an admin's authenticated
// top-level context where one admin's template could reach another admin's
// session. This page is the isolation boundary:
//
//  1. It reads templateId (+ optional previewLodge / previewDate) from the URL.
//  2. It asks the admin-only grant endpoint for a short-lived signed token.
//  3. It renders /display inside an `sandbox="allow-scripts"` iframe — NO
//     allow-same-origin, so the framed document runs with an OPAQUE origin:
//     the browser sends no cookies, and the authored HTML/CSS cannot touch the
//     admin session, storage, or same-origin DOM. The framed /display sends the
//     grant (?previewGrant=…) instead of a session, and the state route serves
//     exactly that template/lodge preview.
//
// The page itself renders NO authored content — only chrome and the iframe — so
// it is safe in the admin context. Direct-navigation previews
// (/display?preview=1&templateId=… with the admin's own session) keep working
// for an admin's personal use; this grant path is how the AUTHORING pages embed
// a preview safely.

interface GrantResponse {
  token: string;
  lodgeId: string;
  lodgeName: string;
  expiresInSeconds: number;
}

function readParams(): {
  templateId: string | null;
  templateName: string | null;
  previewLodge: string | null;
  previewDate: string | null;
} {
  if (typeof window === "undefined") {
    return { templateId: null, templateName: null, previewLodge: null, previewDate: null };
  }
  const params = new URLSearchParams(window.location.search);
  return {
    templateId: params.get("templateId"),
    templateName: params.get("templateName"),
    previewLodge: params.get("previewLodge"),
    previewDate: params.get("previewDate"),
  };
}

export default function AdminDisplayPreviewPage() {
  const [src, setSrc] = useState<string | null>(null);
  const [lodgeName, setLodgeName] = useState<string | null>(null);
  const [templateName, setTemplateName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const requestGrant = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { templateId, templateName: name, previewLodge, previewDate } = readParams();
    setTemplateName(name);
    if (!templateId) {
      setError("No template to preview. Open this from a template's Preview button.");
      setLoading(false);
      return;
    }
    if (!previewLodge) {
      setError("No lodge to preview. Return to Templates and choose a lodge.");
      setLoading(false);
      return;
    }
    try {
      const response = await fetch("/api/admin/display/preview-grant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          templateId,
          previewLodge,
          ...(previewDate ? { previewDate } : {}),
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Could not start the preview.");
        setLoading(false);
        return;
      }
      const grant = (await response.json()) as GrantResponse;
      setLodgeName(grant.lodgeName);
      // The framed document runs sandboxed (opaque origin); the grant is its
      // whole authority. previewDate rides along so the initial render matches
      // the chosen simulated date (the in-frame picker can change it later).
      const frameParams = new URLSearchParams({ previewGrant: grant.token });
      if (previewDate) frameParams.set("previewDate", previewDate);
      setSrc(`/display?${frameParams.toString()}`);
      setLoading(false);
    } catch {
      setError("Could not start the preview.");
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void requestGrant();
  }, [requestGrant]);

  return (
    <div className="space-y-4 p-6">
      <div>
        <BackLink {...adminLink("display-templates")} />
        <h1 className="mt-2 text-2xl font-bold">Template preview</h1>
        <p className="text-muted-foreground text-sm">
          {templateName ? (
            <>
              Previewing <strong>{templateName}</strong>
            </>
          ) : (
            "Previewing template"
          )}
          {lodgeName && (
            <>
              {" "}
              against <strong>{lodgeName}</strong>
            </>
          )}
          . Rendered in a sandboxed frame, isolated from your admin session.
        </p>
      </div>

      {error && (
        <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-3 text-sm">
          {error}
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button variant="outline" onClick={() => void requestGrant()} disabled={loading}>
          {loading ? "Loading…" : "Reload preview"}
        </Button>
        {lodgeName && (
          <span className="text-muted-foreground text-sm" data-testid="preview-lodge">
            Previewing against {lodgeName}
          </span>
        )}
      </div>

      {src && (
        <div className="w-full overflow-hidden rounded-md border bg-black">
          {/* sandbox="allow-scripts" WITHOUT allow-same-origin → opaque origin,
              no cookies, no same-origin DOM access. This is the ADR-003 §5
              isolation line: one admin's authored template can never execute
              against another admin's authenticated session. */}
          <iframe
            title="Lobby display preview"
            src={src}
            sandbox="allow-scripts"
            className="block h-[70vh] w-full border-0"
          />
        </div>
      )}
    </div>
  );
}
