/**
 * WHO MAY IMPORT THE ANTHROPIC SDK (AID-7, #2378).
 *
 * `anthropic-client.ts` opened with "The ONLY module in the codebase that imports
 * `@anthropic-ai/sdk`" from #2211 until this issue. The claim was true, it was
 * load-bearing — it is what let a reader trust that the frozen system prompt, the
 * error taxonomy and the spend path had exactly one implementation — and it was
 * enforced by nothing at all. AID-7 needed a second importer for the diagnostics tool
 * loop, and writing that file falsified the sentence silently.
 *
 * That is the failure mode this repository keeps producing: #2786 existed because a
 * docblock claimed a check nobody had written, and its own fix then claimed a census
 * in five places that did not exist. So the replacement for the sentence is not a
 * better sentence. It is this census.
 *
 * IT IS DERIVED, NOT DECLARED. The importers are DISCOVERED by reading every source
 * file in the tree; the list below is what the discovery is asserted against. A
 * hand-written list of "files that may import the SDK" would be satisfied by a file
 * nobody remembered to add to it — the same shape as the hand-maintained list that
 * silently omitted a module in #2786.
 *
 * WHY IT MATTERS THAT THE SET IS SMALL. Each importer constructs its own client with
 * its own key, timeout, retry count and system prompt, and spends real money. A third
 * one appearing without a decision is how a paid path arrives with no budget
 * reservation, no metering and no frozen prompt — every one of which lives in the
 * caller, not in the SDK.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { stripComments } from "./support/strip-comments";

const SRC_DIR = join(import.meta.dirname, "..", "..");

/**
 * The modules allowed to import the SDK, as repo-relative POSIX paths.
 *
 * Adding a path here is a deliberate act with a cost attached: the new module owns a
 * frozen system prompt, a budget reservation, metering and an error taxonomy, or it
 * has no business holding a client. Test files are NOT listed — they mock the module
 * rather than import it, and the discovery below excludes them for that reason.
 */
const ALLOWED_SDK_IMPORTERS = [
  "lib/anthropic-client.ts",
  "lib/diagnostics/answer/provider.ts",
] as const;

/** Every `.ts`/`.tsx` file under `src/`, excluding test files and fixtures. */
function discoverSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      discoverSourceFiles(full, acc);
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue;
    acc.push(full);
  }
  return acc;
}

function repoRelative(absolute: string): string {
  return absolute.slice(SRC_DIR.length + 1).split("\\").join("/");
}

/**
 * Source with comments removed.
 *
 * Comments are stripped because this file's own subject — `anthropic-client.ts` —
 * now MENTIONS the SDK specifier in prose while explaining this very census, and a
 * naive substring search would count the explanation as an import. Matching the
 * import statement itself is also what keeps the census honest in the other
 * direction: a module that names the SDK in a comment has not acquired a client.
 */
function executableCode(source: string): string {
  return stripComments(source);
}

/**
 * Source with TYPE-ONLY imports removed as well.
 *
 * This distinction was found by the census itself, on its first run: `answer/loop.ts`
 * carries `import type Anthropic from "@anthropic-ai/sdk"` so it can name
 * `Anthropic.MessageParam` in a signature, and the first version of this file reported
 * it as a third SDK importer.
 *
 * It is not one, and the difference is exactly what this census is protecting. A
 * `import type` is erased at compile time: it constructs no client, holds no key, sets
 * no timeout and spends nothing. What the allowed list bounds is who can CALL the
 * provider — and a module that only names its types cannot. Counting them would make
 * the census noisy in the one way that gets a census deleted: failing for something
 * that is not the risk it names.
 */
function valueImportingCode(source: string): string {
  return executableCode(source)
    .replace(/^import\s+type\s+[\s\S]*?from\s+["'][^"']+["'];?$/gm, "");
}

const SDK_IMPORT =
  /^\s*(?:import\s[\s\S]*?from\s*)?["']@anthropic-ai\/sdk["']|require\(\s*["']@anthropic-ai\/sdk["']\s*\)/m;

function discoverImporters(): string[] {
  return discoverSourceFiles(SRC_DIR)
    .filter((file) => SDK_IMPORT.test(valueImportingCode(readFileSync(file, "utf8"))))
    .map(repoRelative)
    .sort();
}

describe("the Anthropic SDK has exactly the importers we decided on (#2378)", () => {
  it("discovered a non-trivial tree, so the assertion below is not vacuous", () => {
    // Without this, a broken walk would report zero importers and the equality
    // assertion would fail loudly — but a broken walk that returned only the two
    // allowed files would pass while checking nothing.
    expect(discoverSourceFiles(SRC_DIR).length).toBeGreaterThan(200);
  });

  it("is imported by exactly the allowed modules and no others", () => {
    expect(discoverImporters()).toEqual([...ALLOWED_SDK_IMPORTERS].sort());
  });

  it("finds a real import in each allowed module, so neither entry is stale", () => {
    // The other direction. An allowed entry whose file no longer imports the SDK is a
    // permission left lying around, and the equality assertion above would not catch
    // it — it compares the discovered set, so a stale entry fails there too, but this
    // says WHICH one and why, which is what a reader needs at 2am.
    for (const allowed of ALLOWED_SDK_IMPORTERS) {
      const source = valueImportingCode(
        readFileSync(join(SRC_DIR, allowed), "utf8"),
      );
      expect(
        SDK_IMPORT.test(source),
        `${allowed} is allowed to import the Anthropic SDK but no longer does — remove it from ALLOWED_SDK_IMPORTERS`,
      ).toBe(true);
    }
  });

  it("keeps each importer's spend controls beside its client", () => {
    // The census bounds WHO holds a client. This bounds what holding one obliges you
    // to have: a model constant, an explicit timeout and an explicit retry count. All
    // three are how a paid call stays bounded, and all three default to something
    // permissive in the SDK if left unstated.
    for (const allowed of ALLOWED_SDK_IMPORTERS) {
      const code = valueImportingCode(readFileSync(join(SRC_DIR, allowed), "utf8"));
      expect(code, `${allowed} constructs a client with no timeout`).toContain(
        "timeout:",
      );
      expect(
        code,
        `${allowed} constructs a client with no explicit maxRetries`,
      ).toContain("maxRetries:");
      expect(code, `${allowed} names no model`).toMatch(/model:/);
    }
  });
});
