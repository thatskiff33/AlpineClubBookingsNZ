# Lobby display: config-transfer content workflow (hoppers99/AlpineClubBookingsNZ#113)

How to move lobby-display content (Layouts, Templates, per-lodge display config)
between environments as config-transfer bundles, and when to promote it to code
seeds.

## Principle: bundles first, seeds later

Iterate display content as **config-transfer bundles** imported through
**Admin → Export & Import Setup**, not by re-seeding on every deploy. Promote to
built-in code seeds (`src/lib/lodge-display/built-in-seeds.ts`) only once a
design has proven out and should ship to every install.

## What travels

Display entities live in the **`lodge-config`** category (no separate "display"
category):

- `display-layout` → `display/layouts.json` (key-strong; club-wide)
- `display-template` → `display/templates.json` (binds its layout by **key**,
  resolved to `layoutId` at apply; layouts apply before templates)
- per-lodge display fields on the lodge descriptor (`lodge.json`):
  `displayConfig`, `displayNameGranularity`, `displayNotice`

Every imported Layout/Template is validated by the same save contract the
authoring routes use, so a bundle can never install a structurally broken
display.

## Importing on a target (e.g. staging)

1. **Deploy first if the bundle uses new modules.** Modules are *code*; a
   template referencing a module the running build doesn't know fails import
   with "unknown module". Roll the app image, then import.
2. Admin → Export & Import Setup → upload the bundle → **dry-run**.
3. Select the **`lodge-config`** category and, within it, the
   `display-layout` / `display-template` entities (and the lodge descriptor if
   the bundle carries per-lodge display config). Non-unchanged rows are
   highlighted and sorted first in the plan.
4. Apply. Import never deletes — it only creates/updates.

## Generating a bundle (agent-side)

- A minimal, reviewable bundle carries only what changed: the display
  `layouts.json`/`templates.json` plus the two lodge descriptors' display
  fields — not the full lodge (rooms/beds/seasons) noise. Recompute each touched
  file's `sha256` and the manifest `rowCount`; keep `doorCodesIncluded` in the
  manifest. Verify with the repo's `readBundle` (0 integrity warnings) before
  handing it over.
- Built-ins are code-managed scaffolding (ADR-003 / hoppers99/AlpineClubBookingsNZ#111): they refresh from
  code on re-seed, so promoting a proven bundle design to `built-in-seeds.ts`
  propagates it to installs on the next seed.
