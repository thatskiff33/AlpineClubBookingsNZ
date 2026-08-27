"use client";

// Fixtures for `.semgrep/rules/acb-client-server-boundary.yml`. Lines marked
// `ruleid:` MUST be reported and lines marked `ok:` MUST NOT be — the test fails
// either way round, so this file is what stops the rule quietly becoming a
// no-op or quietly becoming noise.
//
// The `Static analysis gate` job runs these on every pull request. To run them
// yourself (the same pinned image CI uses):
//
//   docker run --rm -v "$PWD:/src:ro" -w /src semgrep/semgrep:1.161.0 \
//     semgrep --test --config .semgrep/rules .semgrep/tests --metrics=off
//
// This directory is excluded from the CI scan (see the rule's `paths.exclude`
// and the `--exclude` flags on the `Static analysis gate` step), because every
// violation below is deliberate.

// ruleid: acb-client-server-boundary
import { prisma } from "@/lib/prisma";
// ruleid: acb-client-server-boundary
import { prisma as siblingPrisma } from "./prisma";
// ruleid: acb-client-server-boundary
import { auth } from "@/lib/auth";
// ruleid: acb-client-server-boundary
import "server-only";
// ruleid: acb-client-server-boundary
import { cookies } from "next/headers";
// ruleid: acb-client-server-boundary
import * as fs from "node:fs";
// ruleid: acb-client-server-boundary
import { readFile } from "fs/promises";
// ruleid: acb-client-server-boundary
import { spawn } from "child_process";

// The built-in that matters most in a repository doing XERO_ENCRYPTION_KEY and
// webhook-HMAC work, and which the first draft of the list left out entirely.
// ruleid: acb-client-server-boundary
import { createHmac } from "node:crypto";
// ruleid: acb-client-server-boundary
import { hostname } from "os";
// ruleid: acb-client-server-boundary
import { request } from "node:https";
// ruleid: acb-client-server-boundary
import { Readable } from "stream";

// The other server-only modules in `@/lib`. `@/lib/audit` pulls in Prisma
// transitively, so one hop of laundering used to hide the database client from
// a rule that only knew two module names.
// ruleid: acb-client-server-boundary
import { recordAudit } from "@/lib/audit";
// ruleid: acb-client-server-boundary
import { getXeroClient } from "@/lib/xero";

// The club-timezone environment seed (#2989). It reads `process.env.TZ` and is
// deliberately NOT marked `server-only`, because two of its callers are `tsx`
// entrypoints a `server-only` import would abort — so this rule and the census
// test are the only things keeping it off the browser graph. Next inlines
// `NEXT_PUBLIC_*` into the bundle, so a client component importing it would
// answer from the BUILD-TIME `NEXT_PUBLIC_TZ` rather than from the running
// server: two authorities for one club's civil time (INV-CONFIG-002).
// ruleid: acb-client-server-boundary
import { classifyEnvironmentClubTimeZoneSeed } from "@/lib/club-time-zone-env";

// The environment-role declaration and its resolver (#3034, epic #2986). Neither
// is `server-only` — `setup-readiness-db.ts` reaches the resolver from the `tsx`
// `npm run setup` entrypoint — and the declaration module reads
// `process.env.APP_ENVIRONMENT_ROLE`, which is deliberately NOT `NEXT_PUBLIC_*`
// and therefore inlines as `undefined` in a browser. A client import would read
// "nothing has declared this installation" while the server reads `production`,
// and what is keyed on that answer is whether the club's real members get
// emailed (INV-CONFIG-003). Both spellings are fixtures because the `$` anchor
// means the shorter alternative cannot match the longer module name.
// ruleid: acb-client-server-boundary
import { readEnvironmentRoleDeclaration } from "@/lib/environment-role-declaration";
// ruleid: acb-client-server-boundary
import { getEnvironmentRole } from "@/lib/environment-role";

// RE-EXPORTS. `export … from …` evaluates the module and puts it in the bundle
// exactly as an import does, while reading like harmless barrel plumbing. All
// three of these walked straight through the first version of the rule.
// ruleid: acb-client-server-boundary
export { prisma as reExportedPrisma } from "@/lib/prisma";
// ruleid: acb-client-server-boundary
export * from "@/lib/auth";
// ruleid: acb-client-server-boundary
export { readFileSync } from "node:fs";

// A type-only import is erased before the bundle exists, so it cannot leak
// anything and must not be reported. This is the shape the one real occurrence
// in `src/` uses today.
// ok: acb-client-server-boundary
import type { PrismaClient } from "@/lib/prisma";
// ok: acb-client-server-boundary
import type { Session } from "@/lib/auth";
// TypeScript accepts `type` with no space before the brace, and the first
// draft's `(?!type\s)` lookahead reported this as a violation.
// ok: acb-client-server-boundary
import type{ Adapter } from "@/lib/auth";
// ok: acb-client-server-boundary
export type { AuditEvent } from "@/lib/audit";

// Ordinary client-side imports.
// ok: acb-client-server-boundary
import { useState } from "react";
// The temporal kernel. Deliberately isomorphic — no `server-only`, no Prisma, no
// `process.env` zone read — because 112 client files reach it, so reporting it
// would be a false positive. It is also a strict PREFIX of `club-time-zone-env`
// two entries below, which the anchored alternation has to tell apart.
// ok: acb-client-server-boundary
import { formatClubDate, requireCalendarDate } from "@/lib/club-time";
// ok: acb-client-server-boundary
import { Button } from "@/components/ui/button";
// A module whose NAME merely contains one of the banned words is not the banned
// module — the pattern is anchored, so this must not be reported.
// ok: acb-client-server-boundary
import { describePrismaError } from "@/lib/prisma-error-shape";
// ok: acb-client-server-boundary
import { useAuthState } from "@/lib/auth-client-state";
// Not a Node built-in, whatever the name suggests.
// ok: acb-client-server-boundary
import { pathToRegexp } from "path-to-regexp";
// ok: acb-client-server-boundary
import { cryptoRandomId } from "@/lib/crypto-random-id";
// The pure half of the club-timezone pair: validation and the selector's zone
// list, no `process.env` read anywhere in it. The admin panel imports it, so
// reporting it would be a false positive — and the two names differ only by a
// suffix, which is exactly the pair an anchored alternation has to tell apart.
// ok: acb-client-server-boundary
import { listSelectableClubTimeZones } from "@/lib/club-time-zone";

export function Fixture() {
  const [n] = useState(0);
  return (
    <Button>
      {n} {String(prisma)} {String(siblingPrisma)} {String(auth)} {String(cookies)}
      {String(fs)} {String(readFile)} {String(spawn)} {formatClubDate(requireCalendarDate("2026-04-16"))}
      {String(describePrismaError)} {String(useAuthState)} {String(createHmac)}
      {String(hostname)} {String(request)} {String(Readable)} {String(recordAudit)}
      {String(getXeroClient)} {String(pathToRegexp)} {String(cryptoRandomId)}
      {String(classifyEnvironmentClubTimeZoneSeed)}
      {String(listSelectableClubTimeZones)}
      {String({} as PrismaClient)} {String({} as Session)} {String({} as Adapter)}
    </Button>
  );
}

// DYNAMIC forms. A lazily-fetched chunk is still shipped to the browser and
// still readable there, so `await import()` and `require()` are the same defect
// as a static import — and neither is a statement the static regex can see.
export async function dynamicViolations() {
  // ruleid: acb-client-server-boundary
  const { prisma: lazyPrisma } = await import("@/lib/prisma");
  // ruleid: acb-client-server-boundary
  const lazyAuth = require("@/lib/auth");
  // ruleid: acb-client-server-boundary
  const lazyFs = await import("node:fs");
  return { lazyPrisma, lazyAuth, lazyFs };
}

export async function dynamicPermitted() {
  // ok: acb-client-server-boundary
  const chart = await import("@/components/ui/chart");
  // ok: acb-client-server-boundary
  const dates = await import("@/lib/club-time");
  return { chart, dates };
}
