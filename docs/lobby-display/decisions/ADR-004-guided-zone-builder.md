# ADR-004 — Visual template builder (guided zone builder) for lodge displays

- **Status:** Accepted (2026-07-19; owner-agreed on issue #2048). The two
  load-bearing choices — **Option A (guided zone builder)** and the **privacy
  floor** stance — were owner-ticked on issue #2048 and are recorded here as
  *binding*, not reopened. Implementation lands in the same lane, stacked on the
  #2047 template-pack branch.
- **Builds on:** [ADR-003](./ADR-003-layout-template-authoring-model.md) — the
  Layout / Template / Module authoring model. This ADR adds an authoring
  *surface* over ADR-003's data model; it changes **no** contract ADR-003
  defined (save shape, render pipeline, privacy serialiser, condition registry).
- **Related:** [ADR-001](./ADR-001-device-pairing-auth-model.md) (preview grant,
  extended in §7), `docs/lobby-display/design.md`, issue #2047 (template pack the
  builder sits on), issue #2048 (this feature).

## Summary for sign-off

Plain-English decisions this ADR locks in — confirmed with the owner:

1. **Guided zone builder, not freeform.** Admins pick a **skeleton** (columns /
   rows / side-rail / rotator) on a 16:9 canvas, drag modules from a palette
   into **zones**, and set per-module options in a drawer. There is **no
   pixel/drag positioning** — geometry comes from a small fixed set of CSS-grid
   skeletons. The builder emits ordinary `bodyHtml` / `areas` / `slotContent`
   through the **existing save contract**; nothing new is stored.
2. **The textareas stay as "Advanced mode."** Anything the builder makes can
   still be hand-edited, and Advanced mode can edit anything.
3. **Round-trip rule (decided):** a layout opens in the builder **only if it
   carries the builder's own recognisable structure** (a reserved wrapper-class
   signature that survives storage). Hand-authored or advanced-broken layouts
   **degrade gracefully to Advanced-only** with a clear banner and a "Rebuild in
   builder (replaces the body)" action. We never silently reinterpret hand HTML.
4. **No schema change.** The signature lives inside the existing `bodyHtml`
   field (stored verbatim). `DisplayLayout` / `DisplayTemplate` are untouched.
5. **Palette + drawer are generated from the module registry** — but this
   requires **adding one declarative `options` descriptor** to the existing
   module metadata (code-only, no schema), because today no machine-readable
   per-module option schema exists (options live as loose constants + parser
   functions). A drift-guard test binds each descriptor to the module's real
   parser so the drawer can never lie about a module's options.
6. **Privacy floor is enforced structurally.** Widgets may only *restrict*
   further (e.g. hide names). Widening is impossible because modules only ever
   receive the already-reduced `DisplayState`; the raw data isn't there to widen
   to. The UI offers no widening control and the save contract rejects any
   widget option that purports to widen.
7. **Built-ins stay duplicate-to-customise.** Editing a `builtin-*` design in
   the builder funnels through the existing "Duplicate to customise" fork.
8. **Live preview reuses the LTV-036 sandboxed-iframe path**, extended so it can
   render an **unsaved** draft (today it can only preview a *saved* templateId).

---

## Context

ADR-003 established that a lobby display is an admin-authored **Layout** (an HTML
body carrying `{{area:key}}` placeholders + a default CSS block + an `areas[]`
descriptor list) plus a **Template** (per-slot content — authored HTML or an
embedded module — + CSS overrides + footer). Both are stored as data
(`DisplayLayout` / `DisplayTemplate`, `prisma/schema.prisma:4613` / `:4633`),
validated by a shared save contract (`validateLayoutForSave` /
`validateTemplateForSave`, `src/lib/lodge-display/authoring-validation.ts`), and
assembled at serve time by `buildLayoutRender`
(`src/lib/lodge-display/layout-render.ts:176`).

Today those two entities are authored through **raw textareas** (bodyHtml, CSS,
per-slot HTML) in `src/app/(admin)/admin/display/layouts/page.tsx` and
`.../templates/page.tsx`. That is powerful but hostile to a non-technical
committee member: you must hand-write the grid HTML, keep `{{area:key}}`
placeholders in sync with the `areas[]` list, and know the module embed grammar.

Issue #2047 has just shipped a **pack of built-in boards** (everyday-board,
whole-lodge, singles-house, room-by-room, week-ahead, operations-board,
welcome-kiosk, plus an extras bundle — `src/lib/lodge-display/built-in-seeds.ts`)
and a template gallery. This raises the natural next question (#2048): give
admins a **visual builder** so they can compose their own boards without
touching HTML.

This ADR records the builder's shape and — crucially — how it stays a *thin
generator* over the ADR-003 data model rather than a second, divergent authoring
world.

## Decision

### 1. Option A — a guided zone builder (binding, owner-ticked)

The builder is a **guided zone composer**, explicitly **not** a freeform
pixel/drag canvas:

- A 16:9 preview-shaped canvas shows a **skeleton** chosen from a fixed set
  (§2). The skeleton defines the geometry via CSS grid; the admin never
  positions anything by pixels.
- The skeleton exposes named **zones**. The admin drags **modules** from a
  palette (§3) into a zone, or drops an **HTML content** block into a zone
  (opening the existing page-content rich editor for that slot).
- A per-zone / per-module **settings drawer** (§3) edits options, the zone's
  visibility **condition**, and (for a rotator zone) its child slots and
  rotate-seconds.
- A **live preview** (§7) renders the draft through the real display render
  path against a chosen lodge.
- **Save emits `bodyHtml` + `defaultCss` + `areas[]` (the Layout) and
  `slotContent` + `cssOverrides` + `footerHtml` (the Template)** and posts them
  through the **existing** `validateLayoutForSave` / `validateTemplateForSave`
  routes. The builder introduces **no new persistence, no new API save shape,
  and no schema change.**

The raw textareas remain, relabelled **"Advanced mode."** The builder and
Advanced mode edit the *same* stored fields; Advanced mode is the escape hatch
and can express things the builder cannot (§4 governs the round-trip).

### 2. Zone-skeleton vocabulary → deterministic bodyHtml + areas[]

A **skeleton** is a pure function `skeleton(params) → { bodyHtml, defaultCss,
areas[] }`. The generated body is exactly the shape the #2047 built-ins already
use (`built-in-seeds.ts`: `<div class="eb-grid"><div class="eb-board">{{area:board}}</div>…`).
The builder reserves a `dlb-` (display-layout-builder) class namespace so its
output is self-identifying (§4) and its grid CSS lives in `defaultCss`.

Initial skeletons (each parameterised by zone count 1–3, capped so a 16:9 wall
stays legible):

| Skeleton | Geometry | Generated body (schematic) | areas[] |
|---|---|---|---|
| **columns** | N side-by-side CSS-grid columns | `<div class="dlb-root dlb-cols dlb-cols-N"><div class="dlb-zone">{{area:z1}}</div>…</div>` | one area per column |
| **rows** | N stacked rows | `<div class="dlb-root dlb-rows"><div class="dlb-zone">{{area:z1}}</div>…</div>` | one area per row |
| **side-rail** | main + rail; rail stacks its zones (the everyday-board pattern) | `<div class="dlb-root dlb-rail"><div class="dlb-main">{{area:main}}</div><div class="dlb-side">{{area:r1}}{{area:r2}}…</div></div>` | main + one area per rail item |
| **rotator zone** | a single zone that cycles child slots | the zone's `{{area:key}}` sits in whichever parent cell it occupies | one area `kind:"rotator"` with `children[]` |

Determinism rules that keep the output valid against
`validateDisplayLayoutDefinition` (`layout-registry.ts:259`):

- Every zone gets a generated slug key (`dlb`-safe, matches `SLUG_REGEX`), unique
  across the layout; each key appears **exactly once** in `bodyHtml` and **once**
  in `areas[]` (the validator enforces both-directions agreement).
- A **static** zone → `{ key, description, kind:"static" }`. Marking a zone
  "show only when …" in the drawer flips it to `kind:"conditional"` with a
  `condition` picked from the closed condition registry (`isDisplayConditionName`).
- A **rotator** zone → `kind:"rotator"`, `rotateSeconds` (3–300, default
  `DEFAULT_ROTATE_SECONDS`), `children[]` each `{ key, description, condition? }`.
  The builder never emits `children`/`rotateSeconds` on a non-rotator or
  `defaultContent` on a rotator (the validator rejects both).
- Nesting is safe: markers portal in place since LTV-041/#96, so rail zones
  nested in `dlb-side` render correctly.

Because the generator only ever produces shapes the serve-time validator already
accepts, a builder-produced layout **cannot** fail `buildLayoutRender`.

### 3. Palette + settings drawer — generated from the module registry

The palette is generated from `listDisplayModules()`
(`src/lib/lodge-display/module-registry.ts:67`): each entry supplies `label`,
`description`, `dependencies`, `dependencyMode`, `cssHooks`, `contributes`, and
`embedToken`. Dragging a module into a static/conditional zone sets
`slotContent[zoneKey] = { module, options? }`; into a rotator child sets
`slotContent["zoneKey/childKey"] = { module, options? }`. An HTML block sets
`{ html }`. `lodge-header` / `info-footer` are page furniture and are **not**
palette items (the shell renders them; the footer is authored via the footer
editor).

**The drawer is generated from a declarative option descriptor — which must be
added.** Today there is **no machine-readable per-module option schema**:
`DisplayModuleMetadata` carries no `options`, and the real option definitions
live as loose constants (`ARRIVALS_BOARD_NAME_STYLES`, `OCCUPANCY_GRID_VARIANTS`,
`NIGHT_COLUMNS_DEFAULT_DAYS`, …) in
`src/components/lodge-display/modules/module-options.ts`, consumed *inside* each
module component through `intOption` / `boolOption` / `enumOption`. So "generate
the drawer, don't hand-list it" requires a **code-only additive change** (no
schema): extend `DisplayModuleMetadata` with an `options: DisplayModuleOptionDescriptor[]`
field, where each descriptor is:

```ts
type DisplayModuleOptionDescriptor =
  | { key: string; label: string; type: "int"; default: number; min: number; max: number }
  | { key: string; label: string; type: "bool"; default: boolean }
  | { key: string; label: string; type: "enum"; default: string; allowed: readonly string[] };
```

These descriptors are **sourced from the existing constants** (e.g.
`arrivals-board` → `days` int `{default:ARRIVALS_BOARD_DEFAULT_DAYS, min:1,
max:…}`, `nameStyle` enum `ARRIVALS_BOARD_NAME_STYLES`; `occupancy-grid` →
`variant` enum `OCCUPANCY_GRID_VARIANTS`; `night-columns` → `days` int). A
**drift-guard test** asserts, for every module, that the descriptor's
default/bounds/allowed set equals what the module's actual `intOption`/
`enumOption`/`boolOption` call would accept — so the drawer can never present an
option the renderer would reject or silently default. The parsers remain the
runtime authority (`module-options.ts`, issue hoppers99/AlpineClubBookingsNZ#30 AC6: a bad value falls back to
default, never throws); the descriptors are a *mirror for the UI*, kept honest by
the test. Options stay **scalars only** (string/number/boolean) — the same
constraint the save contract already enforces in `validateSlotContent`
(`layout-registry.ts:196`) and, for the legacy region model, in
`template-registry.ts:173`.

### 4. Builder ⇄ Advanced-mode round-trip (the decision the issue defers to us)

The schema is frozen (no "builder-generated" flag column), so the marker lives
**inside `bodyHtml`**, which is stored **verbatim** — the save route persists raw
`bodyHtml` and sanitises only at serve time
(`layouts/route.ts` POST → `data.bodyHtml = body.bodyHtml`; sanitisation is in
`layout-render.ts`). Two facts make this safe:

- **The signature is the reserved `dlb-` root class.** The builder always wraps
  its body in `<div class="dlb-root dlb-<skeleton> …">`. `class` is allowlisted
  by `sanitizePageContentHtml`, so the signature survives both storage and serve.
  (A leading HTML comment is *not* used as the sole marker — comments are less
  robust across the sanitiser; the class signature both marks and anchors the
  parse.)
- **Detection = signature present AND canonical parse succeeds.** On open, the
  builder attempts to parse the stored `bodyHtml` + `areas[]` + `slotContent`
  back into its skeleton/zone model using the exact inverse of §2. It opens in
  the builder **only if** the `dlb-root` signature is present **and** the parse
  round-trips (re-generating from the parsed model yields byte-equal
  `bodyHtml`). Otherwise → **Advanced-only**, with a clear banner:

  > "This layout was hand-edited and can't be opened in the visual builder.
  > Edit it here in Advanced mode, or **Rebuild in builder** (this replaces the
  > body with a fresh skeleton)."

This is the issue's "**degrade gracefully to advanced-only with a clear
message**" acceptance path, chosen deliberately over a best-effort HTML parse:
best-effort reinterpretation of arbitrary admin HTML is exactly the kind of
silent, surprising mutation an unattended wall must not suffer (ADR-003 §5).

**Consequence for advanced edits of a builder layout:** if an admin drops to
Advanced mode and edits a builder-made body such that it no longer round-trips
(adds a hand `<section>`, renames a wrapper), the next builder open detects the
mismatch and falls to Advanced-only rather than discarding their edit. The
signature alone is never trusted without the parse — so the builder can never
overwrite hand-work it didn't fully understand. The `#2047` pack built-ins are
authored in the same `{{area:key}}` grid idiom but with their own `eb-`/pack
class names, so they will **not** carry the `dlb-root` signature and will open
Advanced-only (or via Duplicate-to-customise, §6) until/unless re-expressed in
the `dlb-` idiom — an acceptable, low-risk migration story (they remain fully
editable in Advanced mode and fully functional on the wall).

### 5. Privacy floor — UI + server enforcement (binding, owner-ticked)

Lodge-level settings are the privacy **floor**; a widget may only restrict
further, never widen. This is enforced **structurally, not by trust**:

- The single reduction choke point is `src/lib/lodge-display-state.ts`
  (`reduceName`, `namesAllowedForBooking`, `bookingLabel`), driven by
  `lodge.displayNameGranularity`. Modules render **exclusively** from the
  already-reduced `DisplayState` payload — the raw guest names never leave the
  serialiser, so there is *nothing for a widget to widen to*. This is the
  ADR-003 invariant and the builder does not touch it.
- **UI:** the drawer exposes only **restrict-direction** controls (e.g. a
  board's "hide individual names" / counts-only toggle). No control can raise
  granularity, name a minor, or reveal a field the serialiser withholds — such
  a control simply does not exist in the descriptor set (§3).
- **Server:** `validateSlotContent` already rejects non-scalar options; the
  option descriptors (§3) additionally constrain each option to its declared
  domain, and any option whose *semantics* are widening is absent by
  construction. Defence-in-depth: the drift-guard test (§3) plus a privacy test
  asserting no descriptor introduces a name-widening option. Because widening is
  structurally impossible at the data layer, a per-widget widening request
  cannot be expressed in the UI **and** would have no raw data to act on
  server-side even if hand-injected via Advanced mode.

### 6. Built-ins stay duplicate-to-customise

Opening a `builtin-*` Layout/Template in the builder shows the existing built-in
banner and routes edits through the **"Duplicate to customise"** fork
(`templates/page.tsx:171` `duplicateTemplate`, banner at `:534`): the builder
edits the *copy* (fresh non-`builtin-` key), never the seeded row, which
`ensureBuiltInDisplays` refreshes from code on every re-seed
(`built-in-seeds.ts`). The builder's "Save" on a built-in is disabled in favour
of "Duplicate to customise, then edit." Same rule for Layouts.

### 7. Live preview — reuse the LTV-036 sandboxed iframe, extended for drafts

The builder's live preview reuses the ADR-003 §5 / LTV-036 path: a short-lived,
HMAC-signed **preview grant** renders `/display` inside a
`sandbox="allow-scripts"` (opaque-origin, no-session) iframe against an explicit
lodge, with the simulated-date affordance. The builder emits the **same draft
shape** the existing seam anticipates —
`{ bodyHtml, defaultCss, areas: buildAreasPayload(draft) }` plus the template
side `{ slotContent, cssOverrides, footerHtml }` — the shape flagged as the
preview seam at `layouts/page.tsx:117` (`buildAreasPayload`, comment at
`:109–116`).

**Gap this ADR closes:** the current grant mint
(`src/app/api/admin/display/preview-grant/route.ts`) accepts only a **saved**
`templateId` — it cannot preview an unsaved draft (the `buildAreasPayload`
comment itself calls draft preview a *future* seam, hoppers99/AlpineClubBookingsNZ#82/#79). The decision:

- Add an admin-only **draft-render** step: under the admin session, the mint
  validates the draft (`validateLayoutForSave` + `validateTemplateForSave`) and
  runs `buildLayoutRender` against the chosen lodge's `DisplayState`, producing a
  `LayoutRenderPayload`. Validation failure returns the same structured
  errors/warnings the save UI shows (preview *is* the save gate — ADR-003 §5
  "preview-before-save").
- The grant is widened from "names a `templateId`" to "names **either** a stored
  `templateId` **or** a short-lived draft handle." The draft's rendered payload
  is held in an **ephemeral in-memory server-side store keyed by a nonce embedded
  in the signed grant** (TTL = the existing 5-minute grant TTL, single-instance
  admin preview) — **not** a DB row (no schema change, no orphan
  `DisplayTemplate` rows). The opaque-origin iframe reads it exactly as it reads
  a stored preview today (permissive CORS on the grant/draft response only, no
  credentials — the ADR-003 §5 mechanism unchanged). The grant still authorises
  **only** the preview render and nothing else; it stamps no `lastSeenAt` and is
  domain-separated from the pairing blob.

This keeps every ADR-003 §5 security property (opaque origin, no admin session
in the frame, privacy-reduced payload via the same `buildDisplayState`, 5-minute
single-purpose capability) while letting the wall-accurate preview run on
unsaved work.

### 8. Drag-and-drop accessibility

DnD uses **@dnd-kit** (`@dnd-kit/core` + `@dnd-kit/utilities`, already
dependencies):

- Register both `PointerSensor` and `KeyboardSensor` so every module → zone drag
  is fully **keyboard-operable** (space/enter to lift, arrows to move, escape to
  cancel) — dragging is never the only way to place a module.
- **Reordering** (rail zones / rotator children) is done with keyboard-accessible
  **arrow (↑/↓) buttons** + pure move helpers, not drag-sortable. *Implementation
  note:* the ADR originally called for adding **`@dnd-kit/sortable`**; in build we
  found the accessible arrow-button reordering is equal-or-better for a11y (no
  pointer required, explicit labels, trivially testable) and fully substitutes
  sortable's DnD-only reordering, so `@dnd-kit/sortable` was **not** added — the
  smallest faithful deviation, keeping the a11y guarantee intact.
- Provide `DragOverlay` and `aria-live` screen-reader announcements
  (`announcements` / `screenReaderInstructions`) for pick-up, over, drop, cancel.
- **Focus management:** after a drop the moved item retains focus; opening the
  settings drawer moves focus into it and restores focus to the trigger on
  close. Zones and palette items are reachable in a logical tab order.
- A non-DnD fallback (an "Add module to zone" menu on each zone) guarantees the
  builder is operable with no pointer at all.

### 9. Testing strategy

- **Golden generation tests:** for each skeleton × zone-count, assert
  `skeleton(params)` emits the exact `bodyHtml`/`defaultCss`/`areas[]` and that
  the result passes `validateLayoutForSave`; for representative module drops,
  assert `slotContent` passes `validateTemplateForSave` and that
  `buildLayoutRender` produces a payload (no throw).
- **Round-trip tests:** `parse(generate(model)) === model` for every skeleton;
  and the negative direction — a hand-authored / signature-less / non-round-trip
  body is classified **Advanced-only** (never silently opened or mutated).
- **Registry-descriptor drift guard (§3):** each module's option descriptor
  matches its real parser's default/bounds/allowed; a new module without a
  descriptor fails the sweep (mirrors the existing `MODULE_REGISTRY` load-time
  guard).
- **Privacy tests (§5):** no descriptor introduces a name-widening option; a
  widget "hide names" option only ever reduces.
- **DnD a11y tests:** keyboard reorder + module placement work headless; drawer
  focus trap/restore.
- **Preview-draft tests:** an invalid draft returns structured errors (no grant
  minted); a valid draft mints a draft-handle grant and the ephemeral payload
  renders; the grant authorises nothing but the preview.

## Consequences

**Gained:** a non-technical admin can compose a valid board without writing HTML
or keeping placeholders in sync; every output is, by construction, a valid
ADR-003 Layout+Template that the existing save contract and render pipeline
already trust. No schema migration.

**Additive code changes (no schema):** one `options` descriptor field on
`DisplayModuleMetadata` + its drift-guard; the preview grant widened to carry a
draft handle + an ephemeral draft-render store. (No new runtime dependency:
`@dnd-kit/sortable` proved unnecessary — see §8's implementation note.)

**What gets harder — two edit surfaces to keep coherent.** The builder and
Advanced mode target the same fields, so the round-trip contract (§4) is
load-bearing: it is the single mechanism that keeps them from diverging, and it
is deliberately conservative (signature + exact round-trip, else Advanced-only)
precisely so the builder never surprises an unattended wall. The skeleton set is
intentionally small; a body that outgrows it lives in Advanced mode.

**Migration story for the #2047 pack.** The seven+ shipped built-ins are authored
in the `{{area:key}}` grid idiom but under their own class names, so they open
**Advanced-only** (and via Duplicate-to-customise) until — as optional
follow-up — they are re-expressed in the `dlb-` skeleton idiom. They remain fully
functional and Advanced-editable meanwhile; this is a deliberate non-blocker, not
a regression.

**Deferred / not built:** freeform pixel positioning (rejected by decision A);
best-effort parsing of arbitrary hand HTML into the builder (rejected in §4);
inline colour picker and richer theme controls (ADR-003 §4 already defers these).

## Security considerations

- **No new trust surface.** The builder is a client-side generator; every byte it
  produces goes through the **same** `validateLayoutForSave` /
  `validateTemplateForSave` gate and the same serve-time sanitiser
  (`sanitizePageContentHtml` + `sanitiseDisplayCss` + `scopeDisplayCss`). The
  builder cannot emit anything Advanced mode couldn't, so it widens no attack
  surface — the "no admin-authored JavaScript" boundary (ADR-003) is untouched.
- **Privacy floor is structural (§5),** not a UI courtesy: modules only see the
  reduced `DisplayState`; widening is impossible at the data layer regardless of
  what a widget option claims.
- **Draft preview preserves LTV-036 (§7):** opaque-origin sandboxed iframe, no
  admin session in the frame, privacy-reduced payload, 5-minute single-purpose
  grant, ephemeral (non-persisted) draft, no `lastSeenAt`, domain-separated from
  pairing. Validation runs **before** a grant is minted, so a broken draft
  produces structured errors, never a rendered broken wall.
- **Signature spoofing is harmless (§4):** the `dlb-root` class is only a *hint*;
  the builder still requires an exact round-trip parse before it will open a body,
  so a hand-forged signature on non-conforming HTML simply falls to Advanced-only
  — it can neither trick the builder into mis-editing nor bypass any validator.
