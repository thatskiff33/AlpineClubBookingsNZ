import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * One `cat > <target> <<EOF … EOF` block that CI writes an env file with.
 *
 * `file` is repo-relative and slash-separated; `index` is 1-based within that
 * file, because more than one can live in one file and two censuses report them
 * per block rather than per file.
 */
export type CiEnvHeredoc = {
  file: string;
  target: string;
  index: number;
  body: string;
};

/** Where a CI env heredoc is allowed to live, and which files to read there. */
const SEARCH: ReadonlyArray<{ dir: string; matches: RegExp }> = [
  { dir: ".github/workflows", matches: /\.ya?ml$/ },
  // Added by #3221, when the E2E stack's `.env.staging` moved out of two copied
  // workflow heredocs and into `scripts/ci/write-e2e-staging-env.sh`. A scanner
  // that knew only about workflows would have gone from reading that file twice
  // to reading it never — silently, and with every variable it declares leaving
  // the censuses' DECLARED set. A guard keyed on a LOCATION rather than on a
  // CONTENT is one refactor away from checking nothing.
  { dir: "scripts/ci", matches: /\.sh$/ },
];

/**
 * Every CI env heredoc in the repository, in a stable order.
 *
 * ONE HOME (`INV-SSOT`). `env-delivery-census.test.ts` and
 * `email-delivery-boundary-census.test.ts` both need this and both had their own
 * copy — identical down to the same latent bug, which is exactly the shape
 * `INV-SSOT-004` was written about for comment strippers. Both copies terminated
 * the body at a line-start `EOF`, and the workflow copies closed with an indented
 * `          EOF`; so every "body" ran to the end of the file and swept up
 * whatever `NAME=value` text followed it. In `env-delivery-census` that
 * over-collection kept an exemption alive for a variable no env file declares.
 * The terminator here is indentation-tolerant.
 */
export function ciEnvHeredocs(root: string = process.cwd()): CiEnvHeredoc[] {
  const out: CiEnvHeredoc[] = [];
  for (const { dir, matches } of SEARCH) {
    for (const name of readdirSync(path.join(root, dir)).sort()) {
      if (!matches.test(name)) continue;
      const text = readFileSync(path.join(root, dir, name), "utf8");
      const opener = /cat > ([^\s]+) <<'?EOF'?/g;
      let match: RegExpExecArray | null;
      let index = 0;
      while ((match = opener.exec(text)) !== null) {
        index += 1;
        const rest = text.slice(match.index + match[0].length);
        const end = rest.search(/\n[ \t]*EOF\b/);
        out.push({
          file: `${dir}/${name}`,
          // The redirect target as written, quotes and all — `.env.staging` in a
          // workflow, `"$OUT"` in a script. Reported rather than resolved: a
          // census names what it read, and resolving a shell variable here would
          // be a second, worse shell.
          target: match[1],
          index,
          body: end === -1 ? rest : rest.slice(0, end),
        });
      }
    }
  }
  return out;
}
