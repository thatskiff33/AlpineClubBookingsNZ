#!/usr/bin/env npx tsx
/**
 * README artwork composer (issue #2076).
 *
 * Generates the repository front-page artwork into `docs/images/readme/`:
 *
 *   hero-banner.png   1280x320   README hero image
 *   og-image.png      1280x640   GitHub social-preview image (uploaded
 *                                manually in repo Settings; no API exists)
 *
 * The scene is a deterministic layered-SVG alpine ridgeline rasterised with
 * sharp — the same flat-mountain motif as the fork-safe placeholders in
 * `public/branding/*.example.png`, so forks can re-theme or re-run it freely.
 * Nothing is hand-cropped; edit this script and re-run to change the art
 * (`docs/STYLE_GUIDE.md` → "Screenshot conventions").
 *
 *   npm run docs:readme-art
 *
 * Text uses a generic sans-serif stack, so exact glyph rendering may differ
 * slightly across machines; the composition itself is fixed.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const OUT_DIR = path.join(process.cwd(), "docs", "images", "readme");

/** Restrained Alpine palette (docs/STYLE_GUIDE.md): slate blues + snow + one warm accent. */
const C = {
  skyTop: "#0f172a",
  skyMid: "#1e3a5f",
  glow: "#f4c98a",
  ridgeBack: "#64748b",
  ridgeMid: "#475569",
  ridgeFront: "#1e293b",
  snow: "#f8fafc",
  title: "#f8fafc",
  tagline: "#cbd5e1",
  chipText: "#e2e8f0",
  chipFill: "rgba(148,163,184,0.18)",
  chipStroke: "rgba(203,213,225,0.35)",
};

/** Deterministic star field: fixed pseudo-random constants, no Math.random(). */
function stars(width: number, height: number, count: number): string {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const x = ((i * 379 + 83) % width) + ((i * 7) % 13);
    const y = ((i * 211 + 47) % Math.floor(height * 0.45));
    const r = 0.8 + ((i * 31) % 10) / 12;
    const o = 0.35 + ((i * 17) % 10) / 22;
    out.push(`<circle cx="${x}" cy="${y}" r="${r.toFixed(2)}" fill="#e2e8f0" opacity="${o.toFixed(2)}"/>`);
  }
  return out.join("");
}

/** A jagged ridgeline polygon across the full width at the given base/peak heights. */
function ridge(width: number, base: number, peaks: Array<[number, number]>, fill: string): string {
  const pts = [`0,${base}`];
  for (const [x, y] of peaks) pts.push(`${Math.round(x * width)},${y}`);
  pts.push(`${width},${base}`);
  return `<polygon points="${pts.join(" ")}" fill="${fill}"/>`;
}

/**
 * Snow cap hugging a peak: the cap's lower corners sit a fraction `t` down the
 * two real polygon edges adjacent to the apex, so it always matches the slope.
 */
function snowCap(
  apex: [number, number],
  left: [number, number],
  right: [number, number],
  t: number,
): string {
  const [ax, ay] = apex;
  const p1: [number, number] = [ax + (left[0] - ax) * t, ay + (left[1] - ay) * t];
  const p2: [number, number] = [ax + (right[0] - ax) * t, ay + (right[1] - ay) * t];
  return `<polygon points="${p1[0].toFixed(0)},${p1[1].toFixed(0)} ${ax},${ay} ${p2[0].toFixed(0)},${p2[1].toFixed(0)}" fill="${C.snow}"/>`;
}

type Variant = "hero" | "og";

function scene(width: number, height: number, variant: Variant): string {
  const horizon = Math.round(height * (variant === "hero" ? 0.9 : 0.84));
  const titleSize = variant === "hero" ? 58 : 76;
  const tagSize = variant === "hero" ? 21 : 26;
  const titleY = variant === "hero" ? Math.round(height * 0.42) : Math.round(height * 0.33);
  const tagY = titleY + (variant === "hero" ? 40 : 56);

  // Front-ridge peak apexes (fractional x, absolute y) — snow-capped.
  const frontPeaks: Array<[number, number]> =
    variant === "hero"
      ? [
          [0.06, horizon - 80], [0.16, horizon - 38], [0.27, horizon - 95],
          [0.4, horizon - 48], [0.55, horizon - 100], [0.68, horizon - 52],
          [0.8, horizon - 88], [0.92, horizon - 40],
        ]
      : [
          [0.07, horizon - 130], [0.19, horizon - 60], [0.32, horizon - 150],
          [0.46, horizon - 80], [0.6, horizon - 160], [0.73, horizon - 85],
          [0.85, horizon - 140], [0.95, horizon - 64],
        ];
  const midPeaks: Array<[number, number]> = frontPeaks.map(([x, y], i) => [
    Math.min(0.99, x + 0.05),
    horizon - Math.round((horizon - y) * 0.72) - (i % 2 ? 26 : 44),
  ]);
  const backPeaks: Array<[number, number]> = frontPeaks.map(([x, y], i) => [
    Math.max(0.01, x - 0.045),
    horizon - Math.round((horizon - y) * 0.5) - (i % 2 ? 58 : 40),
  ]);

  // Absolute-coordinate front ridge with the polygon's base corners as end
  // neighbours, so every cap interpolates along real edges.
  const frontAbs: Array<[number, number]> = [
    [0, height],
    ...frontPeaks.map(([x, y]): [number, number] => [Math.round(x * width), y]),
    [width, height],
  ];
  const capThreshold = variant === "hero" ? 70 : 110;
  const caps = frontAbs
    .slice(1, -1)
    .map((apex, i) => {
      if (horizon - apex[1] <= capThreshold) return "";
      const left = frontAbs[i];
      const right = frontAbs[i + 2];
      if (!left || !right) {
        throw new Error(`front ridge apex ${i} has no neighbour on both sides`);
      }
      return snowCap(apex, left, right, 0.28);
    })
    .join("");

  const chips =
    variant === "og"
      ? (() => {
          const labels = ["MIT open source", "Next.js + PostgreSQL", "Stripe + Xero", "Runs a real club today"];
          const chipH = 40;
          const y = tagY + 52;
          const sized = labels.map((label) => ({ label, w: label.length * 10.4 + 44 }));
          const total = sized.reduce((a, chip) => a + chip.w, 0) + (labels.length - 1) * 16;
          let x = (width - total) / 2;
          return sized
            .map(({ label, w }) => {
              const el = `<rect x="${x.toFixed(0)}" y="${y}" width="${w.toFixed(0)}" height="${chipH}" rx="${chipH / 2}" fill="${C.chipFill}" stroke="${C.chipStroke}"/>` +
                `<text x="${(x + w / 2).toFixed(0)}" y="${y + 26}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="19" fill="${C.chipText}">${label}</text>`;
              x += w + 16;
              return el;
            })
            .join("");
        })()
      : "";

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${C.skyTop}"/>
      <stop offset="0.62" stop-color="${C.skyMid}"/>
      <stop offset="1" stop-color="${C.glow}"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#sky)"/>
  ${stars(width, height, variant === "hero" ? 42 : 70)}
  ${ridge(width, height, backPeaks, C.ridgeBack)}
  ${ridge(width, height, midPeaks, C.ridgeMid)}
  ${ridge(width, height, frontPeaks, C.ridgeFront)}
  ${caps}
  <text x="${width / 2}" y="${titleY}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${titleSize}" font-weight="bold" fill="${C.title}">AlpineClubBookingsNZ</text>
  <text x="${width / 2}" y="${tagY}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${tagSize}" fill="${C.tagline}">Open-source booking, membership, payments, and lodge operations for alpine clubs</text>
  ${chips}
</svg>`;
}

async function render(name: string, width: number, height: number, variant: Variant): Promise<void> {
  const outPath = path.join(OUT_DIR, name);
  await sharp(Buffer.from(scene(width, height, variant)), { density: 96 })
    .png({ compressionLevel: 9 })
    .toFile(outPath);
  const kb = Math.round(fs.statSync(outPath).size / 1024);
  console.log(`wrote ${path.relative(process.cwd(), outPath)} (${width}x${height}, ${kb} KB)`);
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await render("hero-banner.png", 1280, 320, "hero");
  await render("og-image.png", 1280, 640, "og");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
