/**
 * Make website-sized copies of Image Manager photos uploaded before copies
 * existed (#4935, INV-PUB-004), and remove copies whose original is gone.
 *
 * Touches only the images folder on disk: no database, no provider calls.
 * Idempotent — a second run reports everything up to date and writes nothing.
 * Dry run by default.
 *
 *   pnpm run images:backfill-sizes                          # dry run, ./public/images
 *   pnpm run images:backfill-sizes --apply                  # make the copies
 *   pnpm run images:backfill-sizes --root <dir> --apply     # another images folder
 *
 * In a Docker deployment the images live in the `image_uploads` volume; point
 * `--root` at its directory on the host (`docker volume inspect` prints it as
 * `Mountpoint`). Run as root there, the script gives every copies folder the
 * owner of the album it sits in, so the app can still replace and delete it.
 * Operator steps: docs/guides/image-manager.md -> "Website-sized copies".
 */
import path from "node:path";
import process from "node:process";

import { backfillImageDerivatives } from "../src/lib/image-derivatives-backfill";
import { IMAGES_ROOT } from "../src/lib/image-storage";

function printUsage() {
  console.log(`Usage:
  pnpm run images:backfill-sizes                       # dry run (default)
  pnpm run images:backfill-sizes --apply               # make the missing copies
  pnpm run images:backfill-sizes --root <dir>          # images folder (default ${IMAGES_ROOT})
`);
}

function parseArgs(argv: string[]) {
  const options = { apply: false, root: IMAGES_ROOT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.apply = false;
      continue;
    }
    if (arg === "--root") {
      const value = argv[i + 1];
      if (!value) throw new Error("--root needs a directory");
      options.root = path.resolve(value);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const { apply, root } = parseArgs(process.argv.slice(2));
  console.log(`Mode: ${apply ? "apply" : "dry run"} — ${root}`);
  const report = await backfillImageDerivatives({ root, apply });
  const verb = apply ? "Copied" : "Would copy";
  for (const label of report.refreshed) console.log(`${verb}: ${label}`);
  for (const label of report.failed) console.log(`Could not copy (original kept): ${label}`);
  for (const label of report.orphansRemoved) {
    console.log(`${apply ? "Removed" : "Would remove"} orphaned copy: ${label}`);
  }
  console.log(
    `Up to date: ${report.upToDate}. ${verb}: ${report.refreshed.length}. ` +
      `Failed: ${report.failed.length}. Orphaned copies: ${report.orphansRemoved.length}.`,
  );
  if (!apply && report.refreshed.length + report.orphansRemoved.length > 0) {
    console.log("Nothing was written. Re-run with --apply to make these changes.");
  }
  if (report.failed.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
