# ADR-002: Display template model and storage

**Status:** Superseded by [ADR-003](./ADR-003-layout-template-authoring-model.md)
— the data-only region/panel model here was the MVP (staging only, never
shipped); ADR-003 replaces the storage/editing layer with the Layout / Template /
Module authoring model. The closed-registry validation *principle* and the
data-only stance on *definitions* carry forward; admin-authored HTML/CSS
(never JS) and code modules are the change.
**Issue:** fork hoppers99/AlpineClubBookingsNZ#29 (LTV-004), epic hoppers99/AlpineClubBookingsNZ#25
**Deciders:** fork owner (delivery authorisation on epic hoppers99/AlpineClubBookingsNZ#25), implementation agent

## Context

The lobby display renders an admin-chosen template. The brief settled a
two-layer model — templates define regions, region configuration populates
them — with template-level, condition-aware panel rotation. This ADR fixes
how templates are represented, stored, resolved, and validated.

## Decision

### 1. Data-only definitions

A template definition is pure data, validated against closed registries:

```ts
DisplayTemplateDefinition {
  key, name,
  regions: [{ key, panels: [{ module, condition?, options? }], rotateSeconds?, layout? }]
}
```

- `module` must be a **registered module name** (closed list in
  `template-registry.ts`; LTV-005/006 attach the renderers). Unknown name →
  the definition is rejected at load with a descriptive error — a template
  can never render partially broken.
- `condition` must be a **registered condition name** (closed list in
  `conditions.ts`); default `always`.
- `options` are scalar key/values passed to the module (each module
  validates its own options and falls back to defaults — LTV-005 rule).
- No HTML, no expressions, no code paths of any kind exist in a definition —
  custom templates get exactly the same schema, so the authoring surface is
  uniform and cannot introduce script execution (issue hoppers99/AlpineClubBookingsNZ#29 AC7).

### 2. Storage: code defaults + DB overrides (the `EmailTemplateOverride` pattern)

- The three starter templates (everyday board, whole-lodge, singles house —
  the approved design-exploration mockups) ship as a **code registry**.
  They are versioned, reviewed, and always available.
- A `DisplayTemplate` row with `source = BUILT_IN_OVERRIDE` and a matching
  `key` **shadows** the code default; deleting the row restores the
  built-in. `source = CUSTOM` rows are admin-authored templates with their
  own keys. Rows store the same definition JSON and pass the same validator
  on load; an invalid stored row is rejected (never silently rendered).
- Rationale vs DB-only: built-ins cannot be lost or corrupted by admin
  action, ship with code review, and need no seeding; rationale vs
  code-only: admins tweak or author templates without a deploy (the brief's
  core requirement).

### 3. Rotation: template-level, condition-aware

A region with more than one panel rotates (`rotateSeconds`, default 8) —
unless it declares `layout: "stack"` (added in LTV-015, issue hoppers99/AlpineClubBookingsNZ#56), which
renders every eligible panel at once: the sidebar-card treatment from the
approved mockups (chores + instruction cards beside the board). The default
`layout: "rotate"` keeps every pre-existing definition valid unchanged.
Each panel's `condition` is evaluated **as a pure function of the
`DisplayState` payload** — no queries, no side effects — and ineligible
panels are skipped, so a screen never rotates into a view that is wrong for
the current data (e.g. the blockout panel shows only while
`whole-lodge-booking-in-window` holds). v1 conditions are a fixed named
set: `always`, `whole-lodge-booking-in-window`, `arrivals-today`,
`no-guests`. A general expression language was considered and deferred
(brief open question 3): named conditions are testable, enumerable in an
admin dropdown, and cannot smuggle logic.

## Security considerations

- **No script execution path:** definitions are data-only; the validator
  rejects unknown module/condition names; modules render exclusively from
  the privacy-reduced `DisplayState` payload (ADR/LTV-003), so a malicious
  or buggy template cannot widen what a screen shows.
- **Stored definitions are untrusted input:** DB rows revalidate on every
  load, exactly like code defaults; validation failures throw with the
  offending key rather than degrading.
- **Options are scalars** (string/number/boolean) with per-module
  validation and defaults — no objects, no URLs fetched, no HTML.

## Alternatives considered

- **DB-only templates (seeded built-ins)** — rejected: admin edits could
  corrupt or delete the only copy of the starter set; seeding adds
  migration weight; code review is lost.
- **React components as templates (code-only)** — rejected: no admin
  authoring without deploys, contradicting the brief.
- **Expression language for conditions** — deferred: power without a
  present need; hard to audit; the named set covers every approved mockup.
- **Per-panel free HTML regions** — rejected (AC7): reintroduces an
  injection surface the data-only model exists to prevent.
