"use client";
import { fetchWithRecentAuth } from "@/components/confirm-its-you";

import Link from "next/link";
import { ArrowRight, Loader2, Save } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  ForbiddenSaveError,
  useSectionEditState,
} from "@/hooks/use-section-edit-state";
import type { ModuleSettingsValues } from "@/config/modules";

/**
 * Self-contained Login & Security card for Google sign-in (#2035, gated in
 * #2103).
 *
 * Mounted on the Login & Security page (`/admin/security`, #2033), which loads
 * the club module settings and whether the per-club Google credentials are
 * configured server-side.
 *
 * The card follows the canonical settings-section pattern: it loads read-only,
 * gates on `support` edit access (`useAdminAreaEditAccess`), and stages the
 * toggle behind an explicit Edit → Save/Cancel step — nothing auto-persists.
 * Save persists the `googleLogin` module column: because `PUT /api/admin/modules`
 * takes the whole strict settings object, the handler first GETs the FRESH
 * settings and merges only `googleLogin` over them, so a module another card
 * changed since page load is never clobbered. The readiness warning is keyed off
 * the STAGED value, so it previews before Save.
 */
export interface GoogleSecurityCardProps {
  moduleSettings: ModuleSettingsValues;
  /** Both Google credentials are stored in the encrypted C1 store (#2087). */
  credentialsConfigured: boolean;
  /** A real OAuth round-trip has verified the stored credentials (D2 gate). */
  verified: boolean;
  /** A stored Google credential can no longer be decrypted (auth secret changed). */
  needsReentry?: boolean;
}

const TOGGLE_FAIL_MESSAGE = "Could not update the Google sign-in setting.";

interface GoogleDraft {
  enabled: boolean;
}

export function GoogleSecurityCard({
  moduleSettings,
  credentialsConfigured,
  verified,
  needsReentry = false,
}: GoogleSecurityCardProps) {
  const canEdit = useAdminAreaEditAccess("support");
  // D2 hard gate: the module may only be turned ON once a real OAuth round-trip
  // has verified readable credentials. This mirrors the authoritative server-side
  // gate in PUT /api/admin/modules; the toggle here stays locked until then.
  const canEnable = verified && !needsReentry;

  const section = useSectionEditState<GoogleDraft>({
    initial: { enabled: moduleSettings.googleLogin },
    save: async (draft) => {
      // GET the FRESH settings and merge only `googleLogin`, so a module another
      // card changed since page load is never reverted by a stale snapshot.
      const freshRes = await fetch("/api/admin/modules", {
        credentials: "same-origin",
      });
      if (!freshRes.ok) {
        if (freshRes.status === 403) throw new ForbiddenSaveError();
        throw new Error(TOGGLE_FAIL_MESSAGE);
      }
      const fresh = (await freshRes.json()) as { settings: ModuleSettingsValues };
      const putRes = await fetchWithRecentAuth("/api/admin/modules", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: { ...fresh.settings, googleLogin: draft.enabled },
        }),
      });
      if (!putRes.ok) {
        if (putRes.status === 403) throw new ForbiddenSaveError();
        throw new Error(TOGGLE_FAIL_MESSAGE);
      }
      return { enabled: draft.enabled };
    },
    // The confirmation depends on which way the toggle went, so it is computed
    // from the saved value rather than being a fixed string.
    successMessage: (saved) =>
      saved.enabled ? "Google sign-in enabled." : "Google sign-in disabled.",
    saveErrorFallback: TOGGLE_FAIL_MESSAGE,
  });

  const { saving, editing, dirty, error } = section;
  const savedNote = section.success;
  const enabled = section.draft?.enabled ?? moduleSettings.googleLogin;

  function startEditing() {
    section.setError("");
    section.setSuccess("");
    section.startEditing();
  }

  function cancelEditing() {
    section.cancelEditing();
    section.setError("");
    section.setSuccess("");
  }

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It sits OUTSIDE the card so the empty
    wrapper an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
      Your admin role can view login &amp; security settings but cannot change
      them. Support edit access is required.
    </AdminViewOnlySectionBanner>
  );

  return (
    <div>
      {viewOnlyBanner}
      <Card {...section.sectionRegionProps}>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <CardTitle {...section.titleProps}>Google sign-in</CardTitle>
          <CardDescription>
            Let members sign in with a Google account they have linked from their
            profile. This is additive to password login — it never replaces it — and
            no account is ever created from Google. Unlinked Google accounts are
            refused.
          </CardDescription>
        </div>
        {!editing && (
          <ViewOnlyActionButton
            canEdit={canEdit}
            describeReason={false}
            variant="outline"
            size="sm"
            onClick={startEditing}
            {...section.editTriggerProps}
          >
            Edit
          </ViewOnlyActionButton>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <Alert variant="error">{error}</Alert>}
        {savedNote && <Alert variant="success">{savedNote}</Alert>}

        {editing && dirty && (
          <p className="text-sm text-warning-11" role="status">
            You have unsaved changes.
          </p>
        )}

        {needsReentry && (
          <Alert variant="warning" title="Google credentials need re-entering">
            A stored Google credential can no longer be read (the app encryption
            key changed). Re-enter your Client ID and Client secret and verify
            again on the{" "}
            <Link
              href="/admin/google/setup"
              className="font-medium underline underline-offset-4"
            >
              Google sign-in setup page
            </Link>
            .
          </Alert>
        )}

        {!canEnable && !needsReentry && (
          <Alert variant="warning" title="Finish setup before enabling">
            Google sign-in is set up entirely in-app — no environment variables
            or restart.{" "}
            {credentialsConfigured
              ? "Your credentials are stored but not yet verified — complete a verification round-trip"
              : "Enter your Google Cloud OAuth credentials and complete a verification round-trip"}{" "}
            on the{" "}
            <Link
              href="/admin/google/setup"
              className="inline-flex items-center gap-1 font-medium underline underline-offset-4"
            >
              Google sign-in setup page
              <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </Link>{" "}
            before turning it on here.
          </Alert>
        )}

        <label className="flex items-start gap-3">
          <Checkbox
            checked={enabled}
            // Locked until verified (D2). An already-ON module can still be
            // turned OFF (e.g. after a re-lock), so only block enabling.
            disabled={!editing || saving || (!canEnable && !enabled)}
            onCheckedChange={(checked) =>
              section.setDraft({ enabled: checked === true && canEnable })
            }
            aria-label="Enable Google sign-in"
          />
          <span className="text-sm">
            <span className="font-medium">Enable Google sign-in</span>
            <span className="block text-muted-foreground">
              When on (and credentials are configured and verified in-app), the
              sign-in page shows a &ldquo;Continue with Google&rdquo; button, and
              members can link their Google account from their profile.
            </span>
          </span>
        </label>

        {editing && (
          <div className="flex flex-wrap gap-2 pt-2">
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              type="button"
              onClick={() => void section.save()}
              disabled={!dirty || saving}
            >
              {saving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              Save
            </ViewOnlyActionButton>
            <Button
              type="button"
              variant="outline"
              onClick={cancelEditing}
              disabled={saving}
            >
              Cancel
            </Button>
          </div>
        )}
      </CardContent>
      </Card>
    </div>
  );
}
