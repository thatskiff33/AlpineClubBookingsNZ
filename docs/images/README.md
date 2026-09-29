# Documentation images

All documentation screenshots live here, grouped by area:

- `admin/` — admin/operator UI captures (`admin-<page>.png`).
- `public/` — public-facing captures (`public-<page>.png`).
- `readme/` — the root README's front-page assets: `hero-banner.png` and
  `og-image.png` (generated art, `pnpm run docs:readme-art`) and
  `demo-booking.gif` (booking-flow walkthrough, `pnpm run docs:demo-gif`).
  `og-image.png` is also the image to upload as the GitHub social preview
  (repo Settings; there is no API for it).

These are produced by the automated capture harness, never hand-cropped ad hoc,
so they stay consistent and re-creatable:

```bash
pnpm run test:e2e:prepare        # boot + seed the staging stack (docs/E2E_PLAYWRIGHT.md)
pnpm run docs:screenshots        # capture the named set into this tree
pnpm run docs:screenshots --list   # dry run: print the manifest, no browser
```

Filenames are stable and defined in the harness manifest
(`e2e/tools/capture-screenshots.ts`), so a refresh overwrites in place — a
screenshot update is a diff, not a rename. Viewport is a fixed 1280×800.

See [`../STYLE_GUIDE.md`](../STYLE_GUIDE.md) → "Screenshot conventions" for
naming, alt-text, refresh policy, and the privacy rule (only ever capture the
demo/seeded data set — never real member, payment, or accounting data).
