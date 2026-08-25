import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * #3111 - an artifact every lane adds an entry to must stay fragment-backed.
 *
 * ## The rule this enforces
 *
 * `AGENTS.md` -> "Change Discipline": an artifact every lane adds an entry to is
 * a directory of per-lane fragments, never one shared file - a lane adds a file
 * rather than editing a shared list, so two lanes cannot collide. A flat list
 * whose entries never relate to each other may instead be declared `merge=union`,
 * which is what `CHANGELOG.md` does (#2451).
 *
 * The repository had solved this three times - `changelog.d/` (#2452),
 * `size-allowances.d/`, and that `merge=union` - and stated the rule nowhere. So
 * an agent adding a new shared artifact had to reach the pattern by analogy, and
 * analogy is the first thing to go under context pressure. This is the cheap
 * regression check on the known set; the stated rule and its routing row are what
 * reach the unknown set.
 *
 * ## WHAT THIS CANNOT DO - read this before trusting a green run
 *
 * It cannot recognise a NEWLY INVENTED shared file that should have been a
 * fragment directory. Every artifact below had to be registered by hand, and the
 * defining symptom of this class is not being recognised as a member of it. A
 * green run here means the known artifacts have not regressed. It means nothing
 * whatsoever about the next one somebody adds.
 *
 * That asymmetry is in the failure message too, deliberately: #3109 found a guard
 * on this epic whose success line asserted a property that had never been tested,
 * and a guard implying completeness it lacks is worse than no guard.
 *
 * ## Why there is no history-based detector here, and please do not add one
 *
 * #3111 proposed one, twice, and both forms were measured and rejected. The
 * measurement is recorded here so a third proposal does not cost another lane a
 * day rediscovering it.
 *
 * The first form counted how many merges touched each file and failed above a
 * threshold. Measured over the last 300 first-parent merges, the top of that
 * distribution is `docs/DOMAIN_INVARIANTS.md` (91 merges), `docs/UX_FLOW_MAP.md`
 * (47), `AGENTS.md` (41) and `prisma/schema.prisma` (38) - files lanes genuinely
 * co-edit, where a conflict is real work and not waste. Any threshold catching a
 * collision generator catches all of those.
 *
 * The second form kept a fan-in floor but keyed on append-only-ness: the share of
 * a file's commits that are pure additions with no deletions. That is the right
 * idea - what separates a ledger from a co-edited document is whether lanes ever
 * modify each other's lines - and it still does not work, because the measurement
 * does not cooperate. `docs/CLUB_TIME_KERNEL.md`, the file that prompted the
 * issue, scores 33% (4 pure appends across 12 merges): a lane appends a block AND
 * revises a neighbouring line. Meanwhile `CHANGELOG.md` scores 77% and
 * `prisma/schema.prisma` 61%. Any threshold catching 33% also catches
 * `DOMAIN_INVARIANTS.md` (48%), `package.json` (48%), `.github/workflows/ci.yml`
 * (39%) and `UX_FLOW_MAP.md` (38%) - the same "fires on twenty files" outcome.
 *
 * Scoring by changed LINES rather than by commits fails the same way and more
 * sharply: additions are 94% of `prisma/schema.prisma`'s churn and 92% of
 * `ci.yml`'s, against 91% for the kernel ledger. Co-edited files are
 * addition-dominated too, because most work adds lines.
 *
 * The property that actually distinguishes the class is semantic - is an entry
 * owned by exactly one lane and never revised by another? - and git history
 * cannot see it. So this registry is hand-maintained on purpose, and the rule in
 * `AGENTS.md` is what does the work a detector cannot.
 *
 * Reads the working tree plus one `git check-attr` call. No history, so it is
 * safe in a shallow clone; no network and no database.
 */

/** How a registered artifact keeps parallel lanes from colliding. */
type Remedy = "fragment-directory" | "union-merge";

interface AdditiveArtifact {
  /** Repository-relative path to the directory or file. */
  readonly path: string;
  readonly remedy: Remedy;
  /** Why it is in the class. Each entry is a claim someone can argue with. */
  readonly why: string;
}

/**
 * The known additive artifacts. Add a row when you add an artifact every lane
 * adds an entry to. The reverse direction is checked below, so a new top-level
 * `*.d/` directory fails until it is registered here.
 */
const ADDITIVE_ARTIFACTS: readonly AdditiveArtifact[] = [
  {
    path: "changelog.d",
    remedy: "fragment-directory",
    why: "Every code-bearing pull request adds one entry (#2452). Hand-editing CHANGELOG.md's Unreleased list made concurrent lanes conflict daily.",
  },
  {
    path: "size-allowances.d",
    remedy: "fragment-directory",
    why: "Every lane that grows a file past its budget adds one allowance, and no lane reads another's.",
  },
  {
    path: "CHANGELOG.md",
    remedy: "union-merge",
    why: "A flat bullet list of released entries (#2451). Union is right here precisely because the entries are unrelated lines rather than sections of an argument.",
  },
  {
    path: "docs/BLUE_GREEN_MIGRATION_SAFETY.tsv",
    remedy: "union-merge",
    why: "One row per migration, hand-appended by every schema lane, parsed row-by-row and order-independently. Measured at 86-90% pure-append across 37-40 merges (#3111), and blue-green-ledger-lint.test.ts already fails loudly on a duplicate row, so union cannot corrupt it silently.",
  },
];

/**
 * Appended to every failure. The point is the blind spot: a reader who takes a
 * green run for full coverage has drawn exactly the wrong conclusion.
 */
const BLIND_SPOT = [
  "",
  "The rule (AGENTS.md -> Change Discipline): an artifact every lane adds an",
  "entry to is a directory of per-lane fragments, never one shared file. A lane",
  "adds a file rather than editing a shared list, so two lanes cannot collide.",
  "A flat list of unrelated lines may instead be declared `merge=union`.",
  "",
  "WHAT THIS CHECK CANNOT DO: it cannot recognise a newly invented shared file",
  "that should have been a fragment directory. Every artifact it knows about was",
  "registered by hand, and the defining symptom of this class is not being",
  "recognised as a member of it. Green here means the KNOWN set has not",
  "regressed; it says nothing about the next artifact somebody adds. That is",
  "what the stated rule and its routing row are for, and why a green run here is",
  "not evidence of coverage.",
].join("\n");

const fragmentDirectories = () =>
  ADDITIVE_ARTIFACTS.filter((artifact) => artifact.remedy === "fragment-directory");

/** `git check-attr` resolves the attribute that really applies, not a line that looks like it. */
function mergeAttribute(paths: readonly string[]): Map<string, string> {
  const output = execFileSync("git", ["check-attr", "merge", "--", ...paths], {
    encoding: "utf8",
  });
  const resolved = new Map<string, string>();
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    // Each line is `<path>: merge: <value>`, and no path can contain the marker.
    const marker = ": merge: ";
    const at = line.lastIndexOf(marker);
    if (at === -1) continue;
    resolved.set(line.slice(0, at), line.slice(at + marker.length).trim());
  }
  return resolved;
}

describe("additive artifacts stay fragment-backed (#3111)", () => {
  it("has artifacts registered, so a rename cannot make this vacuous", () => {
    expect(ADDITIVE_ARTIFACTS.length).toBeGreaterThan(0);
    expect(fragmentDirectories().length).toBeGreaterThan(0);
    for (const artifact of ADDITIVE_ARTIFACTS) {
      expect(
        artifact.why.length,
        `${artifact.path} needs a reason someone can argue with`,
      ).toBeGreaterThan(40);
    }
  });

  it("keeps every registered fragment directory a directory", () => {
    const offenders = fragmentDirectories()
      .filter((artifact) => !(existsSync(artifact.path) && statSync(artifact.path).isDirectory()))
      .map((artifact) => `${artifact.path} (${artifact.why})`);

    expect(
      offenders,
      `A registered additive artifact is no longer a directory of per-lane ` +
        `fragments. Turning one back into a single shared file returns the ` +
        `conflict-per-lane it was created to remove: the first lane to write it ` +
        `is free, and every lane after that pays a conflict resolve plus a full ` +
        `CI cycle.\n\nRegressed: ${offenders.join(", ")}\n${BLIND_SPOT}`,
    ).toEqual([]);
  });

  it("names every fragment directory with the `.d` suffix and gives it a README", () => {
    const misnamed = fragmentDirectories()
      .filter((artifact) => !artifact.path.endsWith(".d"))
      .map((artifact) => artifact.path);
    expect(
      misnamed,
      `The \`.d\` suffix is how a reader recognises a fragment directory on ` +
        `sight, which is the mechanism by which the next lane copies the pattern ` +
        `instead of inventing a shared file.\n\nMisnamed: ${misnamed.join(", ")}` +
        `\n${BLIND_SPOT}`,
    ).toEqual([]);

    const undocumented = fragmentDirectories()
      .filter((artifact) => !existsSync(join(artifact.path, "README.md")))
      .map((artifact) => artifact.path);
    expect(
      undocumented,
      `Every fragment directory carries a README.md stating its entry style and ` +
        `linking the general rule, so the directory does not read as an ` +
        `unexplained special case.\n\nUndocumented: ${undocumented.join(", ")}` +
        `\n${BLIND_SPOT}`,
    ).toEqual([]);
  });

  it("keeps every registered union-merged artifact declared `merge=union`", () => {
    const unionArtifacts = ADDITIVE_ARTIFACTS.filter(
      (artifact) => artifact.remedy === "union-merge",
    );
    const resolved = mergeAttribute(unionArtifacts.map((artifact) => artifact.path));

    const offenders = unionArtifacts
      .filter((artifact) => resolved.get(artifact.path) !== "union")
      .map(
        (artifact) => `${artifact.path} (resolved to ${resolved.get(artifact.path) ?? "nothing"})`,
      );

    expect(
      offenders,
      `A registered artifact is declared additive-by-union but \`.gitattributes\` ` +
        `no longer gives it \`merge=union\`, so concurrent appends conflict again. ` +
        `Union is only correct for a FLAT list of unrelated lines: union-merging ` +
        `a narrative document interleaves its sections in arbitrary order and can ` +
        `duplicate headings, SILENTLY, which is why the fragment directory is the ` +
        `default remedy and this one is the exception.\n\n` +
        `Regressed: ${offenders.join(", ")}\n${BLIND_SPOT}`,
    ).toEqual([]);
  });

  it("registers every top-level `.d` directory, so a new one cannot go unnoticed", () => {
    const registered = new Set(fragmentDirectories().map((artifact) => artifact.path));
    const unregistered = readdirSync(".", { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(".d"))
      .map((entry) => entry.name)
      .filter((name) => !registered.has(name));

    expect(
      unregistered,
      `A top-level fragment directory exists that this check does not know ` +
        `about. Add it to ADDITIVE_ARTIFACTS with the reason it belongs to the ` +
        `class, so the next lane to touch it is told what it is. This is the one ` +
        `direction this check can close by itself.\n\n` +
        `Unregistered: ${unregistered.join(", ")}\n${BLIND_SPOT}`,
    ).toEqual([]);
  });

  it("keeps the rule stated in AGENTS.md and reachable from its routing table", () => {
    const agents = readFileSync("AGENTS.md", "utf8");

    // The rule itself. A guard over the instances is worthless if the sentence
    // governing the unknown ones can be deleted without anything failing.
    expect(agents).toContain("is a directory of per-lane fragments");
    expect(agents).toContain("never one shared file");

    // And reachable at the moment of need rather than only by reading the file
    // end to end - the failure mode AGENTS.md's own routing table exists for:
    // "A rule you cannot reach at the moment you need it is a rule that does
    // not hold."
    const routingRow = agents
      .split("\n")
      .find((line) => line.startsWith("| An entry every lane adds"));
    expect(
      routingRow,
      "AGENTS.md's routing table lost the row that makes the fragment-directory " +
        "rule reachable. The rule existing is not the same as an agent finding it.",
    ).toBeDefined();
    expect(routingRow).toContain("the fragment-directory rule");
  });

  it("has each fragment directory's README state the general rule", () => {
    // Deliberately keyed on the rule's own operative words rather than on a
    // citation. An earlier version of this assertion asked only for the string
    // "#3111", and a mutation that stripped the rule out of the README survived
    // it: the bare issue number was still there in a table cell, so the check
    // passed over a README that no longer stated the rule. A citation token is
    // cheap to satisfy accidentally; the sentence is not.
    const offenders = fragmentDirectories()
      .filter((artifact) => {
        const readme = readFileSync(join(artifact.path, "README.md"), "utf8");
        return !readme.includes("AGENTS.md") || !readme.includes("never one shared file");
      })
      .map((artifact) => artifact.path);

    expect(
      offenders,
      `Each fragment directory's README must state the general rule - the words ` +
        `"never one shared file" - and name AGENTS.md as its home, so the ` +
        `directory does not read as a local trick. The two existing directories ` +
        `read as unrelated special cases for months, which is exactly why nobody ` +
        `recognised the next artifact as a member of the same class.\n\n` +
        `Missing the rule: ${offenders.join(", ")}\n${BLIND_SPOT}`,
    ).toEqual([]);
  });
});
