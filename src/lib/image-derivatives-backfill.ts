import fs from "fs/promises";
import path from "path";

import {
  plannedDerivativeWidthsFor,
  writeImageDerivatives,
} from "@/lib/image-derivatives";
import {
  ALLOWED_IMAGE_EXTS,
  IMAGE_DERIVATIVES_DIRECTORY,
  isDerivativeDirectoryName,
  listImageDerivatives,
  removeImageDerivatives,
} from "@/lib/image-storage";

/**
 * Make the website-sized copies (#4935, INV-PUB-005) that images uploaded
 * before copies existed never got, and tidy copies whose original is gone.
 *
 * Idempotent: an image whose current copies already match what it should have
 * is left alone, so a second run finds nothing to do. Dry run unless `apply`.
 * Run by an operator through `scripts/backfill-image-sizes.ts`; nothing a
 * visitor or officer does in the app reaches it.
 */

export type ImageDerivativeBackfillReport = {
  /** Images that already had exactly the copies they should. */
  upToDate: number;
  /** Images whose copies were (or, in a dry run, would be) remade. */
  refreshed: string[];
  /** Images whose copies could not be made; they keep serving the original. */
  failed: string[];
  /** Copies whose original no longer exists, removed (or to remove). */
  orphansRemoved: string[];
};

type Options = {
  root: string;
  apply: boolean;
};

function sameWidths(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((width, i) => width === b[i]);
}

export async function backfillImageDerivatives({
  root,
  apply,
}: Options): Promise<ImageDerivativeBackfillReport> {
  const report: ImageDerivativeBackfillReport = {
    upToDate: 0,
    refreshed: [],
    failed: [],
    orphansRemoved: [],
  };
  await backfillDirectory(root, root, apply, report);
  return report;
}

async function backfillDirectory(
  root: string,
  absDir: string,
  apply: boolean,
  report: ImageDerivativeBackfillReport,
): Promise<void> {
  const entries = await fs.readdir(absDir, { withFileTypes: true });
  const originals = new Set<string>();
  const derivatives = await listImageDerivatives(absDir);
  let wroteCopies = false;

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!isDerivativeDirectoryName(entry.name)) {
        await backfillDirectory(
          root,
          path.join(absDir, entry.name),
          apply,
          report,
        );
      }
      continue;
    }
    if (
      !entry.isFile() ||
      !ALLOWED_IMAGE_EXTS.has(path.extname(entry.name).toLowerCase())
    ) {
      continue;
    }
    originals.add(entry.name);

    const filePath = path.join(absDir, entry.name);
    const label = path.relative(root, filePath);
    let planned: number[];
    let originalMtimeMs: number;
    try {
      planned = await plannedDerivativeWidthsFor(filePath, entry.name);
      originalMtimeMs = (await fs.stat(filePath)).mtimeMs;
    } catch {
      // Unreadable as an image: the upload path would have made no copies of
      // it either. Any copies it has are stale by definition.
      planned = [];
      originalMtimeMs = Number.POSITIVE_INFINITY;
    }

    const existing = derivatives.get(entry.name) ?? [];
    const current = existing.every((copy) => copy.mtimeMs >= originalMtimeMs);
    if (
      current &&
      sameWidths(
        existing.map((copy) => copy.width),
        planned,
      )
    ) {
      report.upToDate += 1;
      continue;
    }

    if (!apply) {
      report.refreshed.push(label);
      continue;
    }
    const bytes = await fs.readFile(filePath);
    const written = await writeImageDerivatives(bytes, absDir, entry.name);
    if (sameWidths(written, planned)) {
      report.refreshed.push(label);
      wroteCopies ||= written.length > 0;
    } else {
      report.failed.push(label);
    }
  }

  for (const [original, copies] of derivatives) {
    if (originals.has(original)) continue;
    report.orphansRemoved.push(
      ...copies.map((copy) =>
        path.relative(
          root,
          path.join(absDir, IMAGE_DERIVATIVES_DIRECTORY, copy.fileName),
        ),
      ),
    );
    if (apply) await removeImageDerivatives(absDir, original);
  }

  if (wroteCopies) await matchDirectoryOwnership(absDir);
}

/**
 * Run as root (the usual way to reach a Docker volume from the host), the
 * copies folder would be root-owned, and the app — uid 1001 — could then
 * neither replace a copy on re-upload nor delete the album holding it. Give
 * the folder and its files the owner of the album they sit in.
 */
async function matchDirectoryOwnership(absDir: string): Promise<void> {
  if (process.getuid?.() !== 0) return;
  const { uid, gid } = await fs.stat(absDir);
  const sizesDir = path.join(absDir, IMAGE_DERIVATIVES_DIRECTORY);
  await fs.chown(sizesDir, uid, gid);
  for (const name of await fs.readdir(sizesDir)) {
    await fs.chown(path.join(sizesDir, name), uid, gid);
  }
}
