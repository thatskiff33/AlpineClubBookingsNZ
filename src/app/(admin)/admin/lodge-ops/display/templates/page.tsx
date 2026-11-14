"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  FieldHint,
  describedByFieldHint,
  useFieldHint,
} from "@/components/ui/field-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BackLink } from "@/components/admin/back-link";
import {
  DisplayTokenTextarea,
  useDisplayLodgeConfig,
} from "@/components/admin/display-token-textarea";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { listDisplayCssTokens } from "@/lib/lodge-display/css-tokens";
import { listDisplayModules } from "@/lib/lodge-display/module-registry";
import { isBuiltInDisplayTemplateKey } from "@/lib/lodge-display/built-in-seeds";
import {
  buildSlots,
  buildSlotContentPayload,
  reseedSlotFromDefault,
  type AreaDefinition,
  type OptionDraft,
  type SlotDraft,
} from "./template-slots";
import {
  DisplayTemplatesEmptyState,
  shouldOfferBuiltInRestore,
  templatesLoadStateForStatus,
  useRestoreBuiltInBoards,
  type TemplatesLoadState,
} from "./restore-built-ins";
import { DISPLAY_TERM_TEMPLATE } from "@/lib/lodge-display/display-terminology";
import { adminHref, adminLink } from "@/lib/admin-hubs";

// Lobby display TEMPLATE authoring (fork issue #79, LTV-033, ADR-003 §1). A
// Template is built on a Layout: it fills each declared slot with content or an
// embedded module, layers CSS overrides on the layout default, and carries the
// footer. It renders dynamically against whichever lodge its display is bound
// to — lodge-specific values come from `{{config:…}}` tokens.
//
// Deliberate design notes:
//  • Slot content is authored in plain monospace <textarea>s (HTML mode) or a
//    module dropdown + scalar options (Module mode), NOT the website
//    page-content rich editor. That editor (page-content-panel.tsx) is a
//    heavyweight surface coupled to EditablePageRecord CRUD, uploads, and page
//    save endpoints — not a reusable rich-text field — so wiring it in is out
//    of scope for a v1. Safety does not depend on the editor: all authored HTML
//    is sanitised at serve time (LTV-029) and validated by the shared save
//    contract server-side. This is a noted deviation from the epic brief; the
//    owner can revisit if a reusable rich editor is extracted later.
//  • The Layout binding is chosen once and LOCKED after creation — changing it
//    would orphan slot content authored against the original layout's areas.
//  • Slot boxes are GENERATED from the bound layout's areas (static/conditional
//    → one box keyed by the area; rotator → one box per child keyed
//    "area/child"), each seeded from the layout's defaultContent when present.

interface LayoutOption {
  id: string;
  key: string;
  name: string;
}

interface LodgeOption {
  id: string;
  name: string;
}

interface TemplateDraft {
  /** null → creating; a string → editing that template id. */
  id: string | null;
  key: string;
  name: string;
  layoutId: string;
  layoutName: string;
  slots: SlotDraft[];
  cssOverrides: string;
  footerHtml: string;
}

interface TemplateListItem {
  id: string;
  key: string;
  name: string;
  layout: { id: string; key: string; name: string };
  deviceCount: number;
  updatedAt: string;
}

interface ValidationIssue {
  path: string;
  message: string;
}

/*
  #2264 — the slot HTML hint id, spelled EXACTLY ONCE. Slots render inside a
  `.map()`, so `useFieldHint` cannot be called per row and the id is derived
  from the row index instead; deriving it at each use site would mean the same
  template literal written twice, where a typo in either copy silently orphans
  the hint with nothing failing.
*/
function slotHtmlHintId(index: number) {
  return `slot-html-hint-${index}`;
}

/*
  #2264 review — the HTML textarea's ONLY accessible name is built from the
  slot's label, and a label is authored data: a layout can declare a slot with
  a blank one (which would leave the textarea unnamed again) or two slots with
  the SAME one (which would give two textareas the same name, ambiguous to a
  screen reader and to Playwright alike). The slot key is unique by
  construction — it is this list's React key — so it stands in for a blank
  label and disambiguates a repeated one. The row index is the last resort, for
  the theoretical slot with neither.
*/
function slotFieldName(
  slots: readonly SlotDraft[],
  slot: SlotDraft,
  index: number,
): string {
  if (!slot.label.trim()) {
    return slot.slotKey.trim() || `Slot ${index + 1}`;
  }
  const isDuplicate =
    slots.filter((other) => other.label.trim() === slot.label.trim()).length > 1;
  return isDuplicate && slot.slotKey.trim()
    ? `${slot.label} (${slot.slotKey})`
    : slot.label;
}

function emptyDraft(): TemplateDraft {
  return {
    id: null,
    key: "",
    name: "",
    layoutId: "",
    layoutName: "",
    slots: [],
    cssOverrides: "",
    footerHtml: "",
  };
}

export default function AdminDisplayTemplatesPage() {
  const [templates, setTemplates] = useState<TemplateListItem[]>([]);
  const [layouts, setLayouts] = useState<LayoutOption[]>([]);
  const [lodges, setLodges] = useState<LodgeOption[]>([]);
  const [previewLodgeId, setPreviewLodgeId] = useState("");
  const [lodgeLoadError, setLodgeLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Why the gallery is empty, when it is (#2247) — see restore-built-ins.tsx.
  const [loadState, setLoadState] = useState<TemplatesLoadState>("loading");
  const [draft, setDraft] = useState<TemplateDraft>(emptyDraft);
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<ValidationIssue[]>([]);
  const [warnings, setWarnings] = useState<ValidationIssue[]>([]);
  const [saving, setSaving] = useState(false);
  // Display templates resolve to the "lodge" area, so gate authoring on
  // lodge:edit — a lodge:view admin can open a template and preview it (a
  // view-level action) but every input, and the Save/Delete/Add/Duplicate write
  // controls, stay disabled (#1940).
  const canEdit = useAdminAreaEditAccess("lodge");
  // #2264 — authoring examples move out of the placeholders. Where a muted note
  // already sat under the field, the example is folded INTO that note and the
  // note promoted to a FieldHint, so nothing gains a second line.
  const keyHint = useFieldHint();
  const nameHint = useFieldHint();
  const cssHint = useFieldHint();
  const footerHint = useFieldHint();

  // Closed registries surfaced read-only into the editor (client-safe pure data).
  const modules = useMemo(() => listDisplayModules(), []);
  const cssTokens = useMemo(() => listDisplayCssTokens(), []);

  // The preview lodge's live {{config:…}} keys for the token assistant (#2248,
  // decision 2: the picker follows the existing preview-lodge selector — it
  // only helps you type; a template stays lodge-agnostic).
  const previewLodgeConfig = useDisplayLodgeConfig(previewLodgeId);

  // A built-in template is code-managed scaffolding: `ensureBuiltInDisplays`
  // refreshes it from code on every re-seed — the database seed, or the
  // Restore built-in boards action (owner decision A, #111; #2247) — so
  // an in-place edit does not survive. Detected by the reserved KEY (the seed
  // matches on key). Only an EXISTING row can be a built-in. Drives the
  // persistent notice + the not-upgrade-safe save confirm (#156).
  const editingBuiltIn =
    draft.id !== null && isBuiltInDisplayTemplateKey(draft.key);

  const refresh = useCallback(async () => {
    // NOTHING in here may leave the page on "Loading…" — that permanent blank
    // screen is the bug this issue exists to remove (#2247), so the exit is
    // guaranteed in `finally` rather than by every path remembering to reach
    // the last line. Two failure shapes have to be survived, not just one:
    // the fetch REJECTING (transport), and a response that is fine by status
    // but whose BODY will not parse — a proxy error page served as 200, a
    // truncated payload. Both are caught, and both land the gallery in a state
    // that explains itself instead of spinning.
    try {
      const [templatesRes, layoutsRes, lodgesRes] = await Promise.all([
        fetch("/api/admin/display/templates").catch(() => null),
        fetch("/api/admin/display/layouts").catch(() => null),
        // Same source the Devices page uses: the admin lodges list. When more
        // than one active lodge exists the preview lodge selector appears (a
        // template is lodge-agnostic, so its preview lodge must be chosen).
        fetch("/api/admin/lodges").catch(() => null),
      ]);
      // No response at all → status 0, which maps to the "unreachable" state.
      setLoadState(templatesLoadStateForStatus(templatesRes?.status ?? 0));

      if (templatesRes?.ok) {
        const body = (await templatesRes.json().catch(() => null)) as {
          templates?: TemplateListItem[];
        } | null;
        // A 200 whose body is not JSON is a broken response, not an empty
        // gallery: saying "no templates yet — restore the built-ins" there
        // would be a confident lie. It reads as the unexplained failure it is.
        if (body === null) setLoadState("error");
        else setTemplates(body.templates ?? []);
      }
      if (layoutsRes?.ok) {
        const body = (await layoutsRes.json().catch(() => null)) as {
          layouts?: LayoutOption[];
        } | null;
        setLayouts(body?.layouts ?? []);
      }
      if (lodgesRes?.ok) {
        const body = (await lodgesRes.json().catch(() => null)) as {
          lodges?: Array<{ id: string; name: string; active?: boolean }>;
        } | null;
        const active = (body?.lodges ?? []).filter(
          (lodge) => lodge.active !== false
        );
        setLodges(active.map((lodge) => ({ id: lodge.id, name: lodge.name })));
        setPreviewLodgeId((current) => current || active[0]?.id || "");
        setLodgeLoadError(
          active.length === 0 ? "No active lodge is available for previews." : null,
        );
      } else {
        setLodges([]);
        setPreviewLodgeId("");
        setLodgeLoadError(
          "The lodge list could not be loaded. Preview is stopped rather than silently using a default lodge.",
        );
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // "Restore built-in boards" (#2247): re-seeds the code-managed `builtin-*`
  // layouts/templates for an install whose database predates the display
  // feature (nothing but the seed ever creates them). Convergent, so the hook
  // confirms the overwrite first.
  const restoreBuiltIns = useRestoreBuiltInBoards({
    onResult: useCallback(
      (text: string, restored: boolean) => {
        setMessage(text);
        if (restored) void refresh();
      },
      [refresh]
    ),
  });

  function startNew() {
    setDraft(emptyDraft());
    setErrors([]);
    setWarnings([]);
    setMessage(null);
  }

  // Fork the opened built-in into a NEW custom template (id cleared → a create),
  // carrying its layout binding, slots, CSS, and footer but a fresh key/name so
  // the admin customises the copy instead of the re-seed-clobbered original
  // (#156, design.md §3/§8). The built-in itself is untouched until the copy is
  // saved; with the id cleared the layout binding becomes editable again.
  function duplicateTemplate() {
    setErrors([]);
    setWarnings([]);
    setDraft((current) => ({
      ...current,
      id: null,
      key: current.key ? `${current.key}-copy` : "",
      name: current.name ? `${current.name} (copy)` : "",
    }));
    setMessage(
      "Duplicated to a new custom template — adjust the key and name, then " +
        "Create it. The built-in is unchanged."
    );
  }

  // Choosing a layout (create mode only) loads its areas and generates the slot
  // boxes seeded from the layout defaults.
  async function chooseLayout(layoutId: string) {
    if (layoutId === "") {
      setDraft((current) => ({ ...current, layoutId: "", layoutName: "", slots: [] }));
      return;
    }
    const response = await fetch(`/api/admin/display/layouts/${layoutId}`);
    if (!response.ok) {
      setMessage("Could not load that layout");
      return;
    }
    const body = (await response.json()) as {
      layout: { id: string; name: string; areas: unknown };
    };
    const areas = Array.isArray(body.layout.areas)
      ? (body.layout.areas as AreaDefinition[])
      : [];
    setDraft((current) => ({
      ...current,
      layoutId: body.layout.id,
      layoutName: body.layout.name,
      slots: buildSlots(areas),
    }));
  }

  async function editTemplate(id: string) {
    setErrors([]);
    setWarnings([]);
    setMessage(null);
    const response = await fetch(`/api/admin/display/templates/${id}`);
    if (!response.ok) {
      setMessage("Could not load that template");
      return;
    }
    const body = (await response.json()) as {
      template: {
        id: string;
        key: string;
        name: string;
        layout: { id: string; name: string; areas: unknown };
        slotContent: unknown;
        cssOverrides: string;
        footerHtml: string;
      };
    };
    const areas = Array.isArray(body.template.layout.areas)
      ? (body.template.layout.areas as AreaDefinition[])
      : [];
    const slotContent =
      body.template.slotContent &&
      typeof body.template.slotContent === "object" &&
      !Array.isArray(body.template.slotContent)
        ? (body.template.slotContent as Record<string, unknown>)
        : {};
    setDraft({
      id: body.template.id,
      key: body.template.key,
      name: body.template.name,
      layoutId: body.template.layout.id,
      layoutName: body.template.layout.name,
      slots: buildSlots(areas, slotContent),
      cssOverrides: body.template.cssOverrides,
      footerHtml: body.template.footerHtml,
    });
  }

  // Preview opens the sandboxed host page (LTV-036, ADR-003 §5), NOT /display
  // directly: the host mints a signed grant and renders the authored template in
  // an `sandbox="allow-scripts"` iframe, so it can never execute against this
  // admin session. The lodge is passed explicitly so the preview is
  // never a silent default (#64).
  function previewTemplate(item: TemplateListItem) {
    if (!previewLodgeId) {
      setMessage("Choose an explicit lodge before opening a preview.");
      return;
    }
    const params = new URLSearchParams({
      templateId: item.id,
      templateName: item.name,
    });
    params.set("previewLodge", previewLodgeId);
    window.open(
      `${adminHref("display-preview")}?${params.toString()}`,
      "_blank",
      "noopener,noreferrer"
    );
  }

  async function deleteTemplate(item: TemplateListItem) {
    setMessage(null);
    if (
      !window.confirm(
        `Delete template "${item.name}" (${item.key})? This cannot be undone.`
      )
    ) {
      return;
    }
    const response = await fetch(`/api/admin/display/templates/${item.id}`, {
      method: "DELETE",
    });
    if (response.status === 403) {
      setMessage(ADMIN_FORBIDDEN_SAVE_REASON);
      return;
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;
      setMessage(body?.error ?? "Could not delete the template");
      return;
    }
    if (draft.id === item.id) startNew();
    setMessage(`Deleted template "${item.name}".`);
    await refresh();
  }

  async function save() {
    // Built-in templates are code-managed and READ-ONLY: the PUT route now 409s
    // on a `builtin-*` key (#2048), so an in-place save can never persist. Never
    // fire that doomed PUT — offer the duplicate-to-customise fork instead, the
    // only path that keeps the admin's changes (#156, #2048 D).
    if (draft.id !== null && isBuiltInDisplayTemplateKey(draft.key)) {
      if (
        window.confirm(
          `"${draft.name || draft.key}" is a built-in template and is ` +
            "read-only — in-place edits can't be saved (they would be " +
            "overwritten the next time the database is seeded or someone " +
            "presses Restore built-in boards). Duplicate it to a new custom " +
            "template to keep your changes?\n\nOK duplicates it now; Cancel " +
            "leaves the built-in open."
        )
      ) {
        duplicateTemplate();
      }
      return;
    }

    setSaving(true);
    setErrors([]);
    setWarnings([]);
    setMessage(null);

    const payload = {
      key: draft.key.trim(),
      name: draft.name.trim(),
      layoutId: draft.layoutId,
      slotContent: buildSlotContentPayload(draft.slots),
      cssOverrides: draft.cssOverrides,
      footerHtml: draft.footerHtml,
    };

    const editing = draft.id !== null;
    const response = await fetch(
      editing
        ? `/api/admin/display/templates/${draft.id}`
        : "/api/admin/display/templates",
      {
        method: editing ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }
    );

    const body = (await response.json().catch(() => null)) as
      | {
          template?: { id: string; key: string; name: string };
          warnings?: ValidationIssue[];
          errors?: ValidationIssue[];
          error?: string;
        }
      | null;

    setSaving(false);

    if (!response.ok) {
      if (response.status === 403) {
        setMessage(ADMIN_FORBIDDEN_SAVE_REASON);
      } else if (body?.errors && body.errors.length > 0) {
        setErrors(body.errors);
        setWarnings(body.warnings ?? []);
      } else {
        setMessage(body?.error ?? "Save failed");
      }
      return;
    }

    setWarnings(body?.warnings ?? []);
    setMessage(
      `Template "${body?.template?.name ?? draft.name}" saved.` +
        (body?.warnings && body.warnings.length > 0
          ? " Some CSS was flagged — see the notices below."
          : "")
    );
    // A create now has an id; keep editing it so a follow-up save is a PUT.
    if (!editing && body?.template) {
      setDraft((current) => ({ ...current, id: body.template!.id }));
    }
    await refresh();
  }

  // --- Slot-row mutation helpers -----------------------------------------
  function updateSlot(index: number, patch: Partial<SlotDraft>) {
    setDraft((current) => ({
      ...current,
      slots: current.slots.map((slot, i) =>
        i === index ? { ...slot, ...patch } : slot
      ),
    }));
  }

  // Re-seed one slot's editor from its layout-provided default (issue #111),
  // reusing the same seeding path buildSlots uses on create. Only offered for
  // slots whose area declares a defaultContent (static/conditional built-ins).
  function resetSlotToDefault(index: number) {
    setDraft((current) => ({
      ...current,
      slots: current.slots.map((slot, i) =>
        i === index ? reseedSlotFromDefault(slot) : slot
      ),
    }));
  }

  function updateOption(slotIndex: number, optionIndex: number, patch: Partial<OptionDraft>) {
    setDraft((current) => ({
      ...current,
      slots: current.slots.map((slot, i) =>
        i === slotIndex
          ? {
              ...slot,
              options: slot.options.map((option, oi) =>
                oi === optionIndex ? { ...option, ...patch } : option
              ),
            }
          : slot
      ),
    }));
  }

  const selectClass =
    "border-input bg-background h-9 rounded-md border px-3 text-sm";
  const textareaClass =
    "border-input bg-background w-full rounded-md border p-3 font-mono text-xs";

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It sits OUTSIDE the `space-y-*` stack so
    the empty wrapper an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view the lobby display templates but cannot change
      them. Lodge edit access is required to author, edit, or delete a
      template, or to restore the built-in boards. Preview stays available.
    </AdminViewOnlySectionBanner>
  );

  return (
    <div className="p-6">
      {viewOnlyBanner}
      <div className="space-y-6">
      <div>
        <BackLink {...adminLink("display")} />
        <h1 className="mt-2 text-2xl font-bold">Display Templates</h1>
        <p className="text-muted-foreground">
          {/* The shared definition (#2247) — same words as the hub card, the
              Reference page and the operator guide. */}
          {DISPLAY_TERM_TEMPLATE.oneLiner} Bind one to a display on the{" "}
          <strong>Devices</strong> page.
        </p>
        <p className="text-muted-foreground mt-1 text-sm">
          Templates render against whichever lodge their display is bound to —
          lodge-specific values come from{" "}
          <code className="bg-muted rounded px-1">{"{{config:…}}"}</code> tokens.
        </p>
      </div>

      {/*
        Permanently-mounted polite live region (#2247), the house idiom: the
        outcome of a save, a delete, or a built-in restore is announced rather
        than only appearing. A region injected already-populated is silently
        dropped by some screen-reader/browser pairings, so the wrapper is
        mounted unconditionally and only its content is gated.
      */}
      <div role="status" aria-live="polite">
        {message && <p className="text-sm font-medium">{message}</p>}
      </div>

      {lodgeLoadError ? (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>{lodgeLoadError}</p>
          <Button type="button" variant="outline" onClick={() => void refresh()}>
            Try again
          </Button>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Templates</CardTitle>
        </CardHeader>
        <CardContent>
          {loading && <p className="text-muted-foreground text-sm">Loading…</p>}
          {!loading && templates.length === 0 && (
            <DisplayTemplatesEmptyState state={loadState} canEdit={canEdit} />
          )}
          <div className="space-y-3">
            {templates.map((item) => (
              <div
                key={item.id}
                className="flex flex-wrap items-center gap-3 border-b pb-3 last:border-b-0"
              >
                <div className="min-w-64 flex-1">
                  <p className="font-medium">
                    {item.name}{" "}
                    <code className="bg-muted text-muted-foreground ml-1 rounded px-1.5 py-0.5 font-mono text-xs">
                      {item.key}
                    </code>
                  </p>
                  <p className="text-muted-foreground text-sm">
                    Layout: {item.layout.name}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {item.deviceCount === 0
                      ? "No devices use this template"
                      : item.deviceCount === 1
                        ? "1 device uses this template"
                        : `${item.deviceCount} devices use this template`}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {lodges.length > 1 && (
                    <select
                      className={selectClass}
                      aria-label="Preview lodge"
                      title="Lodge to preview this template against — the Insert token picker lists this lodge's saved config keys"
                      value={previewLodgeId}
                      onChange={(event) => setPreviewLodgeId(event.target.value)}
                    >
                      {lodges.map((lodge) => (
                        <option key={lodge.id} value={lodge.id}>
                          {lodge.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <Button
                    variant="outline"
                    disabled={!previewLodgeId || lodgeLoadError !== null}
                    onClick={() => previewTemplate(item)}
                  >
                    Preview
                  </Button>
                  <Button
                    variant="outline"
                    title="Open in the visual builder (falls back to Advanced mode if it was hand-edited)"
                    onClick={() =>
                      window.open(
                        `${adminHref("display-builder")}?templateId=${encodeURIComponent(item.id)}`,
                        "_self"
                      )
                    }
                  >
                    Builder
                  </Button>
                  <Button variant="outline" onClick={() => void editTemplate(item.id)}>
                    Edit (Advanced)
                  </Button>
                  <ViewOnlyActionButton
                    canEdit={canEdit}
                    describeReason={false}
                    variant="destructive"
                    onClick={() => void deleteTemplate(item)}
                  >
                    Delete
                  </ViewOnlyActionButton>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={startNew}>
              New template
            </Button>
            {restoreBuiltIns.confirmDialog}
            {/*
              Offered only where it could actually work: with the module off,
              the session expired, the guard refusing, or the server
              unreachable, the POST fails by construction and the empty state
              already says what to do instead (#2247).

              NOT disabled while running — Radix restores focus to the trigger
              as the dialog closes, and a trigger disabled in that same turn
              drops focus to <body>. The label carries the busy state and the
              hook drops a re-entrant press.
            */}
            {shouldOfferBuiltInRestore(loadState) && (
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={false}
                variant="outline"
                aria-busy={restoreBuiltIns.running}
                title="Create (or re-create) the built-in layouts and templates that ship with the app"
                onClick={() => void restoreBuiltIns.run()}
              >
                {restoreBuiltIns.running
                  ? "Restoring…"
                  : "Restore built-in boards"}
              </ViewOnlyActionButton>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            {draft.id ? `Edit template — ${draft.name || draft.key}` : "New template"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {editingBuiltIn && (
            <div
              role="note"
              className="space-y-2 rounded-md border border-warning-7/50 bg-warning-3 p-3 text-sm text-warning-11"
            >
              <p className="font-medium">This is a built-in template.</p>
              <p>
                In-place edits to a built-in are{" "}
                <strong>overwritten</strong> the next time the database is
                seeded or someone presses <strong>Restore built-in boards</strong>.
                To keep your changes, duplicate this template and customise the
                copy instead.
              </p>
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={false}
                variant="outline"
                className="h-9"
                onClick={duplicateTemplate}
              >
                Duplicate to customise
              </ViewOnlyActionButton>
            </div>
          )}
          <div className="flex flex-wrap gap-4">
            <div className="space-y-1">
              <Label htmlFor="template-key">Key</Label>
              <Input
                id="template-key"
                className="w-56 font-mono"
                value={draft.key}
                disabled={draft.id !== null || !canEdit}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, key: event.target.value }))
                }
                {...keyHint.fieldProps}
              />
              <FieldHint {...keyHint.hintProps}>
                {draft.id
                  ? "Locked — the key is fixed once devices bind to it."
                  : "Lower-case slug, for example foyer-board. Fixed after creation."}
              </FieldHint>
            </div>
            <div className="min-w-64 flex-1 space-y-1">
              <Label htmlFor="template-name">Name</Label>
              <Input
                id="template-name"
                value={draft.name}
                disabled={!canEdit}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, name: event.target.value }))
                }
                {...nameHint.fieldProps}
              />
              <FieldHint {...nameHint.hintProps}>Example: Foyer board</FieldHint>
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="template-layout">Layout</Label>
            {draft.id ? (
              <p className="text-sm">
                <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
                  {draft.layoutName}
                </code>{" "}
                <span className="text-muted-foreground">
                  — locked. The layout is fixed after creation; its slots are
                  authored below.
                </span>
              </p>
            ) : (
              <>
                <select
                  id="template-layout"
                  className={selectClass}
                  value={draft.layoutId}
                  disabled={!canEdit}
                  onChange={(event) => void chooseLayout(event.target.value)}
                >
                  <option value="">— select a layout —</option>
                  {layouts.map((layout) => (
                    <option key={layout.id} value={layout.id}>
                      {layout.name}
                    </option>
                  ))}
                </select>
                <p className="text-muted-foreground text-xs">
                  Choose the structural layout to fill. Locked once the template
                  is created.
                </p>
              </>
            )}
          </div>

          {draft.layoutId !== "" && (
            <div className="space-y-3">
              <Label>Slots</Label>
              {draft.slots.length === 0 && (
                <p className="text-muted-foreground text-sm">
                  This layout declares no fillable slots.
                </p>
              )}
              {draft.slots.map((slot, index) => (
                <div key={slot.slotKey} className="space-y-3 rounded-md border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium">
                        <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
                          {slot.label}
                        </code>
                      </p>
                      {slot.description && (
                        <p className="text-muted-foreground text-sm">
                          {slot.description}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {slot.defaultContent !== undefined && (
                        <Button
                          variant="outline"
                          className="h-9"
                          title="Re-seed this slot from the layout's default content"
                          disabled={!canEdit}
                          onClick={() => resetSlotToDefault(index)}
                        >
                          Reset to default
                        </Button>
                      )}
                      <Label className="text-xs" htmlFor={`slot-mode-${index}`}>
                        Mode
                      </Label>
                      <select
                        id={`slot-mode-${index}`}
                        className={selectClass}
                        value={slot.mode}
                        disabled={!canEdit}
                        onChange={(event) =>
                          updateSlot(index, {
                            mode: event.target.value as "html" | "module",
                          })
                        }
                      >
                        <option value="html">HTML</option>
                        <option value="module">Module</option>
                      </select>
                    </div>
                  </div>

                  {slot.mode === "html" ? (
                    <div className="space-y-1">
                      <textarea
                        id={`slot-html-${index}`}
                        className={`${textareaClass} min-h-24`}
                        spellCheck={false}
                        disabled={!canEdit}
                        /* #2264 — this textarea had no Label; the placeholder
                           was its only accessible name, so it is named here in
                           the same edit that removes the example. */
                        aria-label={`${slotFieldName(draft.slots, slot, index)} HTML`}
                        value={slot.html}
                        onChange={(event) =>
                          updateSlot(index, { html: event.target.value })
                        }
                        aria-describedby={describedByFieldHint(
                          slotHtmlHintId(index),
                        )}
                      />
                      <FieldHint id={slotHtmlHintId(index)}>
                        Leave empty to show nothing here. HTML with tokens:{" "}
                        <code className="bg-muted rounded px-1">
                          {"{{config:key}}"}
                        </code>
                        ,{" "}
                        <code className="bg-muted rounded px-1">
                          {"{{lodge-name}}"}
                        </code>
                        ,{" "}
                        <code className="bg-muted rounded px-1">
                          {"{{display-date}}"}
                        </code>
                        , and a{" "}
                        <code className="bg-muted rounded px-1">
                          {"{{module:name}}"}
                        </code>{" "}
                        embed — for example{" "}
                        <code className="bg-muted rounded px-1">
                          {"<p>{{lodge-name}}</p>"}
                        </code>
                        . Scripts and external URLs are stripped on serve.
                      </FieldHint>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="space-y-1">
                        <Label className="text-xs" htmlFor={`slot-module-${index}`}>
                          Module
                        </Label>
                        <select
                          id={`slot-module-${index}`}
                          className={selectClass}
                          value={slot.moduleName}
                          disabled={!canEdit}
                          onChange={(event) =>
                            updateSlot(index, { moduleName: event.target.value })
                          }
                        >
                          <option value="">— select a module —</option>
                          {modules.map((module) => (
                            <option
                              key={module.name}
                              value={module.name}
                              title={module.description}
                            >
                              {module.label}
                            </option>
                          ))}
                        </select>
                        {slot.moduleName && (
                          <p className="text-muted-foreground text-xs">
                            {
                              modules.find((m) => m.name === slot.moduleName)
                                ?.description
                            }
                          </p>
                        )}
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs">Options (scalar key / value)</Label>
                        {slot.options.map((option, optionIndex) => (
                          <div
                            key={optionIndex}
                            className="flex flex-wrap items-center gap-2"
                          >
                            <Input
                              className="w-44 font-mono"
                              placeholder="option-key"
                              value={option.key}
                              disabled={!canEdit}
                              onChange={(event) =>
                                updateOption(index, optionIndex, {
                                  key: event.target.value,
                                })
                              }
                            />
                            <Input
                              className="min-w-40 flex-1"
                              placeholder="value"
                              value={option.value}
                              disabled={!canEdit}
                              onChange={(event) =>
                                updateOption(index, optionIndex, {
                                  value: event.target.value,
                                })
                              }
                            />
                            <Button
                              variant="outline"
                              disabled={!canEdit}
                              onClick={() =>
                                updateSlot(index, {
                                  options: slot.options.filter(
                                    (_, oi) => oi !== optionIndex
                                  ),
                                })
                              }
                            >
                              Remove
                            </Button>
                          </div>
                        ))}
                        <Button
                          variant="outline"
                          disabled={!canEdit}
                          onClick={() =>
                            updateSlot(index, {
                              options: [...slot.options, { key: "", value: "" }],
                            })
                          }
                        >
                          Add option
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="space-y-1">
            {/* Token assistant on the label row (#2248); the static token
                sentence below stays — the picker is additive (decision 4). */}
            <DisplayTokenTextarea
              id="template-css"
              label="CSS overrides"
              mode="css"
              value={draft.cssOverrides}
              onValueChange={(next) =>
                setDraft((current) => ({ ...current, cssOverrides: next }))
              }
              disabled={!canEdit}
              /* #2264 — the example moves into the note below. The textarea
                 lives inside the shared token component, so the wiring is
                 threaded through its `describedBy` prop rather than spread. */
              describedBy={cssHint.fieldProps["aria-describedby"]}
              textareaClassName="min-h-24"
            />
            <FieldHint {...cssHint.hintProps}>
              Example:{" "}
              <code className="bg-muted rounded px-1">
                {".board { color: var(--brand-gold); }"}
              </code>
              . Layered after the layout default. Theme tokens you can reach
              for:{" "}
              {cssTokens.map((token, i) => (
                <span key={token.name}>
                  {i > 0 && ", "}
                  <code className="bg-muted rounded px-1" title={token.description}>
                    var({token.name})
                  </code>
                </span>
              ))}
              . External URLs, <code>@import</code>, and script vectors are
              stripped automatically on save.
            </FieldHint>
          </div>

          <div className="space-y-1">
            {/* Token assistant on the label row (#2248); the static token
                sentence below stays — the picker is additive (decision 4). */}
            <DisplayTokenTextarea
              id="template-footer"
              label="Footer HTML"
              mode="html"
              value={draft.footerHtml}
              onValueChange={(next) =>
                setDraft((current) => ({ ...current, footerHtml: next }))
              }
              disabled={!canEdit}
              describedBy={footerHint.fieldProps["aria-describedby"]}
              textareaClassName="min-h-20"
              configSource={previewLodgeConfig}
            />
            <FieldHint {...footerHint.hintProps}>
              The page footer. HTML with the same tokens, or a{" "}
              <code className="bg-muted rounded px-1">{"{{module:name}}"}</code>{" "}
              embed — for example{" "}
              <code className="bg-muted rounded px-1">
                {"Wi-Fi: {{config:wifi-code}} · {{lodge-name}}"}
              </code>
              .
            </FieldHint>
          </div>

          {errors.length > 0 && (
            <div className="border-destructive/40 bg-destructive/10 text-destructive space-y-1 rounded-md border p-3 text-sm">
              <p className="font-medium">This template can&apos;t be saved yet:</p>
              <ul className="list-disc space-y-0.5 pl-5">
                {errors.map((issue, i) => (
                  <li key={i}>
                    <code className="font-mono text-xs">{issue.path}</code> —{" "}
                    {issue.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {warnings.length > 0 && (
            <div className="space-y-1 rounded-md border border-warning-7/50 bg-warning-3 p-3 text-sm text-warning-11">
              <p className="font-medium">
                Saved, but some CSS was neutralised on the way in:
              </p>
              <ul className="list-disc space-y-0.5 pl-5">
                {warnings.map((issue, i) => (
                  <li key={i}>
                    <code className="font-mono text-xs">{issue.path}</code> —{" "}
                    {issue.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex items-center gap-3">
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              onClick={() => void save()}
              disabled={saving || !draft.name || !draft.key || draft.layoutId === ""}
            >
              {draft.id ? "Save changes" : "Create template"}
            </ViewOnlyActionButton>
            {draft.id && (
              <Button variant="outline" onClick={startNew} disabled={saving}>
                Cancel
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
      </div>
    </div>
  );
}
