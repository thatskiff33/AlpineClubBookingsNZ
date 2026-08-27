// Generates the add-to-calendar icons the booking-confirmed email renders for
// the {{ical}} block (fork issue #41): three 56px PNGs under
// public/branding/calendar/, rasterised from the SVGs authored inline below.
//
//   node scripts/branding/generate-calendar-icons.mjs
//
// Committed alongside its outputs so the assets are reproducible. The
// drawings are ORIGINAL flat calendar tiles that evoke each destination
// nominatively — a download tray for the .ics file, a G-marked tile in
// Google Calendar blue, an O-marked tile in Outlook blue — never copies of
// the trademarked logos. Shapes only, no <text>, so rasterisation does not
// depend on any machine's font configuration.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const OUT_DIR = path.join(process.cwd(), "public", "branding", "calendar");

// A shared 56x56 calendar tile: white rounded card, coloured header band with
// two binder rings, and a per-icon glyph in the body.
function tile(bandColour, glyph) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" viewBox="0 0 56 56">
  <rect x="2" y="4" width="52" height="48" rx="9" fill="#ffffff" stroke="#d3dce2" stroke-width="2"/>
  <path d="M2 13 a9 9 0 0 1 9-9 h34 a9 9 0 0 1 9 9 v8 H2 Z" fill="${bandColour}"/>
  <rect x="14" y="1" width="5" height="10" rx="2.5" fill="#5c6b76"/>
  <rect x="37" y="1" width="5" height="10" rx="2.5" fill="#5c6b76"/>
  ${glyph}
</svg>`;
}

const ICONS = {
  // The .ics download: an arrow dropping into a tray.
  "ics.png": tile(
    "#475569",
    `<path d="M28 26 v12 M22 33 l6 6 6-6" fill="none" stroke="#475569" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
     <path d="M17 44 h22" fill="none" stroke="#475569" stroke-width="4" stroke-linecap="round"/>`,
  ),
  // Google Calendar: a path-drawn G (arc with a bar) in Google blue.
  "google-calendar.png": tile(
    "#4285f4",
    `<path d="M36.5 30 a9.5 9.5 0 1 0 0 7 M36.5 33.5 h-8" fill="none" stroke="#4285f4" stroke-width="4" stroke-linecap="round"/>`,
  ),
  // Outlook.com: a circle O in Outlook blue.
  "outlook.png": tile(
    "#0078d4",
    `<circle cx="28" cy="34" r="9.5" fill="none" stroke="#0078d4" stroke-width="4"/>`,
  ),
};

await mkdir(OUT_DIR, { recursive: true });
for (const [name, svg] of Object.entries(ICONS)) {
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  await writeFile(path.join(OUT_DIR, name), png);
  console.log(`wrote ${name} (${png.length} bytes)`);
}
