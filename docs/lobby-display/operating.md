# Lobby TV Display — Operating and Extending

Practical guides that sit alongside the [design specification](design.md): a
runbook for the admin who sets up a screen, and a developer guide for adding a
module or a condition. Terminology (Layout / Template / Module / Condition) is
defined in [design.md §6](design.md#6-layout--template--module-model).

---

## For operators — set up a screen

The feature is **off by default**. An organisation admin must first enable the
**Lobby Display** module for the club; until then no display routes, admin UI, or
tokens exist.

The whole admin surface lives under the **Lobby Display** entry in the
collapsible **Lodge Operations** sidebar section (`/admin/display`), a hub of
cards, each named for the page it opens: **Display Devices**, **Display
Builder**, **Display Layouts**, **Display Templates**, and **Display
Reference**. Per-lodge display settings live on the lodge configuration hub
(**Admin → Lodges → [lodge]**), not under Lobby Display.

### 1. Pair the device

1. In **Lobby Display → Devices** (`/admin/display/devices`), create a device
   record: give it a name (e.g. "Lobby TV") and it is bound to a lodge. The page
   shows the concrete display URL to open on the screen.
2. On the TV/browser (or Raspberry Pi), open `/display`. Unpaired, it shows a
   short **pairing code**. The code expires after 15 minutes; a fresh one appears
   automatically.
3. Back in the admin Devices page, enter/confirm that code against the device
   record. On its next poll the screen claims a long-lived, **hashed**,
   revocable display token (stored as an httpOnly cookie) and reloads into
   display mode. It survives reboots and network blips; re-pairing is only needed
   after revocation or expiry.

The state poll doubles as a heartbeat, so the device's **last seen** updates on
its normal refresh cadence. You can **revoke** a device at any time; it returns
to the pairing screen within one refresh interval.

### 2. Build a board (visual builder)

Most boards are easiest to build with the **Display Builder**, the visual
builder (`/admin/display/builder`) — no HTML required (ADR-004):

1. Pick a **shape**: columns, rows, or main + side-rail (1–3 zones).
2. **Drop a module** into each zone — drag it from the Modules palette, or use a
   zone's **Add** menu (fully keyboard-operable; the arrow buttons reorder zones).
3. Open a zone's **Settings** to choose whether it is always shown, shown only
   when a condition holds, or rotates between slots, and to set the module's
   options (e.g. how many nights an arrivals board shows). Options come straight
   from the module, so you can only pick values it accepts.
4. Click **Live preview** to see the board rendered against a chosen lodge in a
   safe sandbox before you save. If anything is wrong, the preview shows the same
   errors a save would.
5. **Create board** — the builder writes a valid Layout + Template for you; bind
   it to a device on the Display Devices page like any other Template.

For full manual control (custom HTML/CSS), use **Advanced mode** — the
**Display Layouts** and **Display Templates** pages (`/admin/display/layouts` +
`/admin/display/templates`). The two surfaces edit the
same stored fields. A board that was hand-edited in Advanced mode (or a built-in
board with its own styling) can't be re-opened in the builder — it stays in
Advanced mode, with an option to rebuild it from a fresh skeleton if you prefer.

### 3. Assign a Template

Each device shows the **club-default board** until you bind it to a Template.

- Pick a Template from the device's template selector (**Display Devices** page). The
  three built-ins — **Everyday board**, **Whole lodge**, **Singles house** —
  appear as ordinary Templates, alongside any you have authored.
- Choosing "club default" clears the binding (`templateId: null`).
- To try a Template before it reaches a wall, use **Preview**: each device offers
  a preview (opening `/display?previewDevice=<id>`), and each Template offers a
  sandboxed preview against a chosen lodge. Previews render through the same
  privacy-reduced data, never stamp "last seen", and can simulate a date via the
  header date line.

Templates render dynamically against whichever lodge the device is bound to, so
one Template serves every lodge — lodge-specific values come from
`{{config:…}}` tokens (below), never from hard-coded content.

### 4. Set the per-lodge display config

On **Admin → Lodges → [lodge]**, the **Lobby Display settings** card (below the
Capacity card, shown only when the module is enabled) holds the three per-lodge
controls. It edits **the lodge you are viewing**:

- **Guest name display (granularity).** Full names / first name + surname
  initial / first names only / counts only, or "club default". This is enforced
  in the display data feed itself — no Template can reveal more than the chosen
  level, and bookings with children always collapse to a family label.
- **Committee notice.** A free-text notice shown wherever a Template places the
  notice module; `{{config:key}}` placeholders resolve inside it. Leave empty to
  hide it (the notice areas in the built-ins are gated on `content:notice`).
- **Config values** — the `{{config:key}}` glob. Add key/value pairs (keys are
  lower-case slugs, e.g. `wifi-code`); Templates reference them as
  `{{config:wifi-code}}`. The built-in footer reads `wifi-name`, `wifi-code`,
  `contact-email`, and `footer-note`; any other key is yours to use in a
  Template. Bad keys/values are rejected (400) by the shared config route.
- **Phone toggle** — "Show guest phone numbers on the lobby display". This is the
  lodge side of a **two-sided consent gate**: a phone appears only when the lodge
  enables this **and** the member has opted in, and only for an adult on a row
  that already shows individual names. Both flags default off. See
  [`phone-visibility.md`](phone-visibility.md).

> **Single-lodge clubs:** the lodge configuration hub (`/admin/lodges/[id]`) is
> unconditional — it is gated only on the `lobbyDisplay` module, not on
> multi-lodge — so `LodgeDisplaySettingsCard` is reachable there for
> single-lodge installs too. The values are per-lodge by construction and a
> single-lodge club is its own default lodge.

> **Privacy model, plainly stated:** minors are never individually named on
> any board, at any granularity level — that is a hard rule with no override.
> Group-label collapse — a family label for a booking containing minors, the
> organisation's name for a school/club organiser, or the booking's own label
> for a whole-lodge blockout — applies consistently across every board,
> including the **chores** board: an adult chore assignee in one of these
> bookings is never named more precisely than that booking's row already is
> elsewhere on the wall. This is a **presentation default that protects
> group privacy day to day, not a certified anonymisation boundary** — treat
> it as good practice, not as a compliance guarantee. The **hut-leader
> kiosk** is the deliberate operational exception: it shows full names,
> because staff checking guests in and out need them.

---

## For developers — extending

The Module library and the condition vocabulary are **closed registries**: you
grow them by shipping code, not by admins writing expressions. Both are wired so
that adding an entry is a small, well-bounded change — but touch **every**
touch-point or a load-time guard / CI test will fail.

### Add a module

A module is a React component that is a **pure function of the `DisplayState`
payload** (it must never query anything). Touch-points, all under
`src/`:

1. **Component** — add `components/lodge-display/modules/<your-module>.tsx`,
   exporting a component of `DisplayModuleProps` (`{ state, options? }`). Read
   only `DisplayState` fields; render nothing rather than throwing on missing
   data.
2. **Name registry** — add the module's name to `DISPLAY_MODULE_NAMES` in
   `lib/lodge-display/template-registry.ts` (the closed set the validators
   accept). This is the single source of truth for valid module names.
3. **Metadata** — add a `DisplayModuleMetadata` entry in
   `lib/lodge-display/module-registry.ts`: `label`, `description` (admin-facing —
   it appears in the Reference screen and seeds authoring dropdowns),
   `dependencies` (club-module flags from `DISPLAY_RELEVANT_MODULE_KEYS`),
   `dependencyMode` (`degrades` or `hides`), the stable `cssHooks` class names,
   any `contributes` conditions, and `embedToken`. A load-time guard throws if a
   name in `DISPLAY_MODULE_NAMES` has no metadata entry, so this cannot be
   skipped.
4. **Component map** — register the component in `DISPLAY_MODULE_COMPONENTS` in
   `components/lodge-display/modules/index.tsx`, wrapped in `withModuleGuard(name,
   …)` (the guard enforces `hides` at the render boundary). Page furniture
   (`lodge-header` / `info-footer`) is instead wired into `PAGE_MODULE_COMPONENTS`
   in `app/display/display-screen.tsx`.
5. **CSS** — add styles in `app/display/display.css`, targeting the class hooks
   you declared in step 3. A CSS-hook stability test fails CI if a declared hook
   is renamed without updating the metadata, so the class-name contract stays
   honest.

The Reference screen, the authoring dropdowns, and the render-boundary guard all
read from the registries above, so a correctly-registered module surfaces
everywhere with no further wiring.

### Add a condition or capability

Conditions gate any area and drive rotator eligibility. They live in
`lib/lodge-display/conditions.ts`, each a **pure function of `DisplayState`**.

- **A core condition** (an `occupancy:*` or `content:*` state) — add a
  `DisplayConditionDefinition` to `CORE_CONDITIONS` with a `name`
  (`namespace:name`), `family`, `description` (feeds the Reference screen), and
  `evaluate(state)`. Names are validated by `isDisplayConditionName`, so the new
  name is immediately selectable in the authoring dropdowns and rejected nowhere.
- **A capability (`<module>:enabled`) condition** — add the module's flag to
  `DISPLAY_RELEVANT_MODULE_KEYS` (mapping the camelCase module key to a
  namespace slug, e.g. `bedAllocation → "bed-allocation"`). This single line
  does two things: it **generates** the `<slug>:enabled` condition (inheriting
  the module's label from `MODULE_DEFINITIONS`), and it **bounds which module
  flags reach the public payload** — `buildDisplayState` copies only these onto
  `DisplayState.capabilities`, so the whole club flag map never ships to a wall.
- **A module data condition** (like `chores:today`) — add it to
  `MODULE_DATA_CONDITIONS`; its `evaluate` may read `state.capabilities` and
  payload data together.

Because the evaluator only ever sees `DisplayState`, a condition can never reach
past the privacy serialiser — it decides *whether* to show an area, never *what*
it may show.
