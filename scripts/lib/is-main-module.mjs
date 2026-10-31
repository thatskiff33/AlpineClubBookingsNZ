/**
 * Was this module RUN, rather than imported? The one answer for every script
 * in the tree (#4598, INV-SSOT); `is-main-module.test.mjs` fails a hand-written
 * `process.argv[1]` check anywhere else.
 *
 * BOTH SIDES ARE REALPATHED. Node resolves `import.meta.url` through symlinks
 * but hands `process.argv[1]` back as the caller spelled it, so under a
 * checkout or launcher reached through a link the two strings differ. A check
 * that compares them unresolved skips `main()` and exits 0 having done
 * nothing — a silent pass a required CI step cannot tell from a real one.
 *
 * Node built-ins only, so a script run with a bare `node` (the agent hook, the
 * `verify` job's server-only self-test) can import it.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * It never throws: an `argv[1]` that is missing (`node -e`, a REPL) or does not
 * exist on disk cannot be this module, so the answer is `false`.
 *
 * @param {string} importMetaUrl the caller's `import.meta.url`
 * @param {string | undefined} [argvPath] the path Node was started with;
 *   defaults to `process.argv[1]`, a parameter only so the tests need not
 *   rewrite the process's own argv
 * @returns {boolean}
 */
export function isMainModule(importMetaUrl, argvPath = process.argv[1]) {
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}
