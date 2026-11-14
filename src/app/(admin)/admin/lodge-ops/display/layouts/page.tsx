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
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { listDisplayConditions } from "@/lib/lodge-display/conditions";
import { listDisplayCssTokens } from "@/lib/lodge-display/css-tokens";
import { isBuiltInDisplayLayoutKey } from "@/lib/lodge-display/built-in-seeds";
import { DISPLAY_TERM_LAYOUT } from "@/lib/lodge-display/display-terminology";
import { adminHref, adminLink } from "@/lib/admin-hubs";

// Lobby display LAYOUT authoring (fork issue #78, LTV-032, ADR-003 §1). An
// admin authors the structural template: an HTML body with `{{area:key}}`
// placeholders, a default CSS block, and the area/slot descriptors (static /
// conditional / rotator). Templates (LTV-033) then fill each declared slot.
//
// Deliberate design notes:
//  • Body HTML and Default CSS are edited in plain monospace <textarea>s, NOT
//    the website page-content rich editor. Layout HTML is STRUCTURAL (the
//    `{{area:key}}` skeleton and its element scaffolding); a WYSIWYG editor
//    would fight the author over the raw markup. Slot CONTENT — where the rich
//    editor belongs — is authored per Template (LTV-033), not here.
//  • Conditions come only from the closed registry dropdown (ADR-003 §3): no
//    free-form expressions ever reach the wall.
//  • The save contract (validateLayoutForSave) runs server-side in the API
//    route, never in this client bundle — structural errors and CSS-sanitiser
//    warnings come back in the response.

type AreaKind = "static" | "conditional" | "rotator";

interface ChildDraft {
  key: string;
  description: string;
  /** "" means no condition (always eligible). */
  condition: string;
}

interface AreaDraft {
  key: string;
  description: string;
  kind: AreaKind;
  /** Only used when kind === "conditional". */
  condition: string;
  /** Only used when kind === "rotator" (string input; parsed on save). */
  rotateSeconds: string;
  /** Only used when kind === "rotator". */
  children: ChildDraft[];
  /** Optional default content html (static/conditional only). A module default
   * can be typed inline as `{{module:name}}`; anything richer is left to the
   * Template. */
  defaultContentHtml: string;
}

interface LayoutDraft {
  /** null → creating a new layout; a string → editing that layout id. */
  id: string | null;
  key: string;
  name: string;
  description: string;
  bodyHtml: string;
  defaultCss: string;
  areas: AreaDraft[];
}

interface LayoutListItem {
  id: string;
  key: string;
  name: string;
  description: string | null;
  updatedAt: string;
  templateCount: number;
}

interface ValidationIssue {
  path: string;
  message: string;
}

/*
  #2264 — hint ids for the area rows, each spelled EXACTLY ONCE. The rows render
  inside a `.map()`, so `useFieldHint` cannot be called per row and the id must
  be derived from the row index instead. Deriving it at each use site would mean
  the same template literal written twice, where a typo in either copy silently
  orphans the hint with nothing failing.
*/
function areaKeyHintId(index: number) {
  return `area-key-hint-${index}`;
}

function areaDescriptionHintId(index: number) {
  return `area-description-hint-${index}`;
}

function areaDefaultHintId(index: number) {
  return `area-default-hint-${index}`;
}

function emptyArea(): AreaDraft {
  return {
    key: "",
    description: "",
    kind: "static",
    condition: "",
    rotateSeconds: "",
    children: [{ key: "", description: "", condition: "" }],
    defaultContentHtml: "",
  };
}

function emptyDraft(): LayoutDraft {
  return {
    id: null,
    key: "",
    name: "",
    description: "",
    bodyHtml: "",
    defaultCss: "",
    areas: [emptyArea()],
  };
}

/**
 * Assemble the areas JSON the save contract validates, including only the
 * fields each `kind` allows (the contract rejects a condition on a non-
 * conditional area, children on a non-rotator, defaultContent on a rotator,
 * …). This is also the SEAM for a future preview-before-save (#82/#79): the
 * current draft `{ bodyHtml, defaultCss, areas: buildAreasPayload(draft) }` is
 * exactly the shape a sandboxed preview call will take.
 */
function buildAreasPayload(areas: AreaDraft[]): unknown[] {
  return areas.map((area) => {
    const out: Record<string, unknown> = {
      key: area.key.trim(),
      description: area.description,
      kind: area.kind,
    };
    if (area.kind === "conditional") {
      if (area.condition) out.condition = area.condition;
    }
    if (area.kind === "rotator") {
      const trimmed = area.rotateSeconds.trim();
      if (trimmed !== "") {
        const seconds = Number(trimmed);
        if (Number.isFinite(seconds)) out.rotateSeconds = seconds;
      }
      out.children = area.children.map((child) => {
        const childOut: Record<string, unknown> = {
          key: child.key.trim(),
          description: child.description,
        };
        if (child.condition) childOut.condition = child.condition;
        return childOut;
      });
    } else {
      const html = area.defaultContentHtml.trim();
      if (html !== "") out.defaultContent = { html };
    }
    return out;
  });
}

/** Hydrate an editor draft from a stored layout row (areas is untyped Json). */
function draftFromRow(row: {
  id: string;
  key: string;
  name: string;
  description: string | null;
  bodyHtml: string;
  defaultCss: string;
  areas: unknown;
}): LayoutDraft {
  const areas = Array.isArray(row.areas) ? row.areas : [];
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description ?? "",
    bodyHtml: row.bodyHtml,
    defaultCss: row.defaultCss,
    areas: areas.map((raw) => {
      const area = (raw ?? {}) as Record<string, unknown>;
      const children = Array.isArray(area.children) ? area.children : [];
      const defaultContent = area.defaultContent as
        | { html?: unknown }
        | undefined;
      return {
        key: typeof area.key === "string" ? area.key : "",
        description: typeof area.description === "string" ? area.description : "",
        kind:
          area.kind === "conditional" || area.kind === "rotator"
            ? area.kind
            : "static",
        condition: typeof area.condition === "string" ? area.condition : "",
        rotateSeconds:
          typeof area.rotateSeconds === "number" ? String(area.rotateSeconds) : "",
        children:
          children.length > 0
            ? children.map((rawChild) => {
                const child = (rawChild ?? {}) as Record<string, unknown>;
                return {
                  key: typeof child.key === "string" ? child.key : "",
                  description:
                    typeof child.description === "string" ? child.description : "",
                  condition:
                    typeof child.condition === "string" ? child.condition : "",
                };
              })
            : [{ key: "", description: "", condition: "" }],
        defaultContentHtml:
          defaultContent && typeof defaultContent.html === "string"
            ? defaultContent.html
            : "",
      };
    }),
  };
}

export default function AdminDisplayLayoutsPage() {
  const [layouts, setLayouts] = useState<LayoutListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<LayoutDraft>(emptyDraft);
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<ValidationIssue[]>([]);
  const [warnings, setWarnings] = useState<ValidationIssue[]>([]);
  const [saving, setSaving] = useState(false);
  // Display layouts resolve to the "lodge" area, so gate authoring on
  // lodge:edit — a lodge:view admin can open a layout to read it but every
  // input, and the Save/Delete/Add/Duplicate write controls, stay disabled
  // (#1940).
  const canEdit = useAdminAreaEditAccess("lodge");
  // #2264 — the authoring examples move out of the placeholders. Where a muted
  // note already sat under the field, the example is folded INTO that note and
  // the note is promoted to a FieldHint, so no field gains a second line.
  const keyHint = useFieldHint();
  const nameHint = useFieldHint();
  const bodyHint = useFieldHint();
  const cssHint = useFieldHint();

  // Closed registries surfaced read-only into the editor (client-safe pure data).
  const conditions = useMemo(() => listDisplayConditions(), []);
  const cssTokens = useMemo(() => listDisplayCssTokens(), []);

  // A built-in layout is code-managed scaffolding: `ensureBuiltInDisplays`
  // refreshes it from code on every re-seed — the database seed, or the
  // Restore built-in boards action (owner decision A, #111; #2247) — so
  // an in-place edit does not survive. Detected by the reserved KEY (the seed
  // matches on key). Only an EXISTING row can be a built-in — a new draft never
  // is. Drives the persistent notice + the not-upgrade-safe save confirm (#156).
  const editingBuiltIn =
    draft.id !== null && isBuiltInDisplayLayoutKey(draft.key);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/admin/display/layouts");
    if (response.ok) {
      const body = (await response.json()) as { layouts: LayoutListItem[] };
      setLayouts(body.layouts);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function startNew() {
    setDraft(emptyDraft());
    setErrors([]);
    setWarnings([]);
    setMessage(null);
  }

  // Fork the opened built-in into a NEW custom layout (id cleared → a create),
  // carrying its body/CSS/areas but a fresh key/name so the admin customises the
  // copy instead of the re-seed-clobbered original (#156, design.md §3/§8). The
  // built-in itself is untouched until the admin saves the copy.
  function duplicateLayout() {
    setErrors([]);
    setWarnings([]);
    setDraft((current) => ({
      ...current,
      id: null,
      key: current.key ? `${current.key}-copy` : "",
      name: current.name ? `${current.name} (copy)` : "",
    }));
    setMessage(
      "Duplicated to a new custom layout — adjust the key and name, then " +
        "Create it. The built-in is unchanged."
    );
  }

  async function editLayout(id: string) {
    setErrors([]);
    setWarnings([]);
    setMessage(null);
    const response = await fetch(`/api/admin/display/layouts/${id}`);
    if (!response.ok) {
      setMessage("Could not load that layout");
      return;
    }
    const body = (await response.json()) as {
      layout: {
        id: string;
        key: string;
        name: string;
        description: string | null;
        bodyHtml: string;
        defaultCss: string;
        areas: unknown;
      };
    };
    setDraft(draftFromRow(body.layout));
  }

  async function deleteLayout(item: LayoutListItem) {
    setMessage(null);
    if (
      !window.confirm(
        `Delete layout "${item.name}" (${item.key})? This cannot be undone.`
      )
    ) {
      return;
    }
    const response = await fetch(`/api/admin/display/layouts/${item.id}`, {
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
      setMessage(body?.error ?? "Could not delete the layout");
      return;
    }
    if (draft.id === item.id) startNew();
    setMessage(`Deleted layout "${item.name}".`);
    await refresh();
  }

  async function save() {
    // Built-in layouts are code-managed and READ-ONLY: the PUT route now 409s on
    // a `builtin-*` key (#2048), so an in-place save can never persist. Never
    // fire that doomed PUT — offer the duplicate-to-customise fork instead, the
    // only path that keeps the admin's changes (#156, #2048 D).
    if (draft.id !== null && isBuiltInDisplayLayoutKey(draft.key)) {
      if (
        window.confirm(
          `"${draft.name || draft.key}" is a built-in layout and is ` +
            "read-only — in-place edits can't be saved (they would be " +
            "overwritten the next time the database is seeded or when Restore " +
            "built-in boards is pressed on the Templates page). Duplicate it " +
            "to a new custom layout to keep your changes?\n\nOK duplicates it " +
            "now; Cancel leaves the built-in open."
        )
      ) {
        duplicateLayout();
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
      description: draft.description.trim() === "" ? null : draft.description.trim(),
      bodyHtml: draft.bodyHtml,
      defaultCss: draft.defaultCss,
      areas: buildAreasPayload(draft.areas),
    };

    const editing = draft.id !== null;
    const response = await fetch(
      editing ? `/api/admin/display/layouts/${draft.id}` : "/api/admin/display/layouts",
      {
        method: editing ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }
    );

    const body = (await response.json().catch(() => null)) as
      | {
          layout?: { id: string; key: string; name: string };
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
      `Layout "${body?.layout?.name ?? draft.name}" saved.` +
        (body?.warnings && body.warnings.length > 0
          ? " Some CSS was flagged — see the notices below."
          : "")
    );
    // A create now has an id; keep editing it so a follow-up save is a PUT.
    if (!editing && body?.layout) {
      setDraft((current) => ({ ...current, id: body.layout!.id }));
    }
    await refresh();
  }

  // --- Area-row mutation helpers -----------------------------------------
  function updateArea(index: number, patch: Partial<AreaDraft>) {
    setDraft((current) => ({
      ...current,
      areas: current.areas.map((area, i) =>
        i === index ? { ...area, ...patch } : area
      ),
    }));
  }

  function updateChild(
    areaIndex: number,
    childIndex: number,
    patch: Partial<ChildDraft>
  ) {
    setDraft((current) => ({
      ...current,
      areas: current.areas.map((area, i) =>
        i === areaIndex
          ? {
              ...area,
              children: area.children.map((child, ci) =>
                ci === childIndex ? { ...child, ...patch } : child
              ),
            }
          : area
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
    the empty wrapper an edit-capable admin gets costs no layout (the page
    padding stays on the outer element so the banner is inset like the rest).
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view the lobby display layouts but cannot change
      them. Lodge edit access is required to author, edit, or delete a
      layout.
    </AdminViewOnlySectionBanner>
  );

  return (
    <div className="p-6">
      {viewOnlyBanner}
      <div className="space-y-6">
      <div>
        <BackLink {...adminLink("display")} />
        <h1 className="mt-2 text-2xl font-bold">Display Layouts — Advanced mode</h1>
        <p className="text-muted-foreground">
          This is the <strong>Advanced mode</strong> hand-editor. Most boards are
          easier to build in the{" "}
          {/*
            A plain <a>, not next/link, on purpose (#2246): the builder's Live
            preview depends on the route-scoped `frame-src 'self'` relaxation in
            `src/lib/csp.ts`, and a document's CSP is fixed at parse time from
            its response headers. An App Router <Link> is a SOFT navigation — no
            new document — so the builder would inherit THIS page's stricter
            policy and its preview would show "Content blocked". A hard load
            fetches the builder's own headers. Accessibility is unchanged: this
            is still a real link.
          */}
          <a className="underline" href={adminHref("display-builder")}>
            visual builder
          </a>
          , which writes the layout and template for you; drop to Advanced mode
          for full control over the HTML body, CSS, and areas.
        </p>
        <p className="text-muted-foreground mt-1">
          {/* The shared definition (#2247) — same words as the hub card, the
              Reference page and the operator guide — then ONLY what is specific
              to this page. The two sentences that used to follow restated the
              definition in different words, which is the drift the shared
              constant exists to prevent. */}
          {DISPLAY_TERM_LAYOUT.oneLiner} Here that means an HTML body with{" "}
          <code className="bg-muted rounded px-1">{"{{area:key}}"}</code>{" "}
          placeholders, a default CSS block, and the named areas each Template
          will fill.
        </p>
        <p className="text-muted-foreground mt-1 text-sm">
          Layouts are previewed through a Template: build a Template on this
          layout, then use its <strong>Preview</strong> on the Templates page
          (which renders it in a sandboxed frame against a chosen lodge).
        </p>
      </div>

      {message && <p className="text-sm font-medium">{message}</p>}

      <Card>
        <CardHeader>
          <CardTitle>Layouts</CardTitle>
        </CardHeader>
        <CardContent>
          {loading && <p className="text-muted-foreground text-sm">Loading…</p>}
          {!loading && layouts.length === 0 && (
            <p className="text-muted-foreground text-sm">
              No layouts yet. Author one below.
            </p>
          )}
          <div className="space-y-3">
            {layouts.map((item) => (
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
                  {item.description && (
                    <p className="text-muted-foreground text-sm">
                      {item.description}
                    </p>
                  )}
                  <p className="text-muted-foreground text-xs">
                    {item.templateCount === 0
                      ? "No templates use this layout"
                      : item.templateCount === 1
                        ? "1 template uses this layout"
                        : `${item.templateCount} templates use this layout`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" onClick={() => void editLayout(item.id)}>
                    Edit
                  </Button>
                  <ViewOnlyActionButton
                    canEdit={canEdit}
                    describeReason={false}
                    variant="destructive"
                    onClick={() => void deleteLayout(item)}
                  >
                    Delete
                  </ViewOnlyActionButton>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4">
            <Button variant="outline" onClick={startNew}>
              New layout
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            {draft.id ? `Edit layout — ${draft.name || draft.key}` : "New layout"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {editingBuiltIn && (
            <div
              role="note"
              className="space-y-2 rounded-md border border-warning-7/50 bg-warning-3 p-3 text-sm text-warning-11"
            >
              <p className="font-medium">This is a built-in layout.</p>
              <p>
                In-place edits to a built-in are{" "}
                <strong>overwritten</strong> the next time the database is
                seeded, or when{" "}
                <strong>Restore built-in boards</strong> is pressed on the
                Templates page. To keep your changes, duplicate this layout and
                customise the copy instead.
              </p>
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={false}
                variant="outline"
                className="h-9"
                onClick={duplicateLayout}
              >
                Duplicate to customise
              </ViewOnlyActionButton>
            </div>
          )}
          <div className="flex flex-wrap gap-4">
            <div className="space-y-1">
              <Label htmlFor="layout-key">Key</Label>
              <Input
                id="layout-key"
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
                  ? "Locked — the key is fixed once templates and seeds reference it."
                  : "Lower-case slug, for example everyday-board. Fixed after creation."}
              </FieldHint>
            </div>
            <div className="min-w-64 flex-1 space-y-1">
              <Label htmlFor="layout-name">Name</Label>
              <Input
                id="layout-name"
                value={draft.name}
                disabled={!canEdit}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, name: event.target.value }))
                }
                {...nameHint.fieldProps}
              />
              <FieldHint {...nameHint.hintProps}>
                Example: Everyday board
              </FieldHint>
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="layout-description">Description</Label>
            <Input
              id="layout-description"
              placeholder="What this layout is for"
              value={draft.description}
              disabled={!canEdit}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  description: event.target.value,
                }))
              }
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="layout-body">Body HTML</Label>
            <textarea
              id="layout-body"
              className={`${textareaClass} min-h-40`}
              spellCheck={false}
              disabled={!canEdit}
              value={draft.bodyHtml}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  bodyHtml: event.target.value,
                }))
              }
              {...bodyHint.fieldProps}
            />
            <FieldHint {...bodyHint.hintProps}>
              Structural HTML with{" "}
              <code className="bg-muted rounded px-1">{"{{area:key}}"}</code>{" "}
              placeholders — one per area below. This is the layout skeleton, so
              it is a plain editor, not the page-content rich editor. Example:
              {/* The example is multi-line, so it keeps its line breaks —
                  `whitespace-pre-wrap` on a span rather than a <pre>, which
                  cannot legally nest inside the hint's <p>. */}
              <span className="mt-1 block whitespace-pre-wrap font-mono">
                {'<main class="board">\n  {{area:arrivals}}\n  {{area:notice}}\n</main>'}
              </span>
            </FieldHint>
          </div>

          <div className="space-y-1">
            <Label htmlFor="layout-css">Default CSS</Label>
            <textarea
              id="layout-css"
              className={`${textareaClass} min-h-32`}
              spellCheck={false}
              disabled={!canEdit}
              value={draft.defaultCss}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  defaultCss: event.target.value,
                }))
              }
              {...cssHint.fieldProps}
            />
            <FieldHint {...cssHint.hintProps}>
              Example:{" "}
              <code className="bg-muted rounded px-1">
                {".board { color: var(--display-ink); }"}
              </code>
              . Theme tokens you can reach for:{" "}
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

          <div className="space-y-3">
            <Label>Areas</Label>
            {draft.areas.map((area, index) => (
              <div
                key={index}
                className="space-y-3 rounded-md border p-3"
              >
                <div className="flex flex-wrap items-end gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs" htmlFor={`area-key-${index}`}>
                      Area key
                    </Label>
                    <Input
                      id={`area-key-${index}`}
                      className="w-44 font-mono"
                      value={area.key}
                      disabled={!canEdit}
                      onChange={(event) =>
                        updateArea(index, { key: event.target.value })
                      }
                      aria-describedby={describedByFieldHint(
                        areaKeyHintId(index),
                      )}
                    />
                    <FieldHint id={areaKeyHintId(index)}>
                      Example: arrivals
                    </FieldHint>
                  </div>
                  <div className="min-w-48 flex-1 space-y-1">
                    <Label
                      className="text-xs"
                      htmlFor={`area-description-${index}`}
                    >
                      Description
                    </Label>
                    <Input
                      id={`area-description-${index}`}
                      value={area.description}
                      disabled={!canEdit}
                      onChange={(event) =>
                        updateArea(index, { description: event.target.value })
                      }
                      aria-describedby={describedByFieldHint(
                        areaDescriptionHintId(index),
                      )}
                    />
                    <FieldHint id={areaDescriptionHintId(index)}>
                      Example: Today&apos;s arrivals board
                    </FieldHint>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs" htmlFor={`area-kind-${index}`}>
                      Kind
                    </Label>
                    <select
                      id={`area-kind-${index}`}
                      className={selectClass}
                      value={area.kind}
                      disabled={!canEdit}
                      onChange={(event) =>
                        updateArea(index, { kind: event.target.value as AreaKind })
                      }
                    >
                      <option value="static">Static (always shown)</option>
                      <option value="conditional">Conditional</option>
                      <option value="rotator">Rotator</option>
                    </select>
                  </div>
                  <Button
                    variant="outline"
                    disabled={!canEdit}
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        areas: current.areas.filter((_, i) => i !== index),
                      }))
                    }
                  >
                    Remove area
                  </Button>
                </div>

                {area.kind === "conditional" && (
                  <div className="space-y-1">
                    <Label className="text-xs" htmlFor={`area-condition-${index}`}>
                      Condition
                    </Label>
                    <select
                      id={`area-condition-${index}`}
                      className={selectClass}
                      value={area.condition}
                      disabled={!canEdit}
                      onChange={(event) =>
                        updateArea(index, { condition: event.target.value })
                      }
                    >
                      <option value="">— select a condition —</option>
                      {conditions.map((condition) => (
                        <option
                          key={condition.name}
                          value={condition.name}
                          title={condition.description}
                        >
                          {condition.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {area.kind === "rotator" && (
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <Label className="text-xs" htmlFor={`area-rotate-${index}`}>
                        Seconds per child (3–300; blank uses the default)
                      </Label>
                      <Input
                        id={`area-rotate-${index}`}
                        className="w-32"
                        inputMode="numeric"
                        /* #2264 — the bare "12" is deleted rather than
                           relocated: the Label above already states the 3–300
                           range and the blank-means-default rule, so a hint
                           would only repeat it. */
                        value={area.rotateSeconds}
                        disabled={!canEdit}
                        onChange={(event) =>
                          updateArea(index, { rotateSeconds: event.target.value })
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs">Rotating child slots</Label>
                      {area.children.map((child, childIndex) => (
                        <div
                          key={childIndex}
                          className="flex flex-wrap items-end gap-2"
                        >
                          <Input
                            className="w-40 font-mono"
                            placeholder="child-key"
                            value={child.key}
                            disabled={!canEdit}
                            onChange={(event) =>
                              updateChild(index, childIndex, {
                                key: event.target.value,
                              })
                            }
                          />
                          <Input
                            className="min-w-40 flex-1"
                            placeholder="Description"
                            value={child.description}
                            disabled={!canEdit}
                            onChange={(event) =>
                              updateChild(index, childIndex, {
                                description: event.target.value,
                              })
                            }
                          />
                          <select
                            className={selectClass}
                            value={child.condition}
                            title="Optional rotation condition"
                            disabled={!canEdit}
                            onChange={(event) =>
                              updateChild(index, childIndex, {
                                condition: event.target.value,
                              })
                            }
                          >
                            <option value="">No condition (always)</option>
                            {conditions.map((condition) => (
                              <option
                                key={condition.name}
                                value={condition.name}
                                title={condition.description}
                              >
                                {condition.name}
                              </option>
                            ))}
                          </select>
                          <Button
                            variant="outline"
                            onClick={() =>
                              updateArea(index, {
                                children: area.children.filter(
                                  (_, ci) => ci !== childIndex
                                ),
                              })
                            }
                            disabled={area.children.length <= 1 || !canEdit}
                          >
                            Remove
                          </Button>
                        </div>
                      ))}
                      <Button
                        variant="outline"
                        disabled={!canEdit}
                        onClick={() =>
                          updateArea(index, {
                            children: [
                              ...area.children,
                              { key: "", description: "", condition: "" },
                            ],
                          })
                        }
                      >
                        Add child slot
                      </Button>
                    </div>
                  </div>
                )}

                {area.kind !== "rotator" && (
                  <div className="space-y-1">
                    <Label className="text-xs" htmlFor={`area-default-${index}`}>
                      Default content (optional)
                    </Label>
                    <textarea
                      id={`area-default-${index}`}
                      className={`${textareaClass} min-h-20`}
                      spellCheck={false}
                      disabled={!canEdit}
                      value={area.defaultContentHtml}
                      onChange={(event) =>
                        updateArea(index, {
                          defaultContentHtml: event.target.value,
                        })
                      }
                      aria-describedby={describedByFieldHint(
                        areaDefaultHintId(index),
                      )}
                    />
                    <FieldHint id={areaDefaultHintId(index)}>
                      Fallback shown when a Template leaves this slot empty. HTML,
                      or a single{" "}
                      <code className="bg-muted rounded px-1">
                        {"{{module:name}}"}
                      </code>{" "}
                      embed — for example{" "}
                      <code className="bg-muted rounded px-1">
                        {"<p>Welcome</p>"}
                      </code>{" "}
                      or{" "}
                      <code className="bg-muted rounded px-1">
                        {"{{module:notice}}"}
                      </code>
                      .
                    </FieldHint>
                  </div>
                )}
              </div>
            ))}
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              variant="outline"
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  areas: [...current.areas, emptyArea()],
                }))
              }
            >
              Add area
            </ViewOnlyActionButton>
          </div>

          {errors.length > 0 && (
            <div className="border-destructive/40 bg-destructive/10 text-destructive space-y-1 rounded-md border p-3 text-sm">
              <p className="font-medium">This layout can&apos;t be saved yet:</p>
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
              disabled={saving || !draft.name}
            >
              {draft.id ? "Save changes" : "Create layout"}
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
