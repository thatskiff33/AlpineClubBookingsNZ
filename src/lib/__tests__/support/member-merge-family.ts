import fs from "fs";
import path from "path";

/**
 * Every `src/lib/member-merge*.ts` source, concatenated.
 *
 * THE ONE DEFINITION IN THE TREE, for the same reason `strip-comments.ts` is:
 * several guards claim to pin facts about the merge, and a guard that names a
 * file path has quietly hard-coded a second claim — that the code is still in
 * that file. That claim is not checked by anything, and it goes stale silently.
 *
 * #3128 proved it three times in one commit. Splitting `member-merge.ts` moved
 * the relation specs, the snapshot column list and the `fieldMergeRow` calls
 * into modules of their own, and four guards that named `src/lib/member-merge.ts`
 * broke at once. Three went red — recoverable, if confusing, because a
 * behaviour-preserving move should not redden anything. The fourth was worse:
 * `member-merge-field-kinds.test.ts` matched zero `fieldMergeRow("...")` calls
 * and its "every one of these has a declared value kind" assertion then passed
 * over an EMPTY LIST. It was saved only by an explicit non-emptiness guard that
 * #2860 had thought to add. A census that silently measures nothing is worse
 * than no census, because it reports success.
 *
 * So the rule this file exists to enforce: a guard over the merge asks for the
 * merge's SOURCE, never for a file. Where the code sits is then free to change,
 * which — given this file has now been split twice — it will.
 *
 * DELIBERATELY NON-RECURSIVE. A future `src/lib/member-merge/` directory would
 * evade this glob, and that is a known and accepted gap rather than an oversight:
 * every caller carries its own non-emptiness assertion, so the evasion surfaces
 * as a loud failure rather than as a vacuous pass. Widening to a recursive walk
 * would also start pulling in unrelated trees on the next rename.
 */
export function mergeFamilySource(): string {
  const dir = path.join(process.cwd(), "src", "lib");
  const files = fs
    .readdirSync(dir)
    .filter((name) => /^member-merge.*\.ts$/.test(name))
    .sort();
  if (files.length === 0) {
    throw new Error(
      "No src/lib/member-merge*.ts file found. The merge modules have been " +
        "renamed or moved into a subdirectory, and every guard reading this " +
        "helper is now measuring nothing. Fix the glob, do not delete the caller.",
    );
  }
  return files
    .map((name) => fs.readFileSync(path.join(dir, name), "utf8"))
    .join("\n");
}
