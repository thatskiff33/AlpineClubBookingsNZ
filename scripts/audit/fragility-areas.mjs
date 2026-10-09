#!/usr/bin/env node
/**
 * Map candidate repeat pairs onto the PROPOSED business areas and count them,
 * per signal, without ranking.
 *
 *   pnpm run audit:fragility:areas
 *
 * Reads `tmp/fragility/{repeats,github}.json` and writes
 * `tmp/fragility/areas.json`. The area list is a proposal for the owner to
 * edit (docs/audits/FRAGILITY_AREAS_PROPOSAL.md); ranking is ALP-7's job.
 *
 * A pair belongs to an area when any of these holds (a pair can be in
 * several areas; one in none is "unmapped"):
 * - either side's conventional `fix(<scope>)` scope matches the area;
 * - issues on both sides carry a matching label (busy labels such as
 *   `payments` or `booking` sit on hundreds of issues, so one side is not enough);
 * - code-history: a file whose lines came back matches the area;
 * - only when none of those maps the pair anywhere: both sides touch a
 *   matching non-test source file, so the same area was fixed twice. It is a
 *   fallback because wide PRs touch many areas; as a peer rule it put the
 *   median pair in three areas.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isBlameIgnoredPath } from "./fragility-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT_DIR = path.join(ROOT, "tmp/fragility");

/** The proposed areas. Edit this list with the owner; the doc mirrors it. */
export const AREAS = [
  {
    id: "xero",
    name: "Xero sync and accounting outbox",
    scopes: /^xero/,
    labels: /^xero$/,
    files: /xero/i,
  },
  {
    id: "payments",
    name: "Payments, refunds and member credit (Stripe, internet banking)",
    scopes: /^(payment|payments|pay|settle|refund|promo|finance|stripe)$/,
    labels: /^(payments|area: finance|P1-money-adjacent)$/,
    files: /stripe|payment|refund|member-credit|internet-banking|finance|promo|credit-note|money/i,
  },
  {
    id: "booking-changes",
    name: "Booking edits and cancellations (dates, party, group cancel/settle)",
    scopes: /^(group-cancel|group-settlement|cancel|cancellation|modify|booking-modify)$/,
    labels: /^$/,
    files: /booking-cancel|modification|booking-modify|guest-removal|edit-booking|group-cancel|group-settlement|cancellation|booking-edit/i,
  },
  {
    id: "booking-create",
    name: "Booking creation, pricing and the member booking screens",
    scopes: /^(booking|bookings|book|booking-ux|pricing)$/,
    labels: /^booking$/,
    files: /booking-create|\(authenticated\)\/book|api\/bookings\/(route|create)|pricing|booking-price|booking-history/i,
  },
  {
    id: "booking-requests",
    name: "Booking requests, policy exceptions and payment chasing (officer queues)",
    scopes: /^(booking-request|booking-requests|exception|school)$/,
    labels: /^$/,
    files: /booking-request|school-booking|booking-polic|policy-exception|additional-payment/i,
  },
  {
    id: "capacity",
    name: "Capacity, bed allocation, waitlist and lodge display",
    scopes: /^(bed-allocation|beds|capacity|waitlist|roster|lodge-display|lodge)$/,
    labels: /^area: lodge-display$/,
    files: /bed-allocation|capacity|waitlist|roster|\(lodge\)|api\/lodge|lodge-display/i,
  },
  {
    id: "email",
    name: "Email and notifications",
    scopes: /^(email|notification|notifications)$/,
    labels: /^email$/,
    files: /email|notification|template/i,
  },
  {
    id: "membership",
    name: "Membership lifecycle (applications, subscriptions, family groups, deletion, merge)",
    scopes: /^(member|members|membership|membership-type|family-group|member-merge|subscription|application)$/,
    labels: /^(membership|lifecycle)$/,
    files: /member-merge|membership|family|application|subscription|member-delet|admin-member/i,
  },
  {
    id: "guests-hosting",
    name: "Member guests and adult-member hosting",
    scopes: /^(hosting|member-guests|guests|guest)$/,
    labels: /^member-guests$/,
    files: /guest|hosting|host-/i,
  },
  {
    id: "admin",
    name: "Admin and booking-officer screens, settings and permissions",
    scopes: /^(admin|admin\/fee|rbac|panel|config-transfer|theme|theming|print)$/,
    labels: /^admin-ux$/,
    files: /\(admin\)|components\/admin|api\/admin|view-only|rbac|permission|config-transfer/i,
  },
  {
    id: "public-site",
    name: "Public website, CMS pages and first-run setup",
    scopes: /^(website|cms|public|setup|public-pages)$/,
    labels: /^$/,
    files: /\(website\)|\(public\)\/(?!login)|setup-gate|cms|website/i,
  },
  {
    id: "security-privacy",
    name: "Auth, security, privacy and the audit log",
    scopes: /^(security|privacy|audit|auth)$/,
    labels: /^(security|auth)$/,
    files: /auth|login|session|token|security|privacy|audit|two-factor|2fa/i,
  },
  {
    id: "concurrency",
    name: "Concurrency and locking",
    scopes: /^concurrency$/,
    labels: /^$/,
    files: /lock/i,
  },
  {
    id: "ops",
    name: "Deploy, CI, migrations, cron and diagnostics",
    scopes: /^(ci|deploy|migration|cron|alpine-server|repo|dep|load|cache|diagnostic)$/,
    labels: /^(operations|infra|release|dependencies)$/,
    files: /^\.github\/|docker|^deploy\/|^prisma\/migrations|cron|diagnostic|instrumentation/i,
  },
  {
    id: "tests",
    name: "Test and E2E infrastructure (flaky or wrong tests)",
    scopes: /^(e2e|test|tests)$/,
    labels: /^$/,
    files: /^e2e\/|__tests__\/(support|helpers)\/|^playwright/i,
  },
];

/** Non-test files a side touched that the area's file rule matches. */
function touches(side, area) {
  return (side.files ?? []).some((file) => !isBlameIgnoredPath(file) && area.files.test(file));
}

/** Labels of every issue named on a side (its linked issues, or the issue itself). */
function sideLabels(side, labelsByNumber) {
  const numbers = [...(side.issues ?? []), ...(side.issue ? [side.issue] : [])];
  return [...new Set(numbers.flatMap((number) => labelsByNumber.get(number) ?? []).concat(side.labels ?? []))];
}

/**
 * The areas a repeat pair belongs to, each with the reason it matched.
 *
 * @returns {Array<{ area: string, via: string }>}
 */
export function areasForPair(entry, labelsByNumber, areas = AREAS) {
  const scopes = [...new Set([...(entry.earlier.scopes ?? []), ...(entry.later.scopes ?? [])])];
  const earlierLabels = sideLabels(entry.earlier, labelsByNumber);
  const laterLabels = sideLabels(entry.later, labelsByNumber);
  const codeFiles = entry.evidence.filter((item) => item.kind === "code-history").flatMap((item) => Object.keys(item.files ?? {}));
  const matches = [];
  for (const area of areas) {
    const scope = scopes.find((value) => area.scopes.test(value));
    const label = earlierLabels.some((value) => area.labels.test(value)) ? laterLabels.find((value) => area.labels.test(value)) : undefined;
    const file = codeFiles.find((value) => area.files.test(value));
    if (scope) matches.push({ area: area.id, via: `scope ${scope}` });
    else if (label) matches.push({ area: area.id, via: `label ${label}` });
    else if (file) matches.push({ area: area.id, via: `file ${file}` });
  }
  if (matches.length > 0) return matches;
  return areas
    .filter((area) => touches(entry.earlier, area) && touches(entry.later, area))
    .map((area) => ({ area: area.id, via: "both sides' files" }));
}

/** Per-area counts by signal, plus coverage. Counts are pairs, not ranks. */
export function countAreas(repeats, labelsByNumber, areas = AREAS) {
  const rows = new Map(areas.map((area) => [area.id, { id: area.id, name: area.name, pairs: 0, sinceAudit: 0, bySignal: {}, examples: [] }]));
  let unmapped = 0;
  for (const entry of repeats) {
    const matches = areasForPair(entry, labelsByNumber, areas);
    if (matches.length === 0) unmapped += 1;
    for (const { area, via } of matches) {
      const row = rows.get(area);
      row.pairs += 1;
      if (entry.sinceAudit) row.sinceAudit += 1;
      for (const signal of entry.signals) row.bySignal[signal] = (row.bySignal[signal] ?? 0) + 1;
      row.examples.push({ earlier: entry.earlier.key, later: entry.later.key, signals: entry.signals, via, earlierUrl: entry.earlier.url, laterUrl: entry.later.url });
    }
  }
  return { total: repeats.length, unmapped, areas: [...rows.values()] };
}

function readJson(name) {
  const file = path.join(OUT_DIR, name);
  if (!existsSync(file)) {
    console.error(`tmp/fragility/${name} is missing. Run audit:fragility:collect and audit:fragility:signals first.`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

function main() {
  const { repeats } = readJson("repeats.json");
  const github = readJson("github.json");
  const labelsByNumber = new Map(github.issues.map((issue) => [issue.number, issue.labels]));
  const result = countAreas(repeats, labelsByNumber);
  writeFileSync(path.join(OUT_DIR, "areas.json"), `${JSON.stringify({ builtAt: new Date().toISOString(), source: github.source ?? "github-api", gaps: github.gaps ?? [], ...result }, null, 1)}\n`);
  const signals = ["refix", "reopened", "mention", "revert", "code-history"];
  console.log(`| Area | Pairs | Since 2026-08-08 | ${signals.join(" | ")} |`);
  console.log(`| --- | --: | --: | ${signals.map(() => "--:").join(" | ")} |`);
  for (const row of result.areas) {
    console.log(`| ${row.name} | ${row.pairs} | ${row.sinceAudit} | ${signals.map((signal) => row.bySignal[signal] ?? 0).join(" | ")} |`);
  }
  console.log(`\n${result.total} pairs; ${result.unmapped} map to no area.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
