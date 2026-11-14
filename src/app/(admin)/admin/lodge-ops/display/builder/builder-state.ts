import {
  defaultChildKey,
  defaultZoneKey,
  emptyBuilderModel,
  BUILDER_MAX_ZONES,
  BUILDER_MAX_RAIL_ZONES,
  BUILDER_MAX_ROTATOR_CHILDREN,
  type BuilderChild,
  type BuilderContent,
  type BuilderModel,
  type BuilderSkeleton,
  type BuilderZone,
} from "@/lib/lodge-display/builder-model";
import {
  getDisplayModule,
  type DisplayModuleOptionDescriptor,
} from "@/lib/lodge-display/module-registry";
import type {
  DisplayModuleName,
  DisplayPanelOptionValue,
} from "@/lib/lodge-display/template-registry";

// Pure, React-free state helpers for the guided zone builder (ADR-004 §1). Every
// mutation returns a NEW model with canonical positional slug keys
// (`normalizeKeys`), so generation stays deterministic and valid no matter how
// zones are reordered — the admin never types a key. Extracted from the client
// component so the zone/child/content transforms are unit-testable headlessly.

/** Re-derive every zone/child key positionally so keys are always unique, valid
 * slugs, and stable across reorders (the ADR's "generated slug key"). */
export function normalizeKeys(model: BuilderModel): BuilderModel {
  return {
    skeleton: model.skeleton,
    zones: model.zones.map((zone, index) => {
      const key = defaultZoneKey(model.skeleton, index);
      if (zone.kind === "rotator") {
        return {
          ...zone,
          key,
          children: zone.children.map((child, ci) => ({
            ...child,
            key: defaultChildKey(ci),
          })),
        };
      }
      return { ...zone, key };
    }),
  };
}

/** Default options for a module drop: the descriptor defaults, so a freshly
 * dropped module renders exactly as its documented defaults (never a value the
 * parser would reject). */
export function defaultOptionsFor(
  moduleName: DisplayModuleName
): Record<string, DisplayPanelOptionValue> {
  const meta = getDisplayModule(moduleName);
  const out: Record<string, DisplayPanelOptionValue> = {};
  for (const option of meta?.options ?? []) {
    out[option.key] = option.default;
  }
  return out;
}

function freshStaticZone(key: string): BuilderZone {
  return { key, description: "", kind: "static", content: { type: "empty" } };
}

/** The min zones a skeleton must keep (side-rail always keeps its main cell). */
export const MIN_ZONES = 1;

/** The max zones a skeleton allows. */
export function maxZones(skeleton: BuilderSkeleton): number {
  // side-rail: main + up to BUILDER_MAX_RAIL_ZONES rail zones.
  return skeleton === "side-rail" ? BUILDER_MAX_RAIL_ZONES + 1 : BUILDER_MAX_ZONES;
}

/** True when another zone may be added under the skeleton's cap. */
export function canAddZone(model: BuilderModel): boolean {
  return model.zones.length < maxZones(model.skeleton);
}

/** Switch skeletons, preserving zone kinds/content where the cap allows and
 * re-keying positionally. Truncates to the target skeleton's max. */
export function changeSkeleton(
  model: BuilderModel,
  skeleton: BuilderSkeleton
): BuilderModel {
  if (skeleton === model.skeleton) return model;
  const cap = maxZones(skeleton);
  const kept = model.zones.slice(0, cap);
  const zones = kept.length > 0 ? kept : emptyBuilderModel(skeleton).zones;
  return normalizeKeys({ skeleton, zones });
}

export function addZone(model: BuilderModel): BuilderModel {
  if (!canAddZone(model)) return model;
  return normalizeKeys({
    skeleton: model.skeleton,
    zones: [...model.zones, freshStaticZone("")],
  });
}

export function removeZone(model: BuilderModel, index: number): BuilderModel {
  // side-rail's main cell (index 0) is structural and cannot be removed.
  if (model.skeleton === "side-rail" && index === 0) return model;
  if (model.zones.length <= MIN_ZONES) return model;
  return normalizeKeys({
    skeleton: model.skeleton,
    zones: model.zones.filter((_, i) => i !== index),
  });
}

/** Move a zone from `from` to `to` (bounded). In side-rail the main cell stays
 * pinned at index 0 — only rail zones (index ≥ 1) reorder among themselves. */
export function moveZone(
  model: BuilderModel,
  from: number,
  to: number
): BuilderModel {
  if (from === to) return model;
  const lower = model.skeleton === "side-rail" ? 1 : 0;
  if (from < lower || to < lower) return model;
  const clampedTo = Math.max(lower, Math.min(model.zones.length - 1, to));
  const zones = [...model.zones];
  const [moved] = zones.splice(from, 1);
  // This IS the old `from >= model.zones.length` rejection: a `from` past the
  // end splices nothing out. Its other half, `from < 0`, is already ruled out
  // by `from < lower` above (`lower` is 0 or 1), which matters because a
  // negative index would make `splice` remove from the END instead (#2801).
  if (moved === undefined) return model;
  zones.splice(clampedTo, 0, moved);
  return normalizeKeys({ skeleton: model.skeleton, zones });
}

function mapZone(
  model: BuilderModel,
  index: number,
  fn: (zone: BuilderZone) => BuilderZone
): BuilderModel {
  return normalizeKeys({
    skeleton: model.skeleton,
    zones: model.zones.map((zone, i) => (i === index ? fn(zone) : zone)),
  });
}

export function setZoneDescription(
  model: BuilderModel,
  index: number,
  description: string
): BuilderModel {
  return mapZone(model, index, (zone) => ({ ...zone, description }));
}

/** Change a zone's kind, initialising the fields the new kind needs and dropping
 * the ones it forbids (the validator rejects a condition on a non-conditional,
 * children on a non-rotator, …). */
export function setZoneKind(
  model: BuilderModel,
  index: number,
  kind: BuilderZone["kind"]
): BuilderModel {
  return mapZone(model, index, (zone) => {
    if (zone.kind === kind) return zone;
    const base = { key: zone.key, description: zone.description };
    const prevContent: BuilderContent =
      zone.kind === "rotator" ? { type: "empty" } : zone.content;
    if (kind === "rotator") {
      const firstChild: BuilderChild = {
        key: defaultChildKey(0),
        description: "",
        condition: null,
        content: prevContent,
      };
      return { ...base, kind: "rotator", rotateSeconds: 8, children: [firstChild] };
    }
    if (kind === "conditional") {
      return { ...base, kind: "conditional", condition: "", content: prevContent };
    }
    return { ...base, kind: "static", content: prevContent };
  });
}

export function setZoneCondition(
  model: BuilderModel,
  index: number,
  condition: string
): BuilderModel {
  return mapZone(model, index, (zone) =>
    zone.kind === "conditional" ? { ...zone, condition } : zone
  );
}

export function setZoneRotateSeconds(
  model: BuilderModel,
  index: number,
  rotateSeconds: number
): BuilderModel {
  return mapZone(model, index, (zone) =>
    zone.kind === "rotator" ? { ...zone, rotateSeconds } : zone
  );
}

export function setZoneContent(
  model: BuilderModel,
  index: number,
  content: BuilderContent
): BuilderModel {
  return mapZone(model, index, (zone) =>
    zone.kind === "rotator" ? zone : { ...zone, content }
  );
}

/** Set a zone (static/conditional) to render a module with its default options. */
export function setZoneModule(
  model: BuilderModel,
  index: number,
  moduleName: DisplayModuleName
): BuilderModel {
  return setZoneContent(model, index, {
    type: "module",
    module: moduleName,
    options: defaultOptionsFor(moduleName),
  });
}

export function setZoneOption(
  model: BuilderModel,
  index: number,
  key: string,
  value: DisplayPanelOptionValue
): BuilderModel {
  return mapZone(model, index, (zone) => {
    if (zone.kind === "rotator" || zone.content.type !== "module") return zone;
    return {
      ...zone,
      content: {
        ...zone.content,
        options: { ...zone.content.options, [key]: value },
      },
    };
  });
}

// --- Rotator children ------------------------------------------------------

function mapChild(
  model: BuilderModel,
  zoneIndex: number,
  childIndex: number,
  fn: (child: BuilderChild) => BuilderChild
): BuilderModel {
  return mapZone(model, zoneIndex, (zone) =>
    zone.kind === "rotator"
      ? {
          ...zone,
          children: zone.children.map((child, i) =>
            i === childIndex ? fn(child) : child
          ),
        }
      : zone
  );
}

export function addChild(model: BuilderModel, zoneIndex: number): BuilderModel {
  return mapZone(model, zoneIndex, (zone) => {
    if (zone.kind !== "rotator") return zone;
    if (zone.children.length >= BUILDER_MAX_ROTATOR_CHILDREN) return zone;
    return {
      ...zone,
      children: [
        ...zone.children,
        { key: "", description: "", condition: null, content: { type: "empty" } },
      ],
    };
  });
}

export function removeChild(
  model: BuilderModel,
  zoneIndex: number,
  childIndex: number
): BuilderModel {
  return mapZone(model, zoneIndex, (zone) => {
    if (zone.kind !== "rotator" || zone.children.length <= 1) return zone;
    return { ...zone, children: zone.children.filter((_, i) => i !== childIndex) };
  });
}

export function moveChild(
  model: BuilderModel,
  zoneIndex: number,
  from: number,
  to: number
): BuilderModel {
  return mapZone(model, zoneIndex, (zone) => {
    if (zone.kind !== "rotator") return zone;
    // `from < 0` stays an explicit rejection because a negative index makes
    // `splice` remove from the END rather than nothing; the upper bound is
    // then the splice result itself (#2801).
    if (from < 0) return zone;
    const clampedTo = Math.max(0, Math.min(zone.children.length - 1, to));
    if (from === clampedTo) return zone;
    const children = [...zone.children];
    const [moved] = children.splice(from, 1);
    if (moved === undefined) return zone;
    children.splice(clampedTo, 0, moved);
    return { ...zone, children };
  });
}

export function setChildDescription(
  model: BuilderModel,
  zoneIndex: number,
  childIndex: number,
  description: string
): BuilderModel {
  return mapChild(model, zoneIndex, childIndex, (child) => ({ ...child, description }));
}

export function setChildCondition(
  model: BuilderModel,
  zoneIndex: number,
  childIndex: number,
  condition: string | null
): BuilderModel {
  return mapChild(model, zoneIndex, childIndex, (child) => ({ ...child, condition }));
}

export function setChildModule(
  model: BuilderModel,
  zoneIndex: number,
  childIndex: number,
  moduleName: DisplayModuleName
): BuilderModel {
  return mapChild(model, zoneIndex, childIndex, (child) => ({
    ...child,
    content: {
      type: "module",
      module: moduleName,
      options: defaultOptionsFor(moduleName),
    },
  }));
}

export function setChildContent(
  model: BuilderModel,
  zoneIndex: number,
  childIndex: number,
  content: BuilderContent
): BuilderModel {
  return mapChild(model, zoneIndex, childIndex, (child) => ({ ...child, content }));
}

export function setChildOption(
  model: BuilderModel,
  zoneIndex: number,
  childIndex: number,
  key: string,
  value: DisplayPanelOptionValue
): BuilderModel {
  return mapChild(model, zoneIndex, childIndex, (child) => {
    if (child.content.type !== "module") return child;
    return {
      ...child,
      content: { ...child.content, options: { ...child.content.options, [key]: value } },
    };
  });
}

/** Coerce a raw drawer input value to the descriptor's declared scalar type, so
 * the model always holds a value inside the descriptor's domain (the drawer can
 * never push a value the parser would reject). */
export function coerceOptionValue(
  descriptor: DisplayModuleOptionDescriptor,
  raw: string | boolean
): DisplayPanelOptionValue {
  if (descriptor.type === "bool") {
    return typeof raw === "boolean" ? raw : raw === "true";
  }
  if (descriptor.type === "int") {
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n)) return descriptor.default;
    return Math.min(descriptor.max, Math.max(descriptor.min, n));
  }
  // enum
  const s = String(raw);
  return descriptor.allowed.includes(s) ? s : descriptor.default;
}
