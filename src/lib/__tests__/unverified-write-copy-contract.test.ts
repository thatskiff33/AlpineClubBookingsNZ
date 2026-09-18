import { readFileSync, readdirSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import { unverifiedWriteMessage } from "@/lib/unverified-write-copy";

import { stripComments } from "./support/strip-comments";

/**
 * Unverified-write copy — contract (#2668).
 *
 * A browser cannot tell "the request never arrived" from "the request arrived,
 * the server did the work, and the answer was lost". `fetch` rejects for both.
 * So a network-failure branch that tells the person their change "was not
 * saved" / "nothing was recorded" states as fact something it has no way to
 * know, and on a flaky connection it is wrong often enough to send them back to
 * redo a write that already happened.
 *
 * The wording was fixed once before, on one component, and grew back on five
 * others. This test is the thing that stops it growing back again: it re-walks
 * `src/` on every run, finds every branch a network failure can reach, and
 * fails if any of them makes a confident claim about the stored record.
 *
 * It is deliberately a WALK and not a list of the six files fixed in #2668 — a
 * seventh editor written next year by someone who has never read this issue is
 * exactly the case a hand-written list would miss.
 *
 * WHAT IT CATCHES, AND WHAT IT DOES NOT. This is a source scan: it reasons about
 * syntax, not meaning. It is a floor, and the height of the floor is worth
 * stating exactly, because a limit nobody wrote down gets read as a guarantee.
 *
 * It DOES catch a claim written as a literal in a `catch` body or in a falsy
 * guard on a name bound to a `fetch` result, whether the fetch was bound by a
 * declaration (`const r = await fetch(…)`) or assigned to an outer binding
 * (`let r: Response; r = await fetch(…)`), and whether the claim is written
 * inline, wrapped across lines by `+` concatenation, or held in a module-scope
 * constant the branch merely names. That last case is not hypothetical: it is
 * how `roster-editor.tsx` and `notifications-settings.tsx` are written, so a
 * scan that could not follow a constant would have missed two of the surfaces
 * this issue converted and left them protected only by the hand-written list
 * this walk exists to replace.
 *
 * It does NOT catch: a claim rendered from error STATE in JSX rather than
 * written in the branch that set it; a `fetch` behind an imported helper module,
 * since the walk reads one file at a time; a message assembled at run time from
 * pieces; or browser code in a file carrying no `"use client"` marker of its own
 * (`src/lib/admin-member-xero-actions.ts` is one — its copy is honest today, and
 * this walk is not what keeps it that way). Those need the per-surface
 * behavioural tests listed in the "Client honesty" row of
 * `docs/END_TO_END_TEST_MATRIX.md`, which is why every converted surface has
 * one as well as this.
 */

function repoPath(...segments: string[]) {
  return path.resolve(process.cwd(), ...segments);
}

/** Every non-test `.ts`/`.tsx` file under `src/`, as repo-relative POSIX paths. */
function allSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (/\.test\.tsx?$/.test(entry.name)) continue;
      out.push(path.relative(process.cwd(), full).split(path.sep).join("/"));
    }
  };
  walk(repoPath("src"));
  return out.sort();
}

/**
 * Phrases that assert the STORED RECORD did not move.
 *
 * Reporting that the ATTEMPT failed is honest and is deliberately absent here:
 * "Failed to save arrival time", "Could not record this payment", "The photo
 * could not be saved" all describe the request, not the row, and every one of
 * them stays. What is banned is the second clause people reach for — "…so
 * nothing was saved" — which is a claim about the database made by the one
 * party that cannot see it.
 *
 * The separator class tolerates this repo's `"…" +\n  "…"` line-wrapped string
 * concatenation, which a plain line-based grep walks straight past — that is
 * how `restore-built-ins.tsx` kept its claim through the first sweep.
 */
const SEPARATOR = String.raw`[\s"'\`+]*`;
const OUTCOME_VERBS =
  "saved|recorded|changed|applied|sent|created|updated|deleted|removed|cancelled|canceled|submitted|made|stored|added|written|charged|refunded";
const RECORD_UNCHANGED_CLAIMS: Array<{ label: string; pattern: RegExp }> = [
  {
    label: `"nothing was <verb>"`,
    pattern: new RegExp(
      `Nothing${SEPARATOR}(was|has${SEPARATOR}been)${SEPARATOR}(${OUTCOME_VERBS})`,
      "i",
    ),
  },
  {
    label: `"was/were not <verb>"`,
    pattern: new RegExp(
      `(was|were|has|have)${SEPARATOR}not${SEPARATOR}(been${SEPARATOR})?(${OUTCOME_VERBS})`,
      "i",
    ),
  },
  {
    label: `"not saved"`,
    pattern: new RegExp(`not${SEPARATOR}saved`, "i"),
  },
  {
    label: `"no changes were made"`,
    pattern: new RegExp(
      `no${SEPARATOR}changes?${SEPARATOR}(were|was|have${SEPARATOR}been|has${SEPARATOR}been)${SEPARATOR}(made|${OUTCOME_VERBS})`,
      "i",
    ),
  },
];

/**
 * The one place a "nothing changed" claim after a failed `fetch` is TRUE, with
 * the reason it is true. Anything added here has to survive the same question:
 * could the server have done the work and simply failed to tell us?
 *
 * An entry exempts ONE BRANCH, not a file. `display-wizard-steps.tsx` is the
 * reason that distinction is written into the shape of this list: the honest
 * claim there is in the module-settings GET, and the same file holds five write
 * fetches — the module-settings PUT, the lodge-config PUT, the device create,
 * the board bind and the pairing arm. A file-scoped
 * exemption (which is what an earlier draft of this test had) would have
 * permanently excused all of them on the strength of a reason that is only true
 * of the read.
 */
const HONEST_CLAIMS: Array<{
  file: string;
  /**
   * Text inside the ONE branch this exemption covers. Every other branch in the
   * file is still walked.
   */
  branchContains: string;
  reason: string;
  mustContain: string;
}> = [
  {
    file: "src/app/(admin)/admin/display/setup/display-wizard-steps.tsx",
    branchContains: "Could not read the current module settings",
    reason:
      "The failing fetch is the GET that READS the current module settings, " +
      "and the function returns before the PUT is ever built. No write was " +
      "attempted, so 'nothing was changed' is a fact about this client's own " +
      "control flow rather than a guess about the server's. It covers that " +
      "branch alone: the device-create, board-bind and pairing-arm writes in " +
      "the same file are walked like anything else.",
    // Proof the branch really does precede the write rather than follow it.
    mustContain: "the current values must be read first",
  },
];

/**
 * Names bound to the result of a `fetch` in this file. Only a guard on one of
 * these is a network-failure branch — `if (!dirty)` in a discard-confirm is
 * not, and an earlier draft of this test reported exactly that.
 *
 * Both binding shapes count. The declaration is the common one; the assignment
 * to an outer binding is how a component that needs the response after the
 * `try` block has to write it (`roster-editor.tsx` does), and a walk that only
 * knew declarations was blind to exactly those.
 */
function fetchResultNames(source: string): Set<string> {
  const names = new Set<string>();
  const declared =
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?fetch\s*\(/g;
  const assigned = /^[^\S\n]*([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?fetch\s*\(/gm;
  for (const match of source.matchAll(declared)) names.add(match[1]);
  for (const match of source.matchAll(assigned)) names.add(match[1]);
  return names;
}

/**
 * The RIGHT-HAND SIDE of every module-scope `const`/`let` in this file, keyed by
 * name, so a branch that says `setError(UNVERIFIED_COPY)` is judged on what that
 * constant actually says.
 *
 * Bracket depth decides where the declaration ends, so a builder call spread
 * over several lines — `const X = unverifiedWriteMessage(\n  "…",\n  "…",\n)`,
 * this repo's own house style for exactly this copy — is captured whole.
 */
function moduleConstantValues(source: string): Map<string, string> {
  const lines = source.split("\n");
  const values = new Map<string, string>();
  for (let index = 0; index < lines.length; index += 1) {
    const name = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(
      lines[index],
    )?.[1];
    if (name === undefined) continue;
    const collected: string[] = [];
    let depth = 0;
    for (let cursor = index; cursor < lines.length && collected.length < 16; cursor += 1) {
      const line = lines[cursor];
      collected.push(
        cursor === index ? line.slice(line.indexOf("=") + 1) : line,
      );
      for (const character of line) {
        if ("([{".includes(character)) depth += 1;
        else if (")]}".includes(character)) depth -= 1;
      }
      const continues =
        collected.join("").trim() === "" || /[+,=]\s*$/.test(line.trimEnd());
      if (depth <= 0 && !continues) break;
    }
    values.set(name, collected.join("\n"));
  }
  return values;
}

/**
 * Substitute module-scope constants into a branch body, so the claim is read
 * where it is WRITTEN rather than only where it is named. Bounded passes, since
 * one constant may be built from another (and a self-referential one must not
 * spin).
 */
function withConstantsResolved(
  text: string,
  values: Map<string, string>,
): string {
  let resolved = text;
  for (let pass = 0; pass < 3; pass += 1) {
    let changed = false;
    const next = resolved.replace(/\b[A-Za-z_$][\w$]*\b/g, (identifier) => {
      const value = values.get(identifier);
      if (value === undefined) return identifier;
      changed = true;
      return value;
    });
    if (!changed) break;
    resolved = next;
  }
  return resolved;
}

/**
 * The BODY of a branch, from its opening line to the brace that closes it.
 *
 * A fixed-size window overruns the branch and reads the code after it, which is
 * how an earlier draft of this test blamed a `if (!res.ok)` guard for a success
 * toast eleven lines below it. Stop at the first line at or left of the opening
 * indent that closes a block, so a finding is always inside the branch it names.
 */
function branchBody(lines: string[], start: number): string {
  const openIndent = lines[start].search(/\S/);
  const body = [lines[start]];
  for (let index = start + 1; index < lines.length && body.length < 24; index += 1) {
    const line = lines[index];
    const indent = line.search(/\S/);
    if (indent >= 0 && indent <= openIndent && /^\s*[})\]]/.test(line)) break;
    body.push(line);
  }
  return body.join("\n");
}

/**
 * Every branch a network failure can land in: the body of a `catch`, and the
 * falsy guard that follows a `fetch(...).catch(() => null)`. Both are places
 * where the client holds no response and therefore knows nothing.
 *
 * The guard has to be on the BINDING (`if (!response)`) or reached through an
 * optional chain (`if (!response?.ok)`), because those are the shapes whose
 * falsy case includes "there is no response at all". `if (!response.ok)` is a
 * different branch: the client is holding a response, so the SERVER answered,
 * and a refusal the server reported is entitled to its confident wording — that
 * line is drawn in `src/lib/unverified-write-copy.ts` and this is where the walk
 * respects it.
 *
 * That distinction is load-bearing rather than tidy, and resolving constants is
 * what made it so. Two `if (!x.ok)` branches in the tree hold copy that is
 * honest exactly because the server answered — `roster-editor.tsx`'s
 * `PERMISSION_COPY`/`NETWORK_COPY` and the booking-requests section's
 * `SAVE_STEP_READ_FAILED`, whose read throws before its PUT is ever sent.
 * Following constants without narrowing the guard reports both as findings.
 */
function networkFailureBranches(source: string): Array<{ line: number; text: string }> {
  const lines = source.split("\n");
  const resultNames = fetchResultNames(source);
  const constants = moduleConstantValues(source);
  const branches: Array<{ line: number; text: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const guarded = /^\s*if\s*\(\s*!\s*([A-Za-z_$][\w$]*)\s*(\?\.|[)&|,])/.exec(
      line,
    )?.[1];
    const isNetworkBranch =
      /\bcatch\b/.test(line) || (guarded !== undefined && resultNames.has(guarded));
    if (!isNetworkBranch) continue;
    const body = branchBody(lines, index);
    // The literal text AND the same text with its module constants substituted
    // in: keeping both means a finding can still quote what is on the line.
    branches.push({
      line: index + 1,
      text: `${body}\n${withConstantsResolved(body, constants)}`,
    });
  }
  return branches;
}

/**
 * Blank comments so a `// this used to say "was not saved"` note is not a
 * finding, WITHOUT collapsing lines — a finding has to point at the real line
 * number or the message sends the next reader to the wrong place.
 */
function blankComments(source: string): string {
  return stripComments(source);
}

describe("unverified-write copy contract (#2668)", () => {
  it("no browser-side network-failure branch claims the stored record did not move", () => {
    const findings: string[] = [];

    for (const file of allSourceFiles()) {
      // Test helper: reads a fixed repo file under process.cwd(); the path comes
      // from the walk above, not from user input.
      const source = readFileSync(repoPath(file), "utf8");
      if (!/^\s*["']use client["']/m.test(source)) continue;
      if (!/\bfetch\s*\(/.test(source)) continue;
      const exemptions = HONEST_CLAIMS.filter((allowed) => allowed.file === file);

      for (const branch of networkFailureBranches(blankComments(source))) {
        // Branch-scoped, not file-scoped: the rest of an allowlisted file is
        // walked exactly like everything else.
        if (
          exemptions.some((allowed) => branch.text.includes(allowed.branchContains))
        ) {
          continue;
        }
        for (const claim of RECORD_UNCHANGED_CLAIMS) {
          if (!claim.pattern.test(branch.text)) continue;
          findings.push(
            `${file}:${branch.line} — a network-failure branch asserts ${claim.label}. ` +
              "The client cannot know that: `fetch` also rejects after the server " +
              "committed. Use unverifiedWriteMessage() from " +
              "src/lib/unverified-write-copy.ts, or add THIS BRANCH to " +
              "HONEST_CLAIMS with the reason the claim is true.",
          );
        }
      }
    }

    expect(findings).toEqual([]);
  });

  it("each honest 'nothing changed' claim still reads before it writes", () => {
    for (const allowed of HONEST_CLAIMS) {
      const source = readFileSync(repoPath(allowed.file), "utf8");
      expect(
        source.includes(allowed.mustContain),
        `${allowed.file} no longer contains "${allowed.mustContain}", so the ` +
          `reason it is allowed to claim nothing changed may no longer hold: ${allowed.reason}`,
      ).toBe(true);
      // And the exemption still points at a branch that exists. A `branchContains`
      // that has drifted matches nothing, which fails OPEN — the branch would be
      // walked again and the honest claim reported as a finding — but a
      // never-matching entry is dead weight that reads like live cover, so it is
      // held to naming something real.
      expect(
        source.includes(allowed.branchContains),
        `${allowed.file} no longer contains the branch this exemption names ` +
          `("${allowed.branchContains}"). Re-point or delete the HONEST_CLAIMS entry.`,
      ).toBe(true);
    }
  });

  /**
   * The walk's own reach, pinned against synthetic sources rather than against
   * the tree — so a rewrite that quietly narrows it fails here instead of going
   * unnoticed until a real surface slips through. Each case below is one a
   * reviewer demonstrated the earlier draft missed.
   */
  describe("the walk itself", () => {
    const CLAIM = 'setError("Nothing was saved.")';
    function findingsIn(source: string): string[] {
      const found: string[] = [];
      for (const branch of networkFailureBranches(blankComments(source))) {
        for (const claim of RECORD_UNCHANGED_CLAIMS) {
          if (claim.pattern.test(branch.text)) found.push(claim.label);
        }
      }
      return found;
    }

    it("resolves a claim held in a module-scope constant", () => {
      // How `roster-editor.tsx` and `notifications-settings.tsx` are written.
      expect(
        findingsIn(
          [
            'const COPY = "Nothing was saved.";',
            "async function save() {",
            "  try {",
            "    await fetch('/api/x', { method: 'PUT' });",
            "  } catch {",
            "    setError(COPY);",
            "  }",
            "}",
          ].join("\n"),
        ),
      ).not.toEqual([]);
    });

    it("resolves a claim in a constant built across several lines", () => {
      expect(
        findingsIn(
          [
            "const COPY =",
            '  "The save failed. " +',
            '  "Nothing was saved.";',
            "async function save() {",
            "  try {",
            "    await fetch('/api/x', { method: 'PUT' });",
            "  } catch {",
            "    setError(COPY);",
            "  }",
            "}",
          ].join("\n"),
        ),
      ).not.toEqual([]);
    });

    it("guards a fetch assigned to an outer binding, not only a declared one", () => {
      expect(
        findingsIn(
          [
            // No `catch` token anywhere in this source, so the only route to a
            // finding is recognising the assigned binding as a fetch result.
            "async function save() {",
            "  let response: Response | null = null;",
            "  response = await fetch('/api/x', { method: 'PUT' });",
            "  if (!response?.ok) {",
            `    ${CLAIM};`,
            "  }",
            "}",
          ].join("\n"),
        ),
      ).not.toEqual([]);
    });

    it("leaves a server-answered refusal alone", () => {
      // `if (!response.ok)` — no optional chain, so a response is in hand and
      // the server did answer. Its refusals keep their confident wording.
      expect(
        findingsIn(
          [
            "async function save() {",
            "  const response = await fetch('/api/x', { method: 'PUT' });",
            "  if (!response.ok) {",
            `    ${CLAIM};`,
            "  }",
            "}",
          ].join("\n"),
        ),
      ).toEqual([]);
    });

    it("does not report a falsy guard on something that is not a fetch result", () => {
      // The false positive an earlier draft produced: a discard-confirm dialog.
      expect(
        findingsIn(
          [
            "async function save() {",
            "  await fetch('/api/x', { method: 'PUT' });",
            "  if (!dirty) {",
            `    ${CLAIM};`,
            "  }",
            "}",
          ].join("\n"),
        ),
      ).toEqual([]);
    });
  });

  it("every editor fixed by #2668 says what is actually known", () => {
    // Every surface that speaks this sentence, and the thing each one may no
    // longer claim. Named individually so a regression points at the screen it
    // broke, not just at "some file in src".
    //
    // Membership matters as much as the wording: an `outcome` here is asserted as
    // a QUOTED LITERAL, which a hand-typed copy of the whole sentence cannot
    // satisfy. That is what stops the list from being four files that agree by
    // accident — two of them were exactly that until this review.
    const FIXED: Array<{
      file: string;
      /**
       * The `unverifiedWriteMessage()` argument this surface names, pinned as a
       * quoted literal. Omitted where the outcome names a thing on screen and so
       * has to be a template literal.
       */
      outcome?: string;
      /** Wording that must NOT come back. */
      bannedPhrase?: string;
      /** Machinery whose removal would quietly restore the old behaviour. */
      mustContain?: string;
    }> = [
      {
        file: "src/components/requested-room-editor.tsx",
        outcome: "your room request was saved",
        bannedPhrase: "Your room request was not saved",
      },
      {
        file: "src/components/admin/booking-manual-payment-controls.tsx",
        outcome: "this payment was recorded",
        bannedPhrase: "Nothing was recorded",
      },
      {
        file: "src/components/admin/manual-refund-task-queue.tsx",
        outcome: "this refund task was closed",
        bannedPhrase: "Nothing was changed",
      },
      {
        file: "src/app/(admin)/admin/display/templates/restore-built-ins.tsx",
        outcome: "the built-in boards were restored",
        bannedPhrase: "was changed — safe to try again",
      },
      {
        file: "src/components/admin/bed-allocation-removal-dialog.tsx",
        outcome: "the removal was applied",
        bannedPhrase: "Removal failed; nothing was removed.",
      },
      {
        file: "src/components/admin/roster-editor.tsx",
        outcome: "the roster was saved",
        // The server's own ROSTER_SERVICE_UNAVAILABLE copy is still allowed —
        // it is the side that knows — so what is pinned here is that the two
        // are separate constants and the browser has its own.
        mustContain: "const UNVERIFIED_COPY",
      },
      {
        file: "src/app/(admin)/admin/notifications/notifications-settings.tsx",
        outcome: "these notification preferences were saved",
        // "Not saved" survives for a batch the SERVER refused outright; what
        // must not come back is saying it when an outcome was never read.
        mustContain: "const allRefused",
      },
      /*
        These two shipped the right sentence before #2668 and were left out of the
        sweep because nothing about them looked broken — which is the whole
        problem. Each had the canonical wording typed out by hand, identical by
        luck, pinned by nothing, and a re-wording of the shared builder would have
        silently forked them. The first is a CAPACITY write.
      */
      {
        file: "src/app/(admin)/admin/waitlist/page.tsx",
        outcome: "this booking was force-confirmed",
      },
      {
        file: "src/components/confirm-draft-button.tsx",
        outcome: "this draft was confirmed",
      },
      {
        // The wizard's board-bind PATCH. Its outcome names the board the operator
        // picked, so it is a template literal rather than a quoted one; what is
        // pinned instead is the check that keeps an unread answer apart from a
        // refusal the server reported. Without it the branch goes back to saying
        // the screen "will come up on the club default board", which is false in
        // exactly the case where the bind landed and only the answer was lost.
        file: "src/app/(admin)/admin/display/setup/display-wizard-steps.tsx",
        mustContain: "bindResponse === null",
      },
    ];

    for (const fixed of FIXED) {
      const source = blankComments(readFileSync(repoPath(fixed.file), "utf8"));
      if (fixed.outcome !== undefined) {
        expect(
          source.includes(`"${fixed.outcome}"`),
          `${fixed.file} no longer builds its unverified message from "${fixed.outcome}"`,
        ).toBe(true);
      }
      expect(
        source.includes("unverifiedWriteMessage"),
        `${fixed.file} no longer builds its unverified message from the shared ` +
          "helper, so its wording can now drift from every other surface's",
      ).toBe(true);
      if (fixed.bannedPhrase !== undefined) {
        expect(
          source.includes(fixed.bannedPhrase),
          `${fixed.file} has re-grown the confident phrasing "${fixed.bannedPhrase}"`,
        ).toBe(false);
      }
      if (fixed.mustContain !== undefined) {
        expect(
          source.includes(fixed.mustContain),
          `${fixed.file} no longer has "${fixed.mustContain}", which is what keeps ` +
            "an unread outcome apart from a refusal the server reported",
        ).toBe(true);
      }
    }
  });

  it("builds the sentence the waitlist offer card shipped, byte for byte", () => {
    // #2623 T8 wrote this wording first. The shared builder has to reproduce it
    // exactly, or moving that component onto it would have changed live copy.
    expect(
      unverifiedWriteMessage(
        "this offer was confirmed",
        "Reload the booking and check its current status before trying again.",
      ),
    ).toBe(
      "The service response could not be read, so we could not verify whether this offer was confirmed. Reload the booking and check its current status before trying again.",
    );
  });
});
