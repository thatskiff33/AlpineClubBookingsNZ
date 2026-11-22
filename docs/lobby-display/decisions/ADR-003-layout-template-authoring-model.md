# ADR-003 — Layout / Template / Module authoring model (supersedes ADR-002)

- **Status:** Accepted (design agreed with the owner; implementation decomposed
  under the v2 epic).
- **Supersedes:** [ADR-002](./ADR-002-template-model-and-storage.md) — the
  data-only region/panel template model.
- **Related:** [ADR-001](./ADR-001-device-pairing-auth-model.md) (pairing/auth,
  unchanged), `docs/lobby-display/design.md`.

## Context

ADR-002 defined display templates as **data-only** JSON (regions → panels →
module/condition/scalar options, validated against closed registries), edited
as raw JSON in the admin. The MVP shipped on that model (LTV-001…017) but only
to the owner's **staging** box with seed/test data — it has never reached
production and never gone upstream, so **there is no real data to preserve.**

Owner review produced a different authoring vision (largely backlog hoppers99/AlpineClubBookingsNZ#63):
admins should compose displays from an HTML **layout** with named areas, fill
those areas with content or embedded modules, and style with CSS — closer to
the website CMS than to a JSON definition. This ADR records that model and the
decision to **replace** the ADR-002 storage/editing layer with it.

Because nothing shipped, this is a clean redesign, not a migration: the current
`DisplayTemplate` model and the `Lodge.displayConfig` JSON-glob editing surface
are removed and rebuilt; the seed bundle and built-ins are re-expressed.

## Decision

Three authored/where-noted-code entities, a fixed page shell, and a single
namespaced **conditions** vocabulary.

### 1. Entities

**Layout** (admin-authored). The structural template: HTML defining the **body
area** with named **areas/slots**, a **default CSS** block, and slot metadata
(key + description + default content). All layouts share a **fixed header**
(logo, lodge name, club name, live date/time) and an **editable footer** —
only the body differs. An area may be:

- *static* — always rendered;
- *conditional* — rendered only when its assigned condition holds (§3);
- a *rotator* — cycles among its child slots, each child optionally conditional,
  so it rotates only among currently-eligible children.

**Template** (admin-authored, the selectable design). Built on a Layout: an
editor box per declared slot (seeded from the Layout's defaults, edited with
the **website page-content rich editor**), **CSS overrides/extensions** on top
of the Layout default, and the **footer content**. A Template renders
**dynamically against whichever lodge its display is bound to** — tokens such
as `{{config:wifi-code}}` resolve at usage time to that lodge's values. A
Template may hard-code club-wide content or use lodge tokens; lodge-specific vs
club-wide is the author's choice, never forced.

**Module** (developer code — like the website's weather widget). A React
component in the repo, referenced from a Layout/Template by an embed token.
Admins **style** modules via CSS but never author module code or JavaScript.
Each module **declares**: `label`, `description`, its data/flag
**dependencies**, its stable **CSS hooks** (the class contract admins target),
and any **conditions/tokens it contributes** (§3). Every module ships a
**graceful fallback** so an unmet dependency degrades or hides rather than
blanking the wall. The MVP components (arrivals-board, occupancy-grid,
singles-board, chores, rules, notice, welcome) become the initial Module
library.

### 2. Page shell (fixed)

Header and footer are page furniture, not part of the editable body:

- **Header** — fixed structure, dynamic values: club logo (ClubTheme), lodge
  name, club name (club config), and the live clock (incl. the LTV-017
  simulated-date affordance). Consistent across every template.
- **Footer** — editable content per Template (Wi-Fi, contact, notes), authored
  like any other slot.

This keeps the high-level page consistent and shrinks the surface where a
template can break.

### 3. Conditions (one namespaced vocabulary)

Conditions gate *any* area (show/hide) and drive rotator eligibility. They are a
**closed, code-defined registry** — admins pick from a **dropdown** and discover
them in a **Conditions reference** screen (name + description + family + a live
"true right now for this lodge" indicator); no free-form expressions.

Names are **namespaced `namespace:name`**, consistent with the existing
`{{config:key}}` token grammar and giving clash-free contribution:

- **`<module>:…`** — contributed by an optional module (namespace = module key):
  `bed-allocation:enabled`, `chores:enabled`, `chores:today`, and (reserved for
  the later weather work) `skifield:available`. Capability (`*-enabled`)
  conditions are **generated from `MODULE_DEFINITIONS`** (`src/config/modules.ts`),
  inheriting each module's `label`/`description` and staying in sync automatically.
- **`occupancy:…`** and **`content:…`** — core built-ins not tied to an optional
  module.
- **`always`** — the default (bare).

Agreed initial set (occupancy states default to **today**; a **window** variant
exists only where rotation needs it):

| Condition | Fires when |
|---|---|
| `always` | default |
| `occupancy:whole-lodge-today` | the lodge is wholly one booking tonight |
| `occupancy:whole-lodge-in-window` | a whole-lodge booking appears anywhere in the window (drives the rotating blockout) |
| `occupancy:empty-today` | no guests tonight |
| `occupancy:arrivals-today` | someone arrives today |
| `occupancy:departures-today` | someone departs today |
| `content:notice` | committee notice is set |
| `content:instructions` | any lodge instruction doc is present (per-document a later refinement) |
| `bed-allocation:enabled` | Bed Allocation module on |
| `chores:enabled` | Chores module on |
| `chores:today` | chores assigned for today (implies enabled) |

`skifield:available` is the worked example of a module-contributed condition,
built with the later weather panel — not in the initial set. The registry stays
closed but structured so a module contributes its own conditions/tokens by
shipping, not by admins writing expressions. The same `namespace:name` grammar
covers config tokens, conditions, and future module value tokens — one
contribution model.

### 4. Rendering, tokens, CSS

- **Token resolution** runs over admin content: `{{config:…}}`, `{{lodge-name}}`,
  `{{display-date}}`, module refs, and module-contributed tokens — but keeps the
  **display's own token set**, not the whole website token catalogue, so a wall
  can never resolve a site token that surfaces data not intended for a lobby
  screen.
- **HTML/CSS** reuse the website CMS content pipeline (its sanitiser + rich
  editor) — same trust model, minus any admin-authored script.
- **Theme tokens**: the CSS editor exposes the existing club-theme / display CSS
  custom properties as named placeholders, so a Template matches the website's
  colours/fonts by default and adapts if the theme changes — **without any change
  to the existing site CSS structure**. An inline colour picker is a later polish.

### 5. Preview

A display specifies a lodge, so preview is **display-scoped** (kiosk-style — it
renders that display's lodge; already correct via `previewDevice`). The
template-editor quick preview must render against a **clearly-indicated lodge**,
not silently the default (shrinks backlog hoppers99/AlpineClubBookingsNZ#64). The **simulated date** (LTV-017)
is retained; its **picker markup is fixed** (backlog hoppers99/AlpineClubBookingsNZ#65). Because previews now
render admin HTML/CSS, preview renders in a **sandboxed iframe** so a template
authored by one admin cannot run against another admin's session.

*(Implemented in LTV-036.)* The Templates page **Preview** opens a minimal host
(`/admin/display/preview`) that mints a **short-lived (5-minute), HMAC-signed,
single-purpose preview grant** and renders `/display` inside an
`sandbox="allow-scripts"` iframe (**no** `allow-same-origin`, so the framed
document runs at an opaque origin — no cookies, no same-origin DOM). The framed
page sends the grant (`?previewGrant=<token>`) in place of a session; the state
route verifies signature + expiry and serves exactly that template/lodge preview
— the grant is **not** a display token, stamps no `lastSeenAt`, and authorises no
other route. The lodge is **explicit** (`?previewLodge=<id>`, validated active;
club default when omitted) and shown as a "previewing against <lodge>" line, and
the simulated-date input is now a **sibling** of the picker button so a selection
applies. Direct-navigation previews (`?preview=1&templateId=…` with the admin's
own session, and `?previewDevice=…`) keep working for an admin's personal use.
The opaque-origin frame's cross-origin fetch is made readable with a permissive
CORS header on the grant response only (no credentials are sent), and `/display`
carries a scoped `frame-ancestors 'self'` / `X-Frame-Options: SAMEORIGIN` so only
our own admin host may frame it.

## Consequences

**Replaced:** the `DisplayTemplate` JSON-region model; the raw-JSON editor; the
`Lodge.displayConfig` glob **editing location** (the per-lodge values move into
the lodge configuration UI — backlog hoppers99/AlpineClubBookingsNZ#62); the ADR-002 condition names (renamed
into the namespaced scheme — no alias map needed since nothing shipped).

**Carried over unchanged:** pairing/auth (ADR-001, `LodgeDisplayDevice`); the
**privacy serialiser** (`buildDisplayState` — name reduction, minors-as-family,
no money/contact/member-id — unchanged); the display page shell + CSP fix; the
module React components and their CSS (they become the Module library); the
simulated-date preview.

**Redone:** config-transfer (LTV-012) for the new Layout/Template entities; the
three built-ins (everyday-board / whole-lodge / singles) re-expressed as
Layouts+Templates carrying the LTV-015/016 visual standard; the registry-sweep
tests for the new surfaces.

**Navigation & terminology:** one **Lobby Display** parent grouping *Devices,
Templates, Layouts, Modules,* and the *Conditions/Modules reference* — rather
than separate top-level menu items.

**Data strategy:** clean schema, no production migration. Staging has applied the
MVP migrations, so the decision (recorded, resolved at implementation) is either
a forward "drop old display tables + create new" migration or — preferred, since
nothing shipped — **consolidate the branch's display migrations into one clean
schema for the eventual upstream PR and reset staging.** The whole branch is
**re-layered onto a clean history** before the single upstream PR (as done for
multi-lodge), so the upstream diff reflects the end-state. *(Implemented in hoppers99/AlpineClubBookingsNZ#86 /
LTV-040: the six branch migrations were consolidated into the single
`20260712130000_add_lobby_display` expand migration and the vestigial
`LodgeDisplayDevice.templateKey` column was removed; staging/dev databases that
applied the superseded migrations are reset with a fresh `migrate deploy`.)*

## Security Considerations

- **No admin-authored JavaScript.** Modules are shipped, reviewed code; the
  display's nonce-based CSP (per-request nonce; LTV-014) means only
  server-controlled scripts run. Admin HTML/CSS is authored, but script is not —
  this is the single most important boundary and the reason modules stay code.
- **Admin HTML/CSS = CMS trust model.** Reuse the website's sanitiser (strips
  `<script>`/event handlers). Authoring is **full-admin only**. Residual risks to
  hold: CSS `url()` exfiltration (tighten the display CSP's `img-src`/`font-src`
  for authored CSS) *(addressed in LTV-029: `sanitiseDisplayCss` removes any
  non-relative/non-`data:` `url()` from authored CSS, and `scopeDisplayCss`
  confines it to `.display-authored-root`; a CSP `img-src`/`font-src` tightening
  remains available as defence-in-depth)* and stored-content lateral risk between
  admins — mitigated by the **sandboxed-iframe preview**, so one admin's template
  cannot execute against another admin's authenticated session *(implemented in
  LTV-036: an `sandbox="allow-scripts"` iframe at an opaque origin, authorised by
  a short-lived signed preview grant rather than the admin session — the grant
  authorises only the state route's preview path, stamps no `lastSeenAt`, and is
  domain-separated from the pairing blob)*.
- **Unattended surface.** A lobby wall has nobody watching, so unlike a CMS page
  a broken template is not noticed. Mandatory **preview-before-save**,
  server-side **validation**, and a runtime **safe-fallback render** (a throwing
  template drops to a known-good minimal board) are required, not optional.
  *(Fallback board + server-side save-validation contract landed in LTV-030: a
  page-level error boundary drops any whole-screen throw to the `everyday-board`
  built-in, the state route flags a broken binding (`layoutRenderError`) and logs
  it, and `authoring-validation.ts` is the shared save contract — structural
  invalidity refuses the save, sanitiser-blocked content warns. Preview-before-
  save **enforcement** lives in the authoring UIs, hoppers99/AlpineClubBookingsNZ#78/#79. Hardened in issue
  hoppers99/AlpineClubBookingsNZ#176: **every** render branch is now wrapped, not just the authored one — the
  legacy `ActiveScreen` and the already-degraded `FallbackBoard` branches drop to
  a minimal, zero-data shell if they throw, and a route-segment `error.tsx` is the
  framework-level last resort for a throw that escapes the React tree entirely, so
  a throwing module/board can never blank the wall.)*
- **Token scope.** Authored content resolves only the display's own token set,
  never the full site token catalogue — a wall must not surface data beyond the
  privacy-reduced payload the serialiser already guards. *(Value resolution runs
  AFTER the sanitiser, so issue hoppers99/AlpineClubBookingsNZ#176 adds a URL-scheme guard, hardened against
  split-token composition in issue hoppers99/AlpineClubBookingsNZ#186. Enforcement is **two-phase**, both
  phases scoped to token-bearing `href`/`src` attributes: (1) a token-level fast
  path scheme-validates a resolved value that OPENS an authored `href`/`src` as
  it is injected; (2) a composition-closing pass then re-validates the COMPLETE
  resolved value of every token-bearing `href`/`src` attribute after resolution,
  catching a scheme reconstituted across adjacent tokens (`href="{{a}}{{b}}"`)
  that phase 1's opener-only check would miss. In both phases http/https/mailto/
  tel and relative/anchor pass and anything else (javascript:, data:, protocol-
  relative) collapses to an inert `#` — so a config value can never smuggle a
  live scheme past the gate, whether it carries the scheme whole or splices it
  together across tokens. Only token-bearing attributes are checked; literal
  authored URLs keep the sanitiser's verdict (preserving the display's allowed
  literal `data:` <img> srcs, issue hoppers99/AlpineClubBookingsNZ#161), and CMS/page-content behaviour is
  untouched.)*
- **Privacy unchanged.** All name reduction / minors / no-sensitive-field rules
  remain solely in `buildDisplayState`; the authoring layer only arranges what
  that serialiser already permits and can never widen it.
