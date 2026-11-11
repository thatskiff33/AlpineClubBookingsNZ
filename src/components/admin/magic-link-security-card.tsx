"use client";
import { fetchWithRecentAuth } from "@/components/confirm-its-you";

import { Loader2, Save } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  DEFAULT_MAGIC_LINK_TTL_MINUTES,
  MAGIC_LINK_TTL_MAX_MINUTES,
  MAGIC_LINK_TTL_MIN_MINUTES,
  clampMagicLinkTtlMinutes,
} from "@/lib/magic-link";

/**
 * Self-contained Login & Security card for email magic-link sign-in (#2034,
 * gated in #2103).
 *
 * Mounted on the Login & Security page (`/admin/security`, #2033), which loads
 * the club module settings and the configured expiry and passes them in.
 *
 * The card follows the canonical settings-section pattern: it loads read-only,
 * gates on `support` edit access (`useAdminAreaEditAccess`), and stages ALL
 * changes behind an explicit Edit → Save/Cancel step — nothing auto-persists on
 * toggle. Save writes at most two endpoints, once each:
 *   - the enable toggle persists the `magicLink` module column. Because
 *     `PUT /api/admin/modules` takes the whole strict settings object, the
 *     handler first GETs the FRESH settings and merges only `magicLink` over
 *     them, so a module another card changed since page load is never clobbered.
 *   - the link expiry persists `magicLinkTtlMinutes` via
 *     `PUT /api/admin/security/magic-link` (or the optional `onSaveTtlMinutes`
 *     override seam, retained for testability). The sign-in request route reads
 *     that value back, re-clamped, at issuance.
 */
export interface MagicLinkSecurityCardProps {
  moduleSettings: ModuleSettingsValues;
  initialTtlMinutes?: number;
  /**
   * Optional override for the TTL write. When omitted (the production path — a
   * server component cannot pass a function prop), the card PUTs the new
   * `/api/admin/security/magic-link` route itself.
   */
  onSaveTtlMinutes?: (minutes: number) => Promise<void>;
}

const TOGGLE_FAIL_MESSAGE = "Could not update the email sign-in link setting.";
const TTL_FAIL_MESSAGE = "Could not update the link expiry.";

interface MagicLinkDraft {
  enabled: boolean;
  ttlMinutes: number;
}

async function putJson(url: string, body: unknown, failMessage: string) {
  const res = await fetchWithRecentAuth(url, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    if (res.status === 403) throw new ForbiddenSaveError();
    throw new Error(failMessage);
  }
  return res;
}

export function MagicLinkSecurityCard({
  moduleSettings,
  initialTtlMinutes = DEFAULT_MAGIC_LINK_TTL_MINUTES,
  onSaveTtlMinutes,
}: MagicLinkSecurityCardProps) {
  const canEdit = useAdminAreaEditAccess("support");
  const initialClampedTtl = clampMagicLinkTtlMinutes(initialTtlMinutes);

  const section = useSectionEditState<MagicLinkDraft>({
    // Props-seeded: the page fetches the module settings and expiry server-side,
    // so this card has no load step (and no loading state).
    initial: {
      enabled: moduleSettings.magicLink,
      ttlMinutes: initialClampedTtl,
    },
    save: async (draft, saved) => {
      // `saved` is never null here: this card is props-seeded, so the hook holds
      // a snapshot from the first render onward. Fail loudly rather than reading
      // it optionally — under `saved?.x` a null snapshot would make BOTH slices
      // below compare as changed and silently double-write two endpoints.
      if (!saved) throw new Error(TOGGLE_FAIL_MESSAGE);

      // Persist the module toggle if it changed: GET the FRESH settings and
      // merge only `magicLink`, so a module another card changed since page
      // load is never reverted by writing back a stale snapshot.
      if (draft.enabled !== saved.enabled) {
        const freshRes = await fetch("/api/admin/modules", {
          credentials: "same-origin",
        });
        if (!freshRes.ok) {
          if (freshRes.status === 403) throw new ForbiddenSaveError();
          throw new Error(TOGGLE_FAIL_MESSAGE);
        }
        const fresh = (await freshRes.json()) as {
          settings: ModuleSettingsValues;
        };
        await putJson(
          "/api/admin/modules",
          { settings: { ...fresh.settings, magicLink: draft.enabled } },
          TOGGLE_FAIL_MESSAGE,
        );
      }

      // Persist the TTL if it changed.
      const clampedTtl = clampMagicLinkTtlMinutes(draft.ttlMinutes);
      if (clampedTtl !== saved.ttlMinutes) {
        if (onSaveTtlMinutes) {
          await onSaveTtlMinutes(clampedTtl);
        } else {
          await putJson(
            "/api/admin/security/magic-link",
            { magicLinkTtlMinutes: clampedTtl },
            TTL_FAIL_MESSAGE,
          );
        }
      }

      // Neither write echoes the stored row back, so the clamped value the
      // routes persist is the authoritative one to re-seed from.
      return { enabled: draft.enabled, ttlMinutes: clampedTtl };
    },
    successMessage: "Email sign-in settings saved.",
    saveErrorFallback: TOGGLE_FAIL_MESSAGE,
    isValid: (draft) =>
      Number.isInteger(draft.ttlMinutes) &&
      draft.ttlMinutes >= MAGIC_LINK_TTL_MIN_MINUTES &&
      draft.ttlMinutes <= MAGIC_LINK_TTL_MAX_MINUTES,
  });

  const { saving, editing, dirty, error } = section;
  const savedNote = section.success;
  const ttlValid = section.valid;
  const enabled = section.draft?.enabled ?? moduleSettings.magicLink;
  const ttlMinutes = section.draft?.ttlMinutes ?? initialClampedTtl;

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
    some screen-reader/browser pairings. It sits OUTSIDE the card's `space-y-*`
    stack so the empty wrapper an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
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
          <CardTitle {...section.titleProps}>Email sign-in link</CardTitle>
          <CardDescription>
            Let members request a single-use email link to sign in without typing
            their password. This is additive to password login — it never replaces
            it — and only ever works for existing active members with a verified
            email.
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

        <label className="flex items-start gap-3">
          <Checkbox
            checked={enabled}
            disabled={!editing || saving}
            onCheckedChange={(checked) =>
              section.setDraft({ enabled: checked === true })
            }
            aria-label="Enable email sign-in link"
          />
          <span className="text-sm">
            <span className="font-medium">Enable email sign-in link</span>
            <span className="block text-muted-foreground">
              When on, the sign-in page shows an &ldquo;Email me a sign-in
              link&rdquo; option.
            </span>
          </span>
        </label>

        <div className="space-y-2">
          <Label htmlFor="magic-link-ttl">Link expiry (minutes)</Label>
          <Input
            id="magic-link-ttl"
            type="number"
            min={MAGIC_LINK_TTL_MIN_MINUTES}
            max={MAGIC_LINK_TTL_MAX_MINUTES}
            value={ttlMinutes}
            disabled={!editing || saving}
            onChange={(e) =>
              section.setDraft({ ttlMinutes: Number(e.target.value) })
            }
            className="w-28"
            aria-describedby="magic-link-ttl-hint"
          />
          <p id="magic-link-ttl-hint" className="text-xs text-muted-foreground">
            Sign-in links expire between {MAGIC_LINK_TTL_MIN_MINUTES} and{" "}
            {MAGIC_LINK_TTL_MAX_MINUTES} minutes after they are sent (default{" "}
            {DEFAULT_MAGIC_LINK_TTL_MINUTES}).
          </p>
          {editing && !ttlValid && (
            <p className="text-xs text-destructive">
              Enter a whole number between {MAGIC_LINK_TTL_MIN_MINUTES} and{" "}
              {MAGIC_LINK_TTL_MAX_MINUTES}.
            </p>
          )}
        </div>

        {editing && (
          <div className="flex flex-wrap gap-2 pt-2">
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              type="button"
              onClick={() => void section.save()}
              disabled={!dirty || saving || !ttlValid}
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
