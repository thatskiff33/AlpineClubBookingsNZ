// Pure slot-editor helpers for the Template authoring page (fork issue #79,
// #111). Extracted from page.tsx so the seeding/reseeding logic is unit-testable
// without rendering the client component. No React, no fetch — pure data.

export interface AreaChild {
  key: string;
  description?: string;
}

export interface AreaDefinition {
  key: string;
  description?: string;
  kind: "static" | "conditional" | "rotator";
  children?: AreaChild[];
  /** static/conditional only: the layout's per-area default content that seeds a
   * new template's slot (issue #111). Rotator children carry none yet. */
  defaultContent?: { html?: string } | { module?: string; options?: Record<string, unknown> };
}

export interface OptionDraft {
  key: string;
  value: string;
}

export interface SlotDraft {
  slotKey: string;
  label: string;
  description: string;
  mode: "html" | "module";
  html: string;
  moduleName: string;
  options: OptionDraft[];
  /** The layout-provided default content for this slot, when its area declares
   * one (static/conditional areas only). Drives the per-slot "Reset to default"
   * control: present ⇒ the slot can be re-seeded from its default; absent ⇒ no
   * default to reset to. */
  defaultContent?: AreaDefinition["defaultContent"];
}

/** The editable content fields of a slot draft (everything a seed sets). */
export type SlotContentFields = Pick<SlotDraft, "mode" | "html" | "moduleName" | "options">;

/** Seed one slot's editor fields from a stored SlotContent (or a layout default). */
export function seedSlot(content: unknown): SlotContentFields {
  const record = (content ?? {}) as Record<string, unknown>;
  if (typeof record.module === "string") {
    const rawOptions =
      record.options && typeof record.options === "object" && !Array.isArray(record.options)
        ? (record.options as Record<string, unknown>)
        : {};
    return {
      mode: "module",
      html: "",
      moduleName: record.module,
      options: Object.entries(rawOptions).map(([key, value]) => ({
        key,
        value: String(value),
      })),
    };
  }
  return {
    mode: "html",
    html: typeof record.html === "string" ? record.html : "",
    moduleName: "",
    options: [],
  };
}

/**
 * Generate one slot box per declared slot of the bound layout's areas, seeded
 * from any stored template slotContent, else the layout's defaultContent. A
 * static/conditional area is one slot keyed by the area; a rotator is one slot
 * per child keyed "area/child". Static/conditional slots retain their area's
 * `defaultContent` so the editor can offer a per-slot "Reset to default".
 */
export function buildSlots(
  areas: AreaDefinition[],
  slotContent: Record<string, unknown> = {}
): SlotDraft[] {
  const slots: SlotDraft[] = [];
  for (const area of areas) {
    if (area.kind === "rotator") {
      for (const child of area.children ?? []) {
        const slotKey = `${area.key}/${child.key}`;
        const seed = seedSlot(slotContent[slotKey]);
        slots.push({
          slotKey,
          label: `${area.key} / ${child.key}`,
          description: child.description ?? "",
          ...seed,
        });
      }
    } else {
      const slotKey = area.key;
      const stored = slotContent[slotKey];
      const seed = seedSlot(stored !== undefined ? stored : area.defaultContent);
      slots.push({
        slotKey,
        label: area.key,
        description: area.description ?? "",
        ...seed,
        defaultContent: area.defaultContent,
      });
    }
  }
  return slots;
}

/**
 * Re-seed one slot's editor fields from its layout-provided default content
 * (issue #111). Shares the seeding logic with buildSlots via seedSlot. When the
 * slot's area declares no default, the fields reset to an empty HTML box — but
 * the UI only exposes this control for slots that HAVE a default.
 */
export function reseedSlotFromDefault(slot: SlotDraft): SlotDraft {
  return { ...slot, ...seedSlot(slot.defaultContent) };
}

/** Assemble the slotContent JSON the save contract validates. Empty slots are
 * omitted so they fall back to the layout default (or render nothing). */
export function buildSlotContentPayload(slots: SlotDraft[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const slot of slots) {
    if (slot.mode === "module") {
      if (!slot.moduleName) continue;
      const options: Record<string, string> = {};
      for (const option of slot.options) {
        const key = option.key.trim();
        if (key !== "") options[key] = option.value;
      }
      out[slot.slotKey] =
        Object.keys(options).length > 0
          ? { module: slot.moduleName, options }
          : { module: slot.moduleName };
    } else {
      const html = slot.html.trim();
      if (html !== "") out[slot.slotKey] = { html };
    }
  }
  return out;
}
