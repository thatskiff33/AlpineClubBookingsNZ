"use client";

import { useId, useRef } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  FieldHint,
  describedByFieldHint,
} from "@/components/ui/field-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { storedPostalAddress } from "@/lib/postal-address-lines";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  ForbiddenSaveError,
  useSectionEditState,
} from "@/hooks/use-section-edit-state";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";

/**
 * The persisted shape the route reads and writes. Every field is nullable: a
 * null is "no override", and the site falls back to the file configuration.
 */
type Settings = {
  name: string | null;
  shortName: string | null;
  hutLeaderLabel: string | null;
  facebookUrl: string | null;
  /** #5066: the supplier the app's generated booking invoice prints (Xero off). */
  legalName: string | null;
  postalAddress: string | null;
};

/**
 * What the form edits: the same keys as text, because a controlled
 * `<Input>` holds a string. A null override shows as an empty box.
 */
type Draft = Record<keyof Settings, string>;

/*
  #2257 — `[key, label, placeholder, hint]`. The EXAMPLE that used to sit in the
  club-name placeholder now renders as helper text under the field: grey example
  text inside a control reads as a value the form already holds. The other three
  entries are genuine instructions ("Optional — defaults to …"), not examples, so
  their wording and position are untouched here; the repo-wide placeholder sweep
  is #2264.

  #3976 later gave the hut-leader entry a hint too — an instruction, not an
  example: enter the singular, because screens build the plural themselves
  (`pluralHutLeaderLabel`). Its placeholder is unchanged.
*/
const fields: Array<
  [keyof Settings, string, placeholder: string | null, hint: string | null]
> = [
  ["name", "Club name", null, "Example: Alpine Sports Club"],
  ["shortName", "Short name", "Optional — defaults to the club name", null],
  [
    "hutLeaderLabel",
    "Hut-leader label",
    'Optional — defaults to "Hut Leader"',
    // #3976: screens build the plural themselves ("Hut Leaders" in the admin
    // sidebar), so the label must be the singular.
    'Enter the singular, for example "Hut Leader" — the plural is added where needed.',
  ],
  [
    "facebookUrl",
    "Facebook URL",
    "Optional — https://www.facebook.com/yourclub",
    null,
  ],
  // #5066: the supplier on a booking invoice the app makes itself, which it
  // does only while the club's Xero module is off (Xero's own invoice
  // otherwise). The address box is multi-line (`MULTILINE_FIELDS`).
  [
    "legalName",
    "Legal name",
    "Optional — defaults to the club name",
    "The club's registered name, printed as who the invoice is from on booking invoices the app makes when the club does not use Xero.",
  ],
  [
    "postalAddress",
    "Postal address",
    null,
    "One line per line. Printed under the legal name on those invoices; left off while blank.",
  ],
];

const MULTILINE_FIELDS: ReadonlySet<keyof Settings> = new Set(["postalAddress"]);

const ENDPOINT = "/api/admin/club-identity";
const LOAD_ERROR = "Could not load club identity settings.";
const SAVE_ERROR = "Could not update club identity.";

function toDraft(settings: Settings): Draft {
  return {
    name: settings.name ?? "",
    shortName: settings.shortName ?? "",
    hutLeaderLabel: settings.hutLeaderLabel ?? "",
    facebookUrl: settings.facebookUrl ?? "",
    legalName: settings.legalName ?? "",
    postalAddress: settings.postalAddress ?? "",
  };
}

/*
  What the route will STORE for a box: it trims, and turns blank into null
  (`emptyToNull` in the route). The dirty gate compares on that, not on the raw
  text, so retyping a value, adding a trailing space, or clearing a box that was
  already falling back cannot arm a Save that would write an unchanged row and a
  misleading audit entry (#2143).
*/
function stored(key: keyof Settings, value: string): string | null {
  // The address keeps its lines, each trimmed (`storedPostalAddress`, #5066).
  if (MULTILINE_FIELDS.has(key)) return storedPostalAddress(value);
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function identityChanged(draft: Draft, saved: Draft): boolean {
  return fields.some(([key]) => stored(key, draft[key]) !== stored(key, saved[key]));
}

/**
 * Club identity overrides (E3 #1929), on the canonical staged settings model
 * since #3976: read-only on mount, one Edit opens every field, Save writes
 * them once and is dirty-gated by `useSectionEditState`, and Cancel restores the
 * last saved snapshot. All six fields go out in one whole-object PUT that this
 * section alone owns, so there is no sibling card whose fields need merging.
 */
/** The section's title: the page's visible card title and this panel's
 * region name read the one string, so they cannot drift (INV-SSOT-001). */
export const CLUB_IDENTITY_TITLE = "Club identity";

export function ClubIdentityPanel() {
  const canEdit = useAdminAreaEditAccess("content");
  const viewOnlyReasonId = useId();

  const cardRef = useRef<HTMLDivElement>(null);
  const section = useSectionEditState<Draft>({
    // The page renders this panel's title outside it, so it names itself.
    regionLabel: CLUB_IDENTITY_TITLE,
    // Edit unmounts the focused button, so the hook moves focus to the
    // section, as ARCHITECTURE.md's reveal rule asks (#3990 review, #4115).
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
          name: draft.name,
          shortName: draft.shortName,
          hutLeaderLabel: draft.hutLeaderLabel,
          facebookUrl: draft.facebookUrl,
          legalName: draft.legalName,
          postalAddress: draft.postalAddress,
        }),
      });
      if (response.status === 403) throw new ForbiddenSaveError();
      if (!response.ok) throw new Error(SAVE_ERROR);
      // Re-seeded from what the SERVER stored (trimmed, blanks cleared), never
      // from the local draft.
      return toDraft((await response.json()).settings);
    },
    successMessage: "Club identity updated.",
    loadErrorFallback: LOAD_ERROR,
    saveErrorFallback: SAVE_ERROR,
    isDirty: identityChanged,
  });

  const { draft, editing, saving, dirty, error, success } = section;

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It sits OUTSIDE the `space-y-*` stack so
    the empty wrapper an edit-capable admin gets costs no layout. The frame below
    renders it in every state (loading, failed, loaded), so the region exists
    from the first paint rather than from whenever the fetch settles. The
    `viewOnlyReasonId` wrapper is kept because the disabled inputs below still
    point their `aria-describedby` at it.
  */
  const viewOnlyBanner = (
    <div id={viewOnlyReasonId}>
      <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
        Content view access can inspect club identity. Content edit access is
        required to change it.
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
            Loading club identity…
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
        These override the file configuration. Leave a field blank to fall back
        to the configured default. Changes appear across the site and in emails
        within a few seconds.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map(([key, label, placeholder, hint]) => {
          // These rows come from a `.map()`, so a hook cannot be called per row
          // (#2257) — the hint id is derived from the stable field key instead.
          // A view-only admin ALSO has the "you can look but not change this"
          // reason pointed at the control, so both ids are listed, reason first.
          const hintId = `club-identity-hint-${key}`;
          const viewOnlyId = !canEdit ? viewOnlyReasonId : undefined;
          const control = {
            id: `club-identity-${key}`,
            value: draft[key],
            placeholder: placeholder ?? undefined,
            // Read-only until Edit (#3976). Edit itself is permission-gated,
            // so a view-only admin can never reach an enabled field.
            disabled: !editing || saving,
            "aria-describedby": hint
              ? describedByFieldHint(hintId, viewOnlyId)
              : viewOnlyId,
          };
          return (
            <div key={key} className="space-y-1.5">
              <Label htmlFor={`club-identity-${key}`}>{label}</Label>
              {MULTILINE_FIELDS.has(key) ? (
                <Textarea
                  {...control}
                  rows={3}
                  onChange={(event) =>
                    section.setDraft({ [key]: event.target.value })
                  }
                />
              ) : (
                <Input
                  {...control}
                  onChange={(event) =>
                    section.setDraft({ [key]: event.target.value })
                  }
                />
              )}
              {hint ? <FieldHint id={hintId}>{hint}</FieldHint> : null}
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
              disabled={!dirty || saving}
              onClick={() => void section.save()}
            >
              {saving ? "Saving…" : "Save club identity"}
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
