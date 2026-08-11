- **The Whakapapa conditions panel on the weather page now matches the rest of
  the site.** The live Mt Ruapehu report gains an at-a-glance summary row — road
  status, lifts open, snow base, and the last 24 hours of snowfall — above the
  detail, a "Mt Ruapehu" eyebrow and a "Live" indicator in the header, and clear
  section grouping. Every element carries a stable `wcx-*` class so the exact
  look (card lift, accent keyline, heading treatment, table polish) is applied
  and tweaked from **Admin → Setup & Configuration → Site Appearance & Content →
  Raw CSS**, without a deploy. The ready-to-paste house skin and its `wcx-*` hooks
  are documented in the [Mountain Conditions guide](../docs/guides/mountain-conditions.md).
  The underlying report data and its section visibility toggles are unchanged.
