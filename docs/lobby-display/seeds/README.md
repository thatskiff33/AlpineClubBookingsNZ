# Lobby display seed bundles

Importable config-transfer bundles for the lobby display. Upload through
**Admin → Export & Import Setup → Import** (select the *Lodge configuration*
category), review the plan, and apply. The v2 Layout/Template library travels in
the `lodge-config` category (LTV-037), so the display setup imports as one unit
alongside a club's lodge configuration.

> **Built-in designs are seeded automatically** (LTV-038, issue #2047). The
> built-ins — the three originals `everyday-board`, `whole-lodge`, `singles-house`
> plus the issue-#2047 pack `room-by-room`, `nights-ahead`, `operations-board`,
> `welcome-kiosk` — are code-defined in
> `src/lib/lodge-display/built-in-seeds.ts` and seeded by `prisma/seed.ts`
> (`ensureBuiltInDisplays`), so a fresh install already has them as ordinary v2
> Layout + Template rows on **Admin → Display Layouts / Templates** — no bundle
> import needed. The bundles below are *additional* starter sets. A re-seed
> **refreshes** each built-in from code (owner decision A, issue hoppers99/AlpineClubBookingsNZ#111): shipped
> design improvements reach existing installs, and an in-place admin edit to a
> `builtin-` row is overwritten — customise by **duplicating** a built-in into a
> new (non-`builtin-`) row.

## `room-occupancy-templates.bundle.zip`

The room-occupancy starter set in the v2 Layout/Template shape (ADR-003 §1),
derived from the design-exploration mockups ([`../mockups/`](../mockups/)). The
bundle carries ONLY the club-wide display library — no lodge rows travel (the
`lodge-config/instructions.csv` file is the engine's always-emitted club-wide
base and contains zero rows), so importing cannot touch any lodge's own
settings.

### `display/layouts.json` — two Layouts

| Key | Name | Shape |
|---|---|---|
| `room-occupancy` | Room occupancy board | Full-width board: a single static `{{area:main}}` area holding the arrivals board. |
| `room-occupancy-rotating` | Room occupancy + notices (rotating) | Full-width board whose `main` area is a rotator (12 s) with two children — the board, and a `content:notice`-gated committee notice that only appears while a notice is set. |

### `display/templates.json` — three Templates

| Key | Name | Layout | Fill |
|---|---|---|---|
| `room-occupancy-3day` | Room occupancy — 3 day | `room-occupancy` | `main` → arrivals-board (3-day window) |
| `room-occupancy-week` | Room occupancy — week view | `room-occupancy` | `main` → arrivals-board (7-day window) |
| `occupancy-rotating` | Occupancy + notices | `room-occupancy-rotating` | `main/board` → arrivals-board (3 day); `main/notice` → notice-board |

Templates bind their Layout by **key** (`layoutKey`), never a database id, so the
bundle is portable. On import, layouts apply before templates, and each
`layoutKey` is resolved to the real layout — a template whose `layoutKey` is in
neither the bundle nor the target database is a plan-blocking error.

After importing, the layouts appear on **Admin → Display Layouts** and the
templates on **Admin → Display Templates**; assign a template to a device on
**Admin → Lobby Display**.

Every Layout and Template is validated on import against the shared save
contract (`validateLayoutForSave` / `validateTemplateForSave`) — the exact same
gate the authoring UIs use — so a bundle can never install a structurally broken
display (ADR-003 §5). The bundle was generated through the real export engine
(`buildConfigExport`), so its manifest and checksums are genuine.

## `display-template-pack.bundle.zip`

The **extras** half of the issue #2047 template pack (`docs/lobby-display/README.md`
→ "Template gallery"). The pack's four broadly-useful boards ship as **built-in
seeds** (every install gets them); the two **situational** boards below travel
here instead, so the built-in set stays focused on the everyday boards. Import
exactly like the bundle above (Admin → Export & Import Setup → Import, *Lodge
configuration* category). New rows only — the keys (`busy-weekend`,
`arrivals-strip`) do not collide with any built-in, so importing adds them
without touching the seeded designs.

### `display/layouts.json` — two Layouts

| Key | Name | Shape |
|---|---|---|
| `busy-weekend` | Busy weekend (rotating) | Full-screen board whose one area is a rotator (10 s) cycling the whole-lodge blockout (only while a whole-lodge booking is in the window), a two-night arrivals board, and a `content:notice`-gated committee notice. |
| `arrivals-strip` | Minimal arrivals strip | A compact two-row board — a single-night arrivals strip above a welcome panel — sized for a small secondary screen. |

### `display/templates.json` — two Templates

| Key | Name | Layout | Modules |
|---|---|---|---|
| `busy-weekend` | Busy weekend (rotating) | `busy-weekend` | occupancy-grid (`variant:board`) / arrivals-board (`days:2`) / notice-board |
| `arrivals-strip` | Minimal arrivals strip | `arrivals-strip` | arrivals-board (`days:1`, `name-style:lead-count`) + welcome |

Both boards are validated end to end in `src/lib/__tests__/lodge-display-pack-bundle.test.ts`
(genuine checksums, save-contract clean) and rendered through the real display
engine in `src/app/display/__tests__/display-pack-templates.test.tsx`.
