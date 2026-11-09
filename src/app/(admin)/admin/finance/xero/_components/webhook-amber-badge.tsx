"use client";

import { adminHref } from "@/lib/admin-hubs";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";

const WEBHOOK_STATUS_ENDPOINT = "/api/admin/xero/webhook/verify-status";

/**
 * Fired (on window) whenever webhook verification state changes in-page — a
 * successful wizard verify, or a key save/replace re-arming verification — so
 * a mounted badge refetches instead of showing its mount-time snapshot until
 * the next full page load.
 */
export const XERO_WEBHOOK_STATE_CHANGED_EVENT = "xero-webhook-state-changed";

/**
 * Persistent amber badge (#2081): "Webhooks not configured — payment updates
 * rely on scheduled sync." Shown on /admin/xero and /admin/xero/setup whenever
 * Xero is connected but webhooks are not verified (the stored key has no
 * matching intent-to-receive marker — including after a key replace re-arms
 * verification). A later successful verify clears it everywhere, because both
 * pages read the same server state.
 *
 * Only renders once we've confirmed NOT-verified, so a verified club never sees
 * a flash of amber.
 *
 * When webhooks can't be verified on this deployment at all (a non-public-HTTPS
 * origin — Xero never reaches it), the "finish setup" nag would be unactionable,
 * so the badge instead states plainly that scheduled sync keeps payments up to
 * date. Both pages read the same `webhooksVerifiable` flag, so they stay in step.
 */
export function WebhookAmberBadge({ connected }: { connected: boolean }) {
  const [verified, setVerified] = useState<boolean | null>(null);
  const [verifiable, setVerifiable] = useState<boolean | null>(null);

  useEffect(() => {
    if (!connected) return;
    let active = true;
    const load = async () => {
      try {
        const res = await fetch(WEBHOOK_STATUS_ENDPOINT, {
          credentials: "same-origin",
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          verified?: boolean;
          webhooksVerifiable?: boolean;
        };
        if (active) {
          setVerified(Boolean(data.verified));
          setVerifiable(Boolean(data.webhooksVerifiable));
        }
      } catch {
        // Leave unknown — the badge stays hidden rather than false-alarming.
      }
    };
    void load();
    // Refetch when the wizard (same page) verifies or re-arms webhooks, so the
    // badge clears/reappears in place rather than at the next full page load.
    const onStateChanged = () => void load();
    window.addEventListener(XERO_WEBHOOK_STATE_CHANGED_EVENT, onStateChanged);
    return () => {
      active = false;
      window.removeEventListener(
        XERO_WEBHOOK_STATE_CHANGED_EVENT,
        onStateChanged,
      );
    };
  }, [connected]);

  if (!connected || verified !== false) return null;

  // Not verifiable here: state the fallback plainly instead of nagging to finish
  // a step that can't be finished on this deployment.
  if (verifiable === false) {
    return (
      <div
        role="status"
        className="mb-4 flex items-start gap-2 rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>
          Webhooks can&rsquo;t verify on this deployment — scheduled sync keeps
          payments up to date.
        </span>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="mb-4 flex items-start gap-2 rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>
        Webhooks not configured — payment updates rely on scheduled sync. Finish
        setup on the{" "}
        <Link
          href={`${adminHref("xero-setup")}?step=webhooks`}
          className="font-medium text-warning-11 underline underline-offset-2"
        >
          Xero Setup
        </Link>{" "}
        page to get real-time updates.
      </span>
    </div>
  );
}
