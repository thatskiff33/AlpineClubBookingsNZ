"use client";

import { useId, useRef } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FieldHint, describedByFieldHint } from "@/components/ui/field-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  ForbiddenSaveError,
  useSectionEditState,
} from "@/hooks/use-section-edit-state";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import {
  PRIVACY_HOSTING_TEXT_LIMIT,
  privacyHostingSchema,
  type PrivacyHostingValues,
} from "@/lib/privacy-hosting";

/** What the form edits: each nullable setting as the text its box holds. */
type Draft = Record<keyof PrivacyHostingValues, string>;

/** `[key, label, hint]` for the two disclosure fields (#4918). */
const fields: Array<[keyof PrivacyHostingValues, string, string]> = [
  [
    "hostingProvider",
    "Hosting provider",
    "The company that runs the club's server and database.",
  ],
  [
    "dataLocation",
    "Where your data is held",
    "The country or region. If the database and backups are held in different places, name both.",
  ],
];

const ENDPOINT = "/api/admin/privacy-hosting";
const LOAD_ERROR = "Could not load hosting details.";
const SAVE_ERROR = "Could not update hosting details.";
export const PRIVACY_HOSTING_TITLE = "Where members' data is held";

function toDraft(settings: PrivacyHostingValues): Draft {
  return {
    hostingProvider: settings.hostingProvider ?? "",
    dataLocation: settings.dataLocation ?? "",
  };
}

/** One field's value as the route would store it, or `undefined` when the route would refuse it. */
function stored(value: string): string | null | undefined {
  const parsed = privacyHostingSchema.shape.hostingProvider.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/*
  The dirty gate compares what the route would STORE (trimmed, blank as null),
  so a trailing space or clearing an unset box cannot arm a Save that writes an
  unchanged row and a misleading audit entry (#2143).
*/
function hostingChanged(draft: Draft, saved: Draft): boolean {
  return fields.some(([key]) => stored(draft[key]) !== stored(saved[key]));
}

function hostingValid(draft: Draft): boolean {
  return fields.every(([key]) => stored(draft[key]) !== undefined);
}

/**
 * The club's hosting disclosure (#4918), on the canonical staged settings
 * model: read-only on mount, Edit opens both fields, Save writes them once and
 * only when changed, Cancel restores the saved snapshot. The values feed the
 * `{{data-hosting}}` page token; the sentence itself is built server-side by
 * `dataHostingSentence`, never here.
 */
export function PrivacyHostingPanel() {
  const canEdit = useAdminAreaEditAccess("content");
  const viewOnlyReasonId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const section = useSectionEditState<Draft>({
    regionLabel: PRIVACY_HOSTING_TITLE,
    revealTarget: cardRef,
    load: async (signal) => {
      const response = await fetch(ENDPOINT, { signal });
      if (!response.ok) throw new Error(LOAD_ERROR);
      return toDraft((await response.json()).settings);
    },
    save: async (draft) => {
      const response = await fetch(ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hostingProvider: stored(draft.hostingProvider) ?? null,
          dataLocation: stored(draft.dataLocation) ?? null,
        }),
      });
      if (response.status === 403) throw new ForbiddenSaveError();
      if (!response.ok) throw new Error(SAVE_ERROR);
      // Re-seeded from what the server stored, never from the local draft.
      return toDraft((await response.json()).settings);
    },
    successMessage: "Hosting details updated.",
    loadErrorFallback: LOAD_ERROR,
    saveErrorFallback: SAVE_ERROR,
    isDirty: hostingChanged,
    isValid: hostingValid,
  });

  const { draft, editing, saving, dirty, valid, error, success } = section;

  // Permanently mounted in every state so the live region exists from first
  // paint (#2160); the disabled inputs point their description at it.
  const viewOnlyBanner = (
    <div id={viewOnlyReasonId}>
      <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
        Content view access can inspect the hosting details. Content edit access
        is required to change them.
      </AdminViewOnlySectionBanner>
    </div>
  );

  const feedback = (
    <>
      {error ? (
        <Alert variant="error" className="mb-4">
          {error}
        </Alert>
      ) : null}
      {success ? (
        <Alert variant="success" className="mb-4">
          {success}
        </Alert>
      ) : null}
    </>
  );

  if (!draft) {
    return (
      <div>
        {viewOnlyBanner}
        {feedback}
        {section.loading ? (
          <p className="text-sm text-muted-foreground">
            Loading hosting details…
          </p>
        ) : (
          <Button variant="outline" onClick={() => void section.reload()}>
            Retry
          </Button>
        )}
      </div>
    );
  }

  return (
    <div
      {...section.sectionRegionProps}
      ref={cardRef}
      tabIndex={-1}
      className="focus:outline-none"
    >
      {viewOnlyBanner}
      {feedback}
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          These values appear wherever a page body contains the{" "}
          <code>{"{{data-hosting}}"}</code> token. Your published privacy
          policy does not change unless that page contains the token. Leave a
          field blank to publish wording that asks members to contact the
          Privacy Officer instead. Keep these details current.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          {fields.map(([key, label, hint]) => {
            const id = `privacy-hosting-${key}`;
            const hintId = `${id}-hint`;
            const invalid = editing && stored(draft[key]) === undefined;
            return (
              <div key={key} className="space-y-1.5">
                <Label htmlFor={id}>{label}</Label>
                <Input
                  id={id}
                  value={draft[key]}
                  maxLength={PRIVACY_HOSTING_TEXT_LIMIT}
                  disabled={!editing || saving}
                  aria-invalid={invalid || undefined}
                  aria-describedby={describedByFieldHint(
                    hintId,
                    !canEdit ? viewOnlyReasonId : undefined,
                  )}
                  onChange={(event) =>
                    section.setDraft({ [key]: event.target.value })
                  }
                />
                <FieldHint id={hintId}>
                  {invalid
                    ? `Use plain text on one line, at most ${PRIVACY_HOSTING_TEXT_LIMIT} characters.`
                    : hint}
                </FieldHint>
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {editing ? (
            <>
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={false}
                disabled={!dirty || !valid || saving}
                onClick={() => void section.save()}
              >
                {saving ? "Saving…" : "Save hosting details"}
              </ViewOnlyActionButton>
              <Button
                variant="outline"
                disabled={saving}
                onClick={() => {
                  // A failed save's message describes edits Cancel discards.
                  section.setSuccess("");
                  section.setError("");
                  section.cancelEditing();
                }}
              >
                Cancel
              </Button>
            </>
          ) : (
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              variant="outline"
              {...section.editTriggerProps}
              onClick={() => {
                section.setSuccess("");
                section.setError("");
                section.startEditing();
              }}
            >
              Edit
            </ViewOnlyActionButton>
          )}
        </div>
      </div>
    </div>
  );
}
