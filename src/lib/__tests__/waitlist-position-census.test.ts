import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isConnectionShapeModule } from "./support/connection-shape-modules";
import { stripComments } from "./support/strip-comments";
import { moduleImports, productionSourceFiles } from "./support/static-import-graph";
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

// #5402 (`INV-CAP-041`): a waitlist position is read from the live queue by
// `src/lib/waitlist-queue.ts`, and nothing stores it. Five places used to count
// "WAITLISTED, same lodge, overlapping, joined earlier" by hand, and one stored
// the result once and never updated it. This census fails if either comes back.

const QUEUE_MODULE = "src/lib/waitlist-queue.ts";

const sources = productionSourceFiles()
  .filter((file) => /\.(ts|tsx)$/.test(file))
  .map((file) => ({
    file,
    code: stripComments(readFileSync(path.join(process.cwd(), file), "utf8")),
  }));

/** Non-test source under `scripts/`, repo-relative. */
function productionScriptFiles(dir = "scripts"): string[] {
  return readdirSync(path.join(process.cwd(), dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      return entry.name === "node_modules" || entry.name === "__tests__" ? [] : productionScriptFiles(rel);
    }
    return /\.(ts|mts|js|mjs)$/.test(entry.name) && !/\.(test|spec)\.|\.d\.m?ts$/.test(entry.name) ? [rel] : [];
  });
}

/**
 * The receivers a `.waitlistPosition` read may name, per file: each is an API
 * or preview payload the position reader filled in, never a booking row.
 */
const POSITION_PAYLOAD_RECEIVERS: Record<string, string[]> = {
  // the admin waitlist API's entries
  "src/app/(admin)/admin/booking-desk/waitlist/page.tsx": ["entry"],
  // the member record preview's waitlist records
  "src/app/(admin)/admin/membership/members/[id]/_components/member-seasonal-membership-card.tsx": ["booking"],
  // the return-to-waitlist response
  "src/components/admin/admin-return-to-waitlist-controls.tsx": ["data"],
  // its own transaction result
  "src/app/api/admin/bookings/[id]/return-to-waitlist/route.ts": ["result"],
};

/**
 * Every `waitlistPosition` used as an object key or shorthand property with a
 * value other than `null` or `true`, as `file :: line`. Each is a payload field,
 * a prop or a type, reviewed. A new one anywhere, even in one of these files,
 * fails until it is reviewed here, which is what catches a non-null write
 * however deeply it is nested inside a `data: { ... }`.
 */
const REVIEWED_POSITION_KEYS: string[] = [
  // The admin board's entry type, filled by the waitlist API.
  "src/app/(admin)/admin/booking-desk/waitlist/page.tsx :: waitlistPosition: number | null;",
  // The member record card's preview type.
  "src/app/(admin)/admin/membership/members/[id]/_components/member-seasonal-membership-card.tsx :: waitlistPosition: number | null;",
  // The pay-door cards' prop: its type, its destructure and its render.
  "src/app/(authenticated)/bookings/[id]/_components/booking-payment-cards.tsx :: Position: #{waitlistPosition}",
  "src/app/(authenticated)/bookings/[id]/_components/booking-payment-cards.tsx :: waitlistPosition,",
  "src/app/(authenticated)/bookings/[id]/_components/booking-payment-cards.tsx :: waitlistPosition: number | null;",
  // Return-to-waitlist: the audit metadata, the transaction result, the response.
  "src/app/api/admin/bookings/[id]/return-to-waitlist/route.ts :: waitlistPosition,",
  "src/app/api/admin/bookings/[id]/return-to-waitlist/route.ts :: waitlistPosition,",
  "src/app/api/admin/bookings/[id]/return-to-waitlist/route.ts :: waitlistPosition: result.displayedWaitlistPosition,",
  // The admin waitlist API's response field.
  "src/app/api/admin/waitlist/route.ts :: waitlistPosition: positions.get(b.id) ?? null,",
  // The member record preview's serialiser: its parameter and its output key.
  "src/lib/seasonal-membership-assignments.ts :: function serializeBookingSummary(booking: BookingPreviewRecord, waitlistPosition: number | null) {",
  "src/lib/seasonal-membership-assignments.ts :: waitlistPosition,",
];

/** `file :: trimmed line` for each key-like use of the name. */
function positionKeyUses(file: string, code: string): string[] {
  return [...code.matchAll(/(?<![.\w$])waitlistPosition\??(?=\s*[:,}])/g)]
    .filter((match) => !/^waitlistPosition\??\s*:\s*(null|true)\b/.test(code.slice(match.index)))
    .map((match) => {
      const start = code.lastIndexOf("\n", match.index) + 1;
      const end = code.indexOf("\n", match.index);
      return `${file} :: ${code.slice(start, end === -1 ? undefined : end).trim()}`;
    });
}

describe("waitlist position census (#5402, INV-CAP-041)", { timeout: CENSUS_TIMEOUT_MS }, () => {
  it("reads the production tree", () => {
    expect(sources.length).toBeGreaterThan(500);
    expect(sources.some(({ file }) => file === QUEUE_MODULE)).toBe(true);
  });

  it("counts the queue ahead of a booking only in waitlist-queue.ts", () => {
    const offenders = sources.flatMap(({ file, code }) => {
      if (file === QUEUE_MODULE) return [];
      return [...code.matchAll(/createdAt\s*:\s*\{\s*lte?\s*:/g)]
        .filter((match) => {
          const window = code.slice(Math.max(0, match.index - 600), match.index + 200);
          return /\bWAITLISTED\b/.test(window);
        })
        .map((match) => `${file}:${code.slice(0, match.index).split("\n").length}`);
    });
    expect(
      offenders,
      "a WAITLISTED query bounded by an earlier createdAt is a hand-rolled position count; use getWaitlistPositions from waitlist-queue.ts",
    ).toEqual([]);
  });

  it("never selects the stored column", () => {
    // A connection shape's `waitlistPosition: true` sends the position the
    // route already read; it is not a select (support/connection-shape-modules).
    const offenders = sources
      .filter(({ file }) => !isConnectionShapeModule(file))
      .filter(({ code }) => /\bwaitlistPosition\s*:\s*true\b/.test(code))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("gives the name no value but null except at the reviewed payload, prop and type keys", () => {
    const uses = sources
      .filter(({ file }) => !isConnectionShapeModule(file))
      .flatMap(({ file, code }) => positionKeyUses(file, code))
      .sort();
    expect(
      uses,
      "a new waitlistPosition key may be a stored write; positions are read with getWaitlistPositions (INV-CAP-041)",
    ).toEqual([...REVIEWED_POSITION_KEYS].sort());
  });

  it("reads a position field only off a named payload the reader filled in", () => {
    // EVERY `.waitlistPosition`, whatever comes before the dot. Its receiver
    // counts only when it is a bare word (`entry.`, `data?.`): an index, a call,
    // a non-null assertion or a property chain (`rows[0].`, `(await …).`,
    // `booking!.`, `a.booking.`) is reported as itself and fails.
    const reads = sources.flatMap(({ file, code }) =>
      [...code.matchAll(/\.\s*waitlistPosition\b/g)].map((match) => {
        const before = code.slice(Math.max(0, match.index - 80), match.index);
        const receiver = /(?<![\w$.\])!?])([A-Za-z_$][\w$]*)\??\s*$/.exec(before)?.[1];
        return `${file} :: ${receiver ?? `<expression> ${before.trim().slice(-30)}`}`;
      }),
    );
    const allowed = Object.entries(POSITION_PAYLOAD_RECEIVERS).flatMap(([file, receivers]) =>
      receivers.map((receiver) => `${file} :: ${receiver}`),
    );
    expect([...new Set(reads)].sort()).toEqual(allowed.sort());
  });

  it("never names the stored column as a string outside prisma/", () => {
    // `booking["waitlistPosition"]`, a raw-SQL `b."waitlistPosition"`, a grant
    // list entry: each is the retired column by name. The schema and migrations
    // under prisma/ are expected to name it and are not scanned.
    const scriptSources = productionScriptFiles().map((file) => ({
      file,
      code: stripComments(readFileSync(path.join(process.cwd(), file), "utf8")),
    }));
    const offenders = [...sources, ...scriptSources]
      .filter(({ code }) => /(["'`])waitlistPosition\1/.test(code))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("keeps waitlist-queue.ts a leaf, so booking-create can import it without a cycle", () => {
    const { code } = sources.find(({ file }) => file === QUEUE_MODULE)!;
    const runtimeImports = moduleImports(QUEUE_MODULE, code)
      .filter((entry) => entry.kind !== "type")
      .map((entry) => entry.specifier)
      .sort();
    expect(runtimeImports).toEqual([
      "@/config/club-settings-defaults",
      // No imports of its own; the one definition of a shared night (INV-SSOT-001).
      "@/lib/booking-night-overlap",
      // No imports of its own; the one ordinal comparator (INV-SSOT-001, #3252).
      "@/lib/ordinal-order",
      "@prisma/client",
    ]);
  });
});
