"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldHint, useFieldHint } from "@/components/ui/field-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  DISPLAY_TOKEN_POPOVER_ATTR,
  DisplayTokenTextarea,
  useDisplayLodgeConfig,
  type DisplayConfigSource,
} from "@/components/admin/display-token-textarea";
import { listDisplayConditions } from "@/lib/lodge-display/conditions";
import { listPaletteDisplayModules } from "@/lib/lodge-display/module-registry";
import {
  builderLayout,
  builderSlotContent,
  BUILDER_SKELETONS,
  BUILDER_KEY_MAX_LENGTH,
  isValidBuilderKey,
  slugifyKey,
  type BuilderContent,
  type BuilderModel,
  type BuilderSkeleton,
  type BuilderZone,
} from "@/lib/lodge-display/builder-model";
import type { DisplayModuleName } from "@/lib/lodge-display/template-registry";
import {
  addChild,
  addZone,
  canAddZone,
  changeSkeleton,
  coerceOptionValue,
  moveChild,
  moveZone,
  removeChild,
  removeZone,
  setChildCondition,
  setChildContent,
  setChildDescription,
  setChildModule,
  setChildOption,
  setZoneCondition,
  setZoneContent,
  setZoneDescription,
  setZoneKind,
  setZoneModule,
  setZoneOption,
  setZoneRotateSeconds,
} from "./builder-state";

// Guided zone builder client (ADR-004 §1/§8). Composes a Layout+Template pair by
// picking a skeleton and dropping modules into zones — no HTML by hand. DnD is
// an ENHANCEMENT over a fully keyboard/pointer-free fallback: every placement and
// reorder is also available via a menu / arrow buttons, and @dnd-kit runs with a
// KeyboardSensor + live-region announcements so the drag itself is operable from
// the keyboard. The builder only ever emits shapes the save contract accepts.

/** #2264 — the board-key ALERT's id, so `useFieldHint` can list it ahead of the
 *  hint. Only one builder is mounted at a time, so a fixed id cannot collide. */
const BUILDER_KEY_ERROR_ID = "builder-key-error";

const SKELETON_LABELS: Record<BuilderSkeleton, string> = {
  columns: "Columns (side by side)",
  rows: "Rows (stacked)",
  "side-rail": "Main + side rail",
};

interface ValidationIssue {
  path: string;
  message: string;
}

// The save routes reject a malformed request body (chiefly an invalid key slug)
// with a bare `{ error: "Invalid request" }`. Client-side validation blocks that
// before Save, but if it ever reaches the server this maps the opaque string to a
// message pointing at the field, so the author never sees bare "Invalid request"
// (§U2/U3). Any other server error is passed through unchanged.
function friendlySaveError(raw: string | undefined | null): string | null {
  if (raw === "Invalid request") {
    return "Check the board key — use lower-case letters, numbers and hyphens only (e.g. foyer-board).";
  }
  return raw ?? null;
}

type PaletteItem =
  | { kind: "module"; module: DisplayModuleName; label: string; description: string }
  | { kind: "html"; label: string; description: string };

interface DisplayBuilderProps {
  /** Editing an existing pair → the ids to PUT; null on both → a fresh create. */
  layoutId: string | null;
  templateId: string | null;
  initialModel: BuilderModel;
  initialKey: string;
  initialName: string;
  initialFooterHtml: string;
  initialCssOverrides: string;
  /** Built-in pair → Save is disabled in favour of duplicate-to-customise. */
  isBuiltIn: boolean;
  canEdit: boolean | undefined;
  lodges: { id: string; name: string }[];
  onDuplicate: () => void;
  defaultCssCustomised?: boolean;
}

export default function DisplayBuilder(props: DisplayBuilderProps) {
  const [model, setModel] = useState<BuilderModel>(props.initialModel);
  const [key, setKey] = useState(props.initialKey);
  // The key auto-derives from the name until the author edits it by hand. An
  // initial key (editing an existing pair, or a duplicated board) counts as
  // already-set so a name edit never silently clobbers it (§U2/U3).
  const [keyTouched, setKeyTouched] = useState(props.initialKey !== "");
  const [name, setName] = useState(props.initialName);
  const [footerHtml, setFooterHtml] = useState(props.initialFooterHtml);
  const [cssOverrides, setCssOverrides] = useState(props.initialCssOverrides);
  const [openZone, setOpenZone] = useState<number | null>(null);
  const [activePalette, setActivePalette] = useState<PaletteItem | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<ValidationIssue[]>([]);
  const [warnings, setWarnings] = useState<ValidationIssue[]>([]);
  const [saving, setSaving] = useState(false);

  const [previewLodgeId, setPreviewLodgeId] = useState(props.lodges[0]?.id ?? "");
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  // The preview lodge's live {{config:…}} keys for the token assistant (#2248,
  // decision 2: the picker follows the existing preview-lodge selector).
  const previewLodgeConfig = useDisplayLodgeConfig(previewLodgeId);

  const canEdit = props.canEdit && !props.isBuiltIn;

  // The key is authored only on create (an existing pair locks it — bindings key
  // off it). `keyValid` gates Save so an invalid slug is caught inline rather than
  // bouncing off the server as a bare "Invalid request" (§U2/U3).
  const creating = props.layoutId === null;
  const keyValid = isValidBuilderKey(key.trim());
  // #2264 — examples move out of the placeholders and under the fields.
  // The key field already had a hand-rolled describedby pair, so it is
  // converted rather than duplicated; its inline "use lower-case letters…"
  // ALERT is now named and listed FIRST, so a screen reader hears what is wrong
  // before it hears the example.
  const keyInvalid = creating && key.trim() !== "" && !keyValid;
  const nameHint = useFieldHint();
  const keyHint = useFieldHint(keyInvalid ? BUILDER_KEY_ERROR_ID : undefined);
  const footerHint = useFieldHint();
  const cssHint = useFieldHint();

  // Keyboard reorder focus (§U4): zone keys are positional (re-derived on every
  // reorder), so after a move React reuses the DOM node at each index and the
  // focused button would end up on the WRONG logical zone. We refocus the move
  // control at the moved zone's NEW index so focus follows the item, not the slot.
  const moveRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());
  const [pendingMoveFocus, setPendingMoveFocus] = useState<string | null>(null);
  useEffect(() => {
    if (pendingMoveFocus === null) return;
    moveRefs.current.get(pendingMoveFocus)?.focus();
    setPendingMoveFocus(null);
  }, [model, pendingMoveFocus]);

  const modules = useMemo(() => listPaletteDisplayModules(), []);
  const conditions = useMemo(() => listDisplayConditions(), []);
  const palette = useMemo<PaletteItem[]>(
    () => [
      ...modules.map(
        (m): PaletteItem => ({
          kind: "module",
          module: m.name,
          label: m.label,
          description: m.description,
        })
      ),
      {
        kind: "html",
        label: "HTML content block",
        description: "Free HTML with {{config:…}} / {{lodge-name}} tokens.",
      },
    ],
    [modules]
  );

  // Ref back to the zone trigger so focus returns there when the drawer closes
  // (radix Sheet restores focus to its trigger automatically; this covers the
  // menu-driven open path too).
  const zoneRefs = useRef<Map<number, HTMLButtonElement | null>>(new Map());

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor)
  );

  const applyPaletteToZone = useCallback(
    (item: PaletteItem, zoneIndex: number) => {
      const zone = model.zones[zoneIndex];
      if (!zone || zone.kind === "rotator") {
        // A rotator holds child slots — it is not filled directly. Open its drawer
        // and say so, rather than implying the module was placed (§U6).
        setOpenZone(zoneIndex);
        if (zone) {
          setMessage(
            `${zone.key} rotates between slots — add ${item.label} as a slot in its settings.`
          );
        }
        return;
      }
      setModel((current) =>
        item.kind === "module"
          ? setZoneModule(current, zoneIndex, item.module)
          : setZoneContent(current, zoneIndex, { type: "html", html: "" })
      );
      setMessage(
        item.kind === "module"
          ? `Added ${item.label} to ${zone.key}.`
          : `Added an HTML block to ${zone.key}. Open its settings to write the HTML.`
      );
    },
    [model.zones]
  );

  function onDragStart(event: DragStartEvent) {
    const data = event.active.data.current as { item?: PaletteItem } | undefined;
    if (data?.item) setActivePalette(data.item);
  }

  function onDragEnd(event: DragEndEvent) {
    setActivePalette(null);
    const { active, over } = event;
    if (!over) return;
    const item = (active.data.current as { item?: PaletteItem } | undefined)?.item;
    const overData = over.data.current as { zoneIndex?: number } | undefined;
    if (item && typeof overData?.zoneIndex === "number") {
      applyPaletteToZone(item, overData.zoneIndex);
    }
  }

  const announcements: Announcements = {
    onDragStart({ active }) {
      const item = (active.data.current as { item?: PaletteItem } | undefined)?.item;
      return item ? `Picked up ${item.label}. Use arrow keys to move it over a zone, then space to drop.` : undefined;
    },
    onDragOver({ over }) {
      const zoneIndex = (over?.data.current as { zoneIndex?: number } | undefined)?.zoneIndex;
      return typeof zoneIndex === "number"
        ? `Over zone ${model.zones[zoneIndex]?.key ?? zoneIndex + 1}.`
        : "No zone.";
    },
    onDragEnd({ over }) {
      const zoneIndex = (over?.data.current as { zoneIndex?: number } | undefined)?.zoneIndex;
      if (typeof zoneIndex !== "number") return "Cancelled.";
      const zone = model.zones[zoneIndex];
      const label = zone?.key ?? zoneIndex + 1;
      // A rotator is not filled directly — the drop opens its slot settings, so the
      // announcement must say that, not "Dropped into zone …" (§U6).
      return zone?.kind === "rotator"
        ? `Opened slot settings for rotator zone ${label} — add it as a slot there.`
        : `Dropped into zone ${label}.`;
    },
    onDragCancel() {
      return "Placement cancelled.";
    },
  };

  async function save() {
    if (!canEdit) return;
    setSaving(true);
    setErrors([]);
    setWarnings([]);
    setMessage(null);
    const layout = builderLayout(model);
    const slotContent = builderSlotContent(model);
    const slug = key.trim();
    const title = name.trim();
    try {
      // 1) Layout (create or update). The Template binds to its id.
      const layoutBody = {
        key: slug,
        name: title,
        description: null,
        bodyHtml: layout.bodyHtml,
        defaultCss: layout.defaultCss,
        areas: layout.areas,
      };
      const layoutRes = await fetch(
        props.layoutId
          ? `/api/admin/display/layouts/${props.layoutId}`
          : "/api/admin/display/layouts",
        {
          method: props.layoutId ? "PUT" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(layoutBody),
        }
      );
      const layoutJson = (await layoutRes.json().catch(() => null)) as
        | { layout?: { id: string }; errors?: ValidationIssue[]; warnings?: ValidationIssue[]; error?: string }
        | null;
      if (!layoutRes.ok) {
        setErrors(layoutJson?.errors ?? []);
        setWarnings(layoutJson?.warnings ?? []);
        setMessage(friendlySaveError(layoutJson?.error) ?? (layoutJson?.errors ? null : "Could not save the layout."));
        setSaving(false);
        return;
      }
      const savedLayoutId = layoutJson?.layout?.id ?? props.layoutId;
      if (!savedLayoutId) {
        setMessage("Layout saved but no id returned.");
        setSaving(false);
        return;
      }

      // 2) Template (create or update), bound to the layout.
      const templateBody = {
        key: slug,
        name: title,
        layoutId: savedLayoutId,
        slotContent,
        cssOverrides,
        footerHtml,
      };
      const templateRes = await fetch(
        props.templateId
          ? `/api/admin/display/templates/${props.templateId}`
          : "/api/admin/display/templates",
        {
          method: props.templateId ? "PUT" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(templateBody),
        }
      );
      const templateJson = (await templateRes.json().catch(() => null)) as
        | { template?: { id: string }; errors?: ValidationIssue[]; warnings?: ValidationIssue[]; error?: string }
        | null;
      if (!templateRes.ok) {
        setErrors(templateJson?.errors ?? []);
        setWarnings((prev) => [...(layoutJson?.warnings ?? []), ...(templateJson?.warnings ?? []), ...prev]);
        setMessage(friendlySaveError(templateJson?.error) ?? (templateJson?.errors ? null : "Could not save the template."));
        setSaving(false);
        return;
      }
      setWarnings([...(layoutJson?.warnings ?? []), ...(templateJson?.warnings ?? [])]);
      setMessage(`Saved "${title}". It is ready to bind on the Devices page.`);
    } catch {
      setMessage("Save failed — network error.");
    }
    setSaving(false);
  }

  async function startPreview() {
    if (!previewLodgeId) {
      setMessage("An explicit active lodge is required before previewing.");
      return;
    }
    setPreviewing(true);
    setErrors([]);
    setPreviewSrc(null);
    const layout = builderLayout(model);
    const slotContent = builderSlotContent(model);
    try {
      const res = await fetch("/api/admin/display/preview-grant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          previewLodge: previewLodgeId,
          draft: {
            bodyHtml: layout.bodyHtml,
            defaultCss: layout.defaultCss,
            areas: layout.areas,
            slotContent,
            cssOverrides,
            footerHtml,
          },
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | { token?: string; errors?: ValidationIssue[]; warnings?: ValidationIssue[]; error?: string }
        | null;
      if (!res.ok || !body?.token) {
        // A broken draft comes back as structured errors (preview IS the save
        // gate) — surface them exactly like a save failure, no frame is opened.
        setErrors(body?.errors ?? []);
        setWarnings(body?.warnings ?? []);
        setMessage(body?.errors ? "Fix these before previewing:" : body?.error ?? "Could not start the preview.");
        setPreviewing(false);
        return;
      }
      setWarnings(body.warnings ?? []);
      setPreviewSrc(`/display?previewGrant=${encodeURIComponent(body.token)}`);
    } catch {
      setMessage("Could not start the preview.");
    }
    setPreviewing(false);
  }

  return (
    <DndContext
      sensors={sensors}
      accessibility={{ announcements }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActivePalette(null)}
    >
      <div className="space-y-6">
        {props.isBuiltIn && (
          <div
            role="note"
            className="space-y-2 rounded-md border border-warning-7/50 bg-warning-3 p-3 text-sm text-warning-11"
          >
            <p className="font-medium">This is a built-in design.</p>
            <p>
              Built-ins are refreshed from code on every upgrade, so the builder
              can&apos;t save over one. Duplicate it to customise a copy.
            </p>
            <Button variant="outline" className="h-9" onClick={props.onDuplicate}>
              Duplicate to customise
            </Button>
          </div>
        )}
        {props.defaultCssCustomised && (
          <div
            role="note"
            className="rounded-md border border-warning-7/50 bg-warning-3 p-3 text-sm text-warning-11"
          >
            The layout&apos;s default CSS was customised in Advanced mode. The
            builder owns the skeleton CSS, so saving here resets it — put custom
            styling in the CSS overrides field instead.
          </div>
        )}

        <div className="flex flex-wrap gap-4">
          <div className="min-w-64 flex-1 space-y-1">
            <Label htmlFor="builder-name">Name</Label>
            <Input
              id="builder-name"
              {...nameHint.fieldProps}
              value={name}
              disabled={!canEdit}
              onChange={(e) => {
                const next = e.target.value;
                setName(next);
                // Auto-fill the slug from the name while creating and the author
                // has not hand-edited the key (§U2/U3).
                if (creating && !keyTouched) setKey(slugifyKey(next));
              }}
            />
            <FieldHint {...nameHint.hintProps}>Example: Foyer board</FieldHint>
          </div>
          <div className="space-y-1">
            <Label htmlFor="builder-key">Board key (slug)</Label>
            <Input
              id="builder-key"
              className="w-56 font-mono"
              value={key}
              disabled={!creating || !canEdit}
              aria-invalid={keyInvalid}
              {...keyHint.fieldProps}
              onChange={(e) => {
                setKeyTouched(true);
                setKey(e.target.value);
              }}
            />
            <FieldHint {...keyHint.hintProps}>
              {creating
                ? `Auto-filled from the name — for example foyer-board. Lower-case letters, numbers and hyphens only, up to ${BUILDER_KEY_MAX_LENGTH} characters; fixed after creation.`
                : "Locked after creation."}
            </FieldHint>
            {keyInvalid && (
              <p
                id={BUILDER_KEY_ERROR_ID}
                className="text-destructive text-xs"
                role="alert"
              >
                Use lower-case letters, numbers and hyphens only, up to{" "}
                {BUILDER_KEY_MAX_LENGTH} characters (e.g. foyer-board).
              </p>
            )}
          </div>
        </div>

        <div className="space-y-1">
          <Label htmlFor="builder-skeleton">Layout shape</Label>
          <select
            id="builder-skeleton"
            className="border-input bg-background h-9 rounded-md border px-3 text-sm"
            value={model.skeleton}
            disabled={!canEdit}
            onChange={(e) =>
              setModel((c) => changeSkeleton(c, e.target.value as BuilderSkeleton))
            }
          >
            {BUILDER_SKELETONS.map((s) => (
              <option key={s} value={s}>
                {SKELETON_LABELS[s]}
              </option>
            ))}
          </select>
        </div>

        {message && <p className="text-sm font-medium" role="status">{message}</p>}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
          {/* Canvas */}
          <Card>
            <CardHeader>
              <CardTitle>Canvas — board body (16:9 screen minus header/footer)</CardTitle>
            </CardHeader>
            <CardContent>
              <div
                className="aspect-video w-full rounded-md border bg-muted p-3"
                data-testid="builder-canvas"
              >
                <ZoneGrid
                  model={model}
                  canEdit={canEdit}
                  onOpen={(i) => setOpenZone(i)}
                  onRemove={(i) => setModel((c) => removeZone(c, i))}
                  onMove={(from, to) => {
                    setModel((c) => moveZone(c, from, to));
                    // Focus follows the moved zone to its new position (§U4). Mirror
                    // moveZone's clamping so we target the control that actually moved.
                    const lower = model.skeleton === "side-rail" ? 1 : 0;
                    const dest = Math.max(lower, Math.min(model.zones.length - 1, to));
                    if (dest !== from) {
                      setPendingMoveFocus(`${dest}-${to > from ? "down" : "up"}`);
                    }
                  }}
                  onAddModule={(i, module) => setModel((c) => setZoneModule(c, i, module))}
                  onAddHtml={(i) => setModel((c) => setZoneContent(c, i, { type: "html", html: "" }))}
                  modules={modules}
                  zoneRefs={zoneRefs}
                  moveRefs={moveRefs}
                />
              </div>
              {canEdit && canAddZone(model) && (
                <Button
                  variant="outline"
                  className="mt-3"
                  onClick={() => setModel((c) => addZone(c))}
                >
                  Add zone
                </Button>
              )}
            </CardContent>
          </Card>

          {/* Palette */}
          <Card>
            <CardHeader>
              <CardTitle>Modules</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-muted-foreground text-xs">
                Drag a module onto a zone, or use a zone&apos;s <strong>Add</strong>{" "}
                menu. Everything here is keyboard-operable.
              </p>
              {palette.map((item) => (
                <PaletteChip key={item.kind === "module" ? item.module : "html"} item={item} disabled={!canEdit} />
              ))}
            </CardContent>
          </Card>
        </div>

        {/* Footer + overrides (Template side, advanced-lite). Both carry the
            token assistant (#2248) on their label rows. */}
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1">
            <DisplayTokenTextarea
              id="builder-footer"
              label="Footer HTML (optional)"
              mode="html"
              value={footerHtml}
              onValueChange={setFooterHtml}
              disabled={!canEdit}
              /* #2264 — the textarea lives inside the shared token component,
                 so the hint wiring threads through its `describedBy` prop
                 rather than being spread onto the control directly. */
              describedBy={footerHint.fieldProps["aria-describedby"]}
              textareaClassName="min-h-20"
              configSource={previewLodgeConfig}
            />
            <FieldHint {...footerHint.hintProps}>
              Example:{" "}
              <code className="bg-muted rounded px-1">
                {"Wi-Fi: {{config:wifi-code}} · {{lodge-name}}"}
              </code>
            </FieldHint>
          </div>
          <div className="space-y-1">
            <DisplayTokenTextarea
              id="builder-css"
              label="CSS overrides (optional)"
              mode="css"
              value={cssOverrides}
              onValueChange={setCssOverrides}
              disabled={!canEdit}
              describedBy={cssHint.fieldProps["aria-describedby"]}
              textareaClassName="min-h-20"
            />
            <FieldHint {...cssHint.hintProps}>
              Example:{" "}
              <code className="bg-muted rounded px-1">
                {".dlb-zone { gap: 2vmin; }"}
              </code>
            </FieldHint>
          </div>
        </div>

        {errors.length > 0 && (
          <div className="border-destructive/40 bg-destructive/10 text-destructive space-y-1 rounded-md border p-3 text-sm">
            <p className="font-medium">This can&apos;t be saved yet:</p>
            <ul className="list-disc space-y-0.5 pl-5">
              {errors.map((issue, i) => (
                <li key={i}>
                  <code className="font-mono text-xs">{issue.path}</code> — {issue.message}
                </li>
              ))}
            </ul>
          </div>
        )}
        {warnings.length > 0 && (
          <div className="space-y-1 rounded-md border border-warning-7/50 bg-warning-3 p-3 text-sm text-warning-11">
            <p className="font-medium">Some CSS was neutralised on the way in:</p>
            <ul className="list-disc space-y-0.5 pl-5">
              {warnings.map((issue, i) => (
                <li key={i}>
                  <code className="font-mono text-xs">{issue.path}</code> — {issue.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Preview + Save */}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={() => void save()}
            disabled={!canEdit || saving || !name.trim() || !key.trim() || !keyValid}
          >
            {saving ? "Saving…" : props.templateId ? "Save changes" : "Create board"}
          </Button>
          {props.lodges.length > 1 && (
            <select
              className="border-input bg-background h-9 rounded-md border px-3 text-sm"
              aria-label="Preview lodge"
              title="Lodge to preview against — the Insert token picker lists this lodge's saved config keys"
              value={previewLodgeId}
              onChange={(e) => setPreviewLodgeId(e.target.value)}
            >
              {props.lodges.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          )}
          <Button
            variant="outline"
            onClick={() => void startPreview()}
            disabled={previewing || !previewLodgeId}
          >
            {previewing ? "Starting…" : "Live preview"}
          </Button>
        </div>

        {/* Tell the author what still blocks Save, consistent with the key
            validation messaging (§U8). */}
        {canEdit && !saving && (!name.trim() || !key.trim() || !keyValid) && (
          <p className="text-muted-foreground text-xs" role="status">
            {!name.trim()
              ? "Enter a name to save."
              : !key.trim()
                ? "Enter a board key to save."
                : `Fix the board key to save — lower-case letters, numbers and hyphens only, up to ${BUILDER_KEY_MAX_LENGTH} characters.`}
          </p>
        )}

        {previewSrc && (
          <div className="w-full overflow-hidden rounded-md border bg-black">
            {/* sandbox="allow-scripts" WITHOUT allow-same-origin → opaque origin,
                no cookies, no admin session in the frame (ADR-003 §5 / ADR-004 §7). */}
            <iframe
              title="Board preview"
              src={previewSrc}
              sandbox="allow-scripts"
              className="block h-[60vh] w-full border-0"
            />
          </div>
        )}
      </div>

      <DragOverlay>
        {activePalette ? (
          <div className="rounded-md border bg-background px-3 py-2 text-sm shadow-lg">
            {activePalette.label}
          </div>
        ) : null}
      </DragOverlay>

      {openZone !== null && model.zones[openZone] && (
        <ZoneDrawer
          zone={model.zones[openZone]}
          zoneIndex={openZone}
          canEdit={canEdit}
          conditions={conditions}
          modules={modules}
          configSource={previewLodgeConfig}
          onClose={() => setOpenZone(null)}
          setModel={setModel}
        />
      )}
    </DndContext>
  );
}

// ---------------------------------------------------------------------------
// Palette chip — draggable + keyboard-liftable
// ---------------------------------------------------------------------------

function PaletteChip({ item, disabled }: { item: PaletteItem; disabled: boolean }) {
  const id = item.kind === "module" ? `palette-${item.module}` : "palette-html";
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id,
    data: { item },
    disabled,
  });
  return (
    <button
      ref={setNodeRef}
      type="button"
      className={`w-full rounded-md border bg-background px-3 py-2 text-left text-sm ${
        isDragging ? "opacity-50" : ""
      } ${disabled ? "cursor-not-allowed opacity-60" : "cursor-grab hover:bg-muted"}`}
      title={item.description}
      {...attributes}
      {...listeners}
    >
      <span className="font-medium">{item.label}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Zone grid — the canvas; each zone is a droppable target with a fallback menu
// ---------------------------------------------------------------------------

interface ZoneGridProps {
  model: BuilderModel;
  canEdit: boolean | undefined;
  onOpen: (index: number) => void;
  onRemove: (index: number) => void;
  onMove: (from: number, to: number) => void;
  onAddModule: (index: number, module: DisplayModuleName) => void;
  onAddHtml: (index: number) => void;
  modules: ReturnType<typeof listPaletteDisplayModules>;
  zoneRefs: React.MutableRefObject<Map<number, HTMLButtonElement | null>>;
  /** Move-control refs keyed `${index}-up`/`${index}-down` so focus can follow a
   * reordered zone to its new position (§U4). */
  moveRefs: React.MutableRefObject<Map<string, HTMLButtonElement | null>>;
}

function ZoneGrid(props: ZoneGridProps) {
  const { model } = props;
  const gridStyle: React.CSSProperties =
    model.skeleton === "columns"
      ? { display: "grid", gridTemplateColumns: `repeat(${model.zones.length}, minmax(0,1fr))`, gap: "0.5rem", height: "100%" }
      : model.skeleton === "rows"
        ? { display: "grid", gridTemplateRows: `repeat(${model.zones.length}, minmax(0,1fr))`, gap: "0.5rem", height: "100%" }
        : { display: "grid", gridTemplateColumns: "1fr 14rem", gap: "0.5rem", height: "100%" };

  if (model.skeleton === "side-rail") {
    // The main cell is zone 0 by the side-rail skeleton's own rule; a model
    // with no zones at all has no main cell to draw, which is what the type
    // was pointing at and what the rail-only render now says (#2801).
    const [main, ...rail] = model.zones;
    return (
      <div style={gridStyle}>
        {main ? <ZoneCell {...props} zone={main} index={0} /> : null}
        <div className="flex flex-col gap-2">
          {rail.map((zone, i) => (
            <ZoneCell key={zone.key} {...props} zone={zone} index={i + 1} />
          ))}
        </div>
      </div>
    );
  }
  return (
    <div style={gridStyle}>
      {model.zones.map((zone, i) => (
        <ZoneCell key={zone.key} {...props} zone={zone} index={i} />
      ))}
    </div>
  );
}

function zoneSummary(zone: BuilderZone): string {
  if (zone.kind === "rotator") {
    const filled = zone.children.filter((c) => c.content.type !== "empty").length;
    return `Rotator · ${zone.children.length} slot${zone.children.length === 1 ? "" : "s"} (${filled} filled)`;
  }
  if (zone.content.type === "module") return `Module: ${zone.content.module}`;
  if (zone.content.type === "html") return "HTML block";
  return "Empty — drop a module or use Add";
}

function ZoneCell(
  props: ZoneGridProps & { zone: BuilderZone; index: number }
) {
  const { zone, index, canEdit, model } = props;
  const { setNodeRef, isOver } = useDroppable({
    id: `zone-${index}`,
    data: { zoneIndex: index },
    disabled: !canEdit,
  });
  const isRail = model.skeleton === "side-rail" && index >= 1;
  return (
    <div
      ref={setNodeRef}
      className={`flex min-h-16 flex-col justify-between rounded-md border-2 border-dashed p-2 text-xs ${
        isOver ? "border-primary bg-accent" : "border-muted-foreground/30 bg-background"
      }`}
      aria-label={`Zone ${zone.key}`}
    >
      <div>
        <p className="font-mono font-medium">{zone.key}</p>
        <p className="text-muted-foreground">{zoneSummary(zone)}</p>
        {zone.kind === "conditional" && zone.condition && (
          <p className="text-muted-foreground">when {zone.condition}</p>
        )}
      </div>
      {canEdit && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <Button
            ref={(el) => {
              props.zoneRefs.current.set(index, el);
            }}
            variant="outline"
            className="h-7 px-2 text-xs"
            onClick={() => props.onOpen(index)}
          >
            Settings
          </Button>
          {zone.kind !== "rotator" && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="h-7 px-2 text-xs">
                  Add
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="max-h-72 overflow-auto">
                <DropdownMenuLabel>Add module to {zone.key}</DropdownMenuLabel>
                {props.modules.map((m) => (
                  <DropdownMenuItem key={m.name} onSelect={() => props.onAddModule(index, m.name)}>
                    {m.label}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => props.onAddHtml(index)}>
                  HTML content block
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {(model.skeleton !== "side-rail" || isRail) && (
            <>
              <Button
                ref={(el) => {
                  props.moveRefs.current.set(`${index}-up`, el);
                }}
                variant="ghost"
                className="h-7 px-1.5 text-xs"
                aria-label={`Move ${zone.key} earlier`}
                onClick={() => props.onMove(index, index - 1)}
              >
                ↑
              </Button>
              <Button
                ref={(el) => {
                  props.moveRefs.current.set(`${index}-down`, el);
                }}
                variant="ghost"
                className="h-7 px-1.5 text-xs"
                aria-label={`Move ${zone.key} later`}
                onClick={() => props.onMove(index, index + 1)}
              >
                ↓
              </Button>
            </>
          )}
          {!(model.skeleton === "side-rail" && index === 0) && (
            <Button
              variant="ghost"
              className="text-destructive h-7 px-1.5 text-xs"
              aria-label={`Remove ${zone.key}`}
              onClick={() => props.onRemove(index)}
            >
              ✕
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Zone settings drawer (Sheet — radix traps + restores focus)
// ---------------------------------------------------------------------------

interface ZoneDrawerProps {
  zone: BuilderZone;
  zoneIndex: number;
  canEdit: boolean | undefined;
  conditions: ReturnType<typeof listDisplayConditions>;
  modules: ReturnType<typeof listPaletteDisplayModules>;
  /** Preview lodge config for the HTML block's token assistant (#2248). */
  configSource: DisplayConfigSource;
  onClose: () => void;
  setModel: React.Dispatch<React.SetStateAction<BuilderModel>>;
}

function ZoneDrawer(props: ZoneDrawerProps) {
  const { zone, zoneIndex, canEdit, conditions, modules, setModel } = props;
  const selectClass = "border-input bg-background h-9 w-full rounded-md border px-3 text-sm";
  return (
    <Sheet open onOpenChange={(open) => (!open ? props.onClose() : undefined)}>
      <SheetContent
        className="w-full overflow-y-auto sm:max-w-md"
        // Escape inside an OPEN token picker closes the picker only, never the
        // drawer — Radix's document-level capture listener would otherwise
        // dismiss the Sheet before the picker's own handler runs (#2248). The
        // marker sits on the assistant's root wrapper (trigger + popover) only
        // while the picker is open, so this also covers Escape pressed with
        // focus on the trigger button, and never blocks a normal drawer
        // dismiss when the picker is closed.
        onEscapeKeyDown={(event) => {
          const target = event.target as HTMLElement | null;
          if (target?.closest?.(`[${DISPLAY_TOKEN_POPOVER_ATTR}]`)) {
            event.preventDefault();
          }
        }}
      >
        <SheetHeader>
          <SheetTitle>Zone: {zone.key}</SheetTitle>
          <SheetDescription>Set what this zone shows and when.</SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4 pb-8">
          <div className="space-y-1">
            <Label htmlFor="zone-desc">Description</Label>
            <Input
              id="zone-desc"
              value={zone.description}
              disabled={!canEdit}
              onChange={(e) => setModel((c) => setZoneDescription(c, zoneIndex, e.target.value))}
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="zone-kind">Behaviour</Label>
            <select
              id="zone-kind"
              className={selectClass}
              value={zone.kind}
              disabled={!canEdit}
              onChange={(e) =>
                setModel((c) => setZoneKind(c, zoneIndex, e.target.value as BuilderZone["kind"]))
              }
            >
              <option value="static">Always shown</option>
              <option value="conditional">Shown only when…</option>
              <option value="rotator">Rotates between slots</option>
            </select>
          </div>

          {zone.kind === "conditional" && (
            <div className="space-y-1">
              <Label htmlFor="zone-cond">Condition</Label>
              <select
                id="zone-cond"
                className={selectClass}
                value={zone.condition}
                disabled={!canEdit}
                onChange={(e) => setModel((c) => setZoneCondition(c, zoneIndex, e.target.value))}
              >
                <option value="">— select a condition —</option>
                {conditions.map((c) => (
                  <option key={c.name} value={c.name} title={c.description}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {zone.kind === "rotator" ? (
            <RotatorEditor
              zone={zone}
              zoneIndex={zoneIndex}
              canEdit={canEdit}
              conditions={conditions}
              modules={modules}
              setModel={setModel}
            />
          ) : (
            <ContentEditor
              content={zone.content}
              canEdit={canEdit}
              modules={modules}
              configSource={props.configSource}
              onSetModule={(m) => setModel((c) => setZoneModule(c, zoneIndex, m))}
              onSetHtml={(html) => setModel((c) => setZoneContent(c, zoneIndex, { type: "html", html }))}
              onSetEmpty={() => setModel((c) => setZoneContent(c, zoneIndex, { type: "empty" }))}
              onSetOption={(k, v) => setModel((c) => setZoneOption(c, zoneIndex, k, v))}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function RotatorEditor(props: {
  zone: Extract<BuilderZone, { kind: "rotator" }>;
  zoneIndex: number;
  canEdit: boolean | undefined;
  conditions: ReturnType<typeof listDisplayConditions>;
  modules: ReturnType<typeof listPaletteDisplayModules>;
  setModel: React.Dispatch<React.SetStateAction<BuilderModel>>;
}) {
  const { zone, zoneIndex, canEdit, conditions, modules, setModel } = props;
  const selectClass = "border-input bg-background h-9 w-full rounded-md border px-3 text-sm";

  // Focus follows a reordered rotator slot to its new position (§U4). Children are
  // rendered by index, so without this the focused arrow would land on whichever
  // slot slid into the old position, not the one that moved.
  const childMoveRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());
  const [pendingChildFocus, setPendingChildFocus] = useState<string | null>(null);
  useEffect(() => {
    if (pendingChildFocus === null) return;
    childMoveRefs.current.get(pendingChildFocus)?.focus();
    setPendingChildFocus(null);
  }, [zone.children, pendingChildFocus]);
  const moveChildFocus = (from: number, to: number) => {
    setModel((c) => moveChild(c, zoneIndex, from, to));
    const dest = Math.max(0, Math.min(zone.children.length - 1, to));
    if (dest !== from) setPendingChildFocus(`${dest}-${to > from ? "down" : "up"}`);
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor="zone-rotate">Seconds per slot (3–300)</Label>
        <Input
          id="zone-rotate"
          type="number"
          min={3}
          max={300}
          value={zone.rotateSeconds}
          disabled={!canEdit}
          onChange={(e) =>
            setModel((c) =>
              setZoneRotateSeconds(c, zoneIndex, Math.max(3, Math.min(300, Number(e.target.value) || 8)))
            )
          }
        />
      </div>
      <Label>Rotating slots</Label>
      {zone.children.map((child, ci) => (
        <div key={ci} className="space-y-2 rounded-md border p-2">
          <div className="flex items-center justify-between">
            <p className="font-mono text-xs">{child.key}</p>
            <div className="flex gap-1">
              <Button ref={(el) => { childMoveRefs.current.set(`${ci}-up`, el); }} variant="ghost" className="h-7 px-1.5 text-xs" aria-label={`Move ${child.key} up`} disabled={!canEdit} onClick={() => moveChildFocus(ci, ci - 1)}>↑</Button>
              <Button ref={(el) => { childMoveRefs.current.set(`${ci}-down`, el); }} variant="ghost" className="h-7 px-1.5 text-xs" aria-label={`Move ${child.key} down`} disabled={!canEdit} onClick={() => moveChildFocus(ci, ci + 1)}>↓</Button>
              <Button variant="ghost" className="text-destructive h-7 px-1.5 text-xs" aria-label={`Remove ${child.key}`} disabled={!canEdit || zone.children.length <= 1} onClick={() => setModel((c) => removeChild(c, zoneIndex, ci))}>✕</Button>
            </div>
          </div>
          <select
            className={selectClass}
            aria-label="Slot module"
            value={child.content.type === "module" ? child.content.module : ""}
            disabled={!canEdit}
            onChange={(e) =>
              e.target.value
                ? setModel((c) => setChildModule(c, zoneIndex, ci, e.target.value as DisplayModuleName))
                : setModel((c) => setChildContent(c, zoneIndex, ci, { type: "empty" }))
            }
          >
            <option value="">— empty —</option>
            {modules.map((m) => (
              <option key={m.name} value={m.name}>{m.label}</option>
            ))}
          </select>
          <select
            className={selectClass}
            aria-label="Slot condition"
            value={child.condition ?? ""}
            disabled={!canEdit}
            onChange={(e) => setModel((c) => setChildCondition(c, zoneIndex, ci, e.target.value || null))}
          >
            <option value="">Always eligible</option>
            {conditions.map((c) => (
              <option key={c.name} value={c.name} title={c.description}>{c.name}</option>
            ))}
          </select>
          <Input
            aria-label="Slot description"
            placeholder="Description"
            value={child.description}
            disabled={!canEdit}
            onChange={(e) => setModel((c) => setChildDescription(c, zoneIndex, ci, e.target.value))}
          />
          {child.content.type === "module" && (
            <ModuleOptions
              moduleName={child.content.module}
              options={child.content.options}
              canEdit={canEdit}
              onSetOption={(k, v) => setModel((c) => setChildOption(c, zoneIndex, ci, k, v))}
            />
          )}
        </div>
      ))}
      <Button variant="outline" disabled={!canEdit} onClick={() => setModel((c) => addChild(c, zoneIndex))}>
        Add slot
      </Button>
    </div>
  );
}

function ContentEditor(props: {
  content: BuilderContent;
  canEdit: boolean | undefined;
  modules: ReturnType<typeof listPaletteDisplayModules>;
  /** Preview lodge config for the HTML block's token assistant (#2248). */
  configSource: DisplayConfigSource;
  onSetModule: (m: DisplayModuleName) => void;
  onSetHtml: (html: string) => void;
  onSetEmpty: () => void;
  onSetOption: (key: string, value: string | number | boolean) => void;
}) {
  const { content, canEdit, modules } = props;
  // #2264 — the HTML block's example moves under the field.
  const htmlHint = useFieldHint();
  const selectClass = "border-input bg-background h-9 w-full rounded-md border px-3 text-sm";
  const mode = content.type;
  return (
    <div className="space-y-2">
      <Label htmlFor="zone-content-mode">Content</Label>
      <select
        id="zone-content-mode"
        className={selectClass}
        value={mode}
        disabled={!canEdit}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "empty") props.onSetEmpty();
          else if (v === "html") props.onSetHtml(content.type === "html" ? content.html : "");
          else props.onSetModule(modules[0]?.name ?? "arrivals-board");
        }}
      >
        <option value="empty">Empty</option>
        <option value="module">Module</option>
        <option value="html">HTML block</option>
      </select>

      {content.type === "module" && (
        <>
          <select
            className={selectClass}
            aria-label="Module"
            value={content.module}
            disabled={!canEdit}
            onChange={(e) => props.onSetModule(e.target.value as DisplayModuleName)}
          >
            {modules.map((m) => (
              <option key={m.name} value={m.name}>{m.label}</option>
            ))}
          </select>
          <ModuleOptions
            moduleName={content.module}
            options={content.options}
            canEdit={canEdit}
            onSetOption={props.onSetOption}
          />
        </>
      )}

      {content.type === "html" && (
        <div className="space-y-1">
          <DisplayTokenTextarea
            id="zone-content-html"
            label="HTML"
            mode="html"
            value={content.html}
            onValueChange={props.onSetHtml}
            disabled={!canEdit}
            describedBy={htmlHint.fieldProps["aria-describedby"]}
            textareaClassName="min-h-24"
            configSource={props.configSource}
          />
          <FieldHint {...htmlHint.hintProps}>
            Example:{" "}
            <code className="bg-muted rounded px-1">
              {"<p>{{lodge-name}}</p>"}
            </code>
          </FieldHint>
        </div>
      )}
    </div>
  );
}

// The settings drawer's option controls are generated PURELY from the module's
// descriptors (ADR-004 §3/§5) — there is no free-form option key/value entry, so
// the drawer can only ever offer options the parser accepts, and it cannot offer
// a privacy-widening control (none exists in the descriptor set).
function ModuleOptions(props: {
  moduleName: DisplayModuleName;
  options: Record<string, string | number | boolean>;
  canEdit: boolean | undefined;
  onSetOption: (key: string, value: string | number | boolean) => void;
}) {
  const meta = useMemo(
    () => listPaletteDisplayModules().find((m) => m.name === props.moduleName),
    [props.moduleName]
  );
  const descriptors = meta?.options ?? [];
  if (descriptors.length === 0) {
    return <p className="text-muted-foreground text-xs">This module takes no options.</p>;
  }
  const selectClass = "border-input bg-background h-9 w-full rounded-md border px-3 text-sm";
  return (
    <div className="space-y-2">
      {descriptors.map((d) => {
        const raw = props.options[d.key];
        const current = raw ?? d.default;
        return (
          <div key={d.key} className="space-y-1">
            <Label className="text-xs" title={d.description}>
              {d.label}
            </Label>
            {d.type === "int" && (
              <Input
                type="number"
                min={d.min}
                max={d.max}
                value={Number(current)}
                disabled={!props.canEdit}
                onChange={(e) => props.onSetOption(d.key, coerceOptionValue(d, e.target.value))}
              />
            )}
            {d.type === "bool" && (
              <select
                className={selectClass}
                value={String(current === true)}
                disabled={!props.canEdit}
                onChange={(e) => props.onSetOption(d.key, coerceOptionValue(d, e.target.value))}
              >
                <option value="true">On</option>
                <option value="false">Off</option>
              </select>
            )}
            {d.type === "enum" && (
              <select
                className={selectClass}
                value={String(current)}
                disabled={!props.canEdit}
                onChange={(e) => props.onSetOption(d.key, coerceOptionValue(d, e.target.value))}
              >
                {d.allowed.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            )}
          </div>
        );
      })}
    </div>
  );
}
