/**
 * EVERY AGE-TIER WRITER RE-RESOLVES EMAIL INHERITANCE (#2821).
 *
 * `isUsableEmailSource` requires `ageTier === "ADULT"`, so a write that moves a
 * member across that line decides whether they may still be somebody's contact
 * of record. #2716 wired that rule into ONE function,
 * `reconcileEmailInheritanceForMemberChange`, and its docblock claimed every
 * such write called it. Six did not. This file exists so the claim and the code
 * cannot drift again.
 *
 * A WRITER IS ANY MEMBER-WRITE THAT SETS THE AGE TIER, not only one that reaches
 * it through `resolveEnforcedAgeTier` (#2821 review). The age-up cron writes
 * `ageTier: "ADULT"` from a computed tier and the nomination promotion writes it
 * from a mapping application; neither calls that resolver, so keying discovery
 * on the resolver alone would have let a `data: { ageTier }` write add itself
 * with no reconcile call and no test to notice. Discovery is now derivation-
 * blind: it reads the `data` object of every `member.update`/`updateMany`.
 *
 * IT IS A SOURCE CENSUS BECAUSE A BEHAVIOURAL TEST CANNOT BE ONE. A seventh
 * writer added next year with no reconcile call passes every existing test: the
 * tier is written, the response is right, the page renders. What is wrong is who
 * receives a dependant's mail afterwards, and only a test that reads the source
 * of every writer can see that a call is missing rather than a case untested.
 *
 * THE LIST IS DISCOVERED, NOT WRITTEN DOWN. #2716's review found the previous
 * hand-written enumeration wrong in six places, and #2811 found an audit census
 * that passed while its subject was deleted. A census whose membership is typed
 * out by hand tests the typist. This one reads the tree.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { stripComments } from "./support/strip-comments";

const SRC_DIR = join(import.meta.dirname, "..", "..");

/** Every `.ts`/`.tsx` file under `src/`, tests and fixtures excluded. */
function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      sourceFiles(full, found);
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    if (statSync(full).isFile()) found.push(full);
  }
  return found;
}

/** Source with comments stripped, so a comment naming a call is not a call. */
function executableCode(source: string): string {
  return stripComments(source);
}

/**
 * The `{...}` object that opens at or after `from`, brace-balanced. Returns
 * `null` when there is no `{` left. Strings/regexes are not tokenised, which is
 * safe here: the census reads real member-write call sites, none of which carry
 * a `{` or `}` inside a string literal between the call and its `data` object.
 */
function balancedObject(
  code: string,
  from: number,
): { start: number; end: number; text: string } | null {
  const start = code.indexOf("{", from);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") {
      depth--;
      if (depth === 0) return { start, end: i, text: code.slice(start, i + 1) };
    }
  }
  return null;
}

/**
 * The text of an update call's `data` value: the inline object literal, or —
 * when `data` is a bare identifier — that identifier's `const/let NAME = {...}`
 * definition resolved in the same file. Returns "" when neither is found.
 *
 * Resolving the identifier is what stops `data: updateData` from being read as
 * "no age tier here" when `updateData` is a literal that sets one, and stops the
 * naive "next `{` after `data:`" from mistaking a following `select: {...}`
 * block (which routinely lists `ageTier: true`) for the write.
 */
function dataExpressionText(code: string, callArgText: string): string {
  const m = /\bdata\s*:\s*/.exec(callArgText);
  if (!m) return "";
  const after = m.index + m[0].length;
  if (callArgText[after] === "{") {
    return balancedObject(callArgText, after)?.text ?? "";
  }
  const id = /^([A-Za-z_$][\w$]*)/.exec(callArgText.slice(after));
  if (!id) return "";
  const defRe = new RegExp(
    `\\b(?:const|let|var)\\s+${id[1]}\\s*(?::[^=]*)?=\\s*`,
  );
  const def = defRe.exec(code);
  if (!def) return "";
  return balancedObject(code, def.index + def[0].length)?.text ?? "";
}

/**
 * A file that WRITES a member's age tier — the census's real subject.
 *
 * `isUsableEmailSource` keys on `ageTier === "ADULT"`, so the write that decides
 * whether a member may be somebody's contact of record is the one that MOVES
 * them across that line — however the new tier was derived. Two shapes reach
 * that write and both must be discovered:
 *
 *  - `writesAgeTier`: a `member.update`/`updateMany` whose `data` sets
 *    `ageTier`, whether the value came from `resolveEnforcedAgeTier`,
 *    `computeAgeTierWithSettings` (the age-up cron), a mapping application
 *    (nomination approval), or a literal. This is DERIVATION-BLIND on purpose:
 *    #2821 first keyed discovery on `resolveEnforcedAgeTier(` alone, so it could
 *    not see the cron writing `ageTier: "ADULT"` from a computed tier or the
 *    nomination promotion writing it from a mapping — neither calls that
 *    resolver, and a future writer need not either.
 *  - `resolvesAndWritesMember`: the original pair, kept because two writers
 *    (self-service profile, admin member detail) build their `data` object by
 *    dynamic property assignment (`updateData.ageTier = …`) that no static read
 *    of a literal can see; the `resolveEnforcedAgeTier(` + member-write pair
 *    still catches them.
 *
 * A WRITE is required either way, and that is what keeps the census honest.
 * `age-tier-enforcement.ts` and `admin-members-service.ts` resolve a tier and
 * write nothing — one computes the rule, the other reads for a list — so
 * demanding a reconcile call from them would be demanding a call with nothing to
 * reconcile, and the next person would delete the assertion rather than the
 * confusion. `member.create` is excluded by construction (only `update`/
 * `updateMany` are scanned): a brand-new member has no dependants to re-resolve.
 */
function writesAgeTier(code: string): boolean {
  const re = /\.member\.(update|updateMany)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const arg = balancedObject(code, m.index);
    if (!arg) continue;
    if (/\bageTier\b/.test(dataExpressionText(code, arg.text))) return true;
  }
  return false;
}

function resolvesAndWritesMember(code: string): boolean {
  const resolves = code.includes("resolveEnforcedAgeTier(");
  const writes =
    /\.member\.update\(/.test(code) || /\.member\.updateMany\(/.test(code);
  return resolves && writes;
}

function isAgeTierWriter(code: string): boolean {
  return writesAgeTier(code) || resolvesAndWritesMember(code);
}

const RECONCILE_CALL = "reconcileEmailInheritanceForMemberChange(";

describe("every age-tier writer re-resolves email inheritance (#2821)", () => {
  const writers = sourceFiles(SRC_DIR)
    .map((path) => ({ path, code: executableCode(readFileSync(path, "utf8")) }))
    .filter((file) => isAgeTierWriter(file.code));

  it("found the writers, so the assertion below is not vacuous", () => {
    // The failure this guards is a census that quietly matches nothing — which
    // this repo has shipped before. If a rename makes both `resolveEnforcedAgeTier`
    // and the `data: { ageTier }` shape undiscoverable, this fails loudly instead
    // of passing silently. The floor is the current true count (5 resolver-based
    // writers + the age-up cron + the nomination promotion); a deletion from
    // discovery drops below it and trips here.
    expect(writers.length).toBeGreaterThanOrEqual(7);
  });

  it("calls the reconciler in every one of them", () => {
    const missing = writers
      .filter((file) => !file.code.includes(RECONCILE_CALL))
      .map((file) => file.path.slice(SRC_DIR.length + 1).replace(/\\/g, "/"));

    expect(
      missing,
      `These files decide an enforced age tier AND write a member, but never call ` +
        `${RECONCILE_CALL}). An age tier decides whether a member may be anybody's ` +
        `contact of record (isUsableEmailSource requires ADULT), so a write that ` +
        `moves them across that line leaves their dependants pointing at somebody ` +
        `the rule no longer permits. Call it in the SAME transaction as the tier ` +
        `write — see docs/invariants/membership-lifecycle.md INV-LIFE-047.`,
    ).toEqual([]);
  });

  it("does not accept a bare import as the call", () => {
    // The exact way #2811's adoption census passed while its subject was
    // deleted: the symbol survived in the import line. Every writer must
    // INVOKE it, so the needle carries its opening parenthesis — and this
    // asserts that the needle really is call-shaped rather than a bare name.
    expect(RECONCILE_CALL.endsWith("(")).toBe(true);
    for (const file of writers) {
      const withoutImports = file.code
        .replace(/^import\s+[\s\S]*?from\s+["'][^"']+["'];$/gm, "")
        .replace(/^import\s+["'][^"']+["'];$/gm, "");
      expect(
        withoutImports.includes(RECONCILE_CALL),
        `${file.path} imports the reconciler but never calls it`,
      ).toBe(true);
    }
  });
});
