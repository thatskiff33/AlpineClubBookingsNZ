import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Exercise ESLint's actual suppression gate: an increase in a baseline file,
// a new file, and a stale count must all fail, without rewriting the baseline.
it("rejects added violations and stale suppression counts", () => {
  const root = process.cwd();
  const scratch = path.join(root, ".artifacts");
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(path.join(scratch, "a11y-ratchet-"));
  try {
    const plugin = pathToFileURL(path.join(root, "scripts/eslint/accessibility.mjs")).href;
    writeFileSync(path.join(dir, "eslint.config.mjs"), `import accessibility from ${JSON.stringify(plugin)};\nexport default [{plugins:{accessibility},rules:{"accessibility/minimum-text-size":"error"}}];\n`);
    const baseline = JSON.stringify({ "old.js": { "accessibility/minimum-text-size": { count: 1 } } });
    writeFileSync(path.join(dir, "eslint-suppressions.json"), baseline);
    const oldFile = path.join(dir, "old.js");
    const run = () => spawnSync(process.execPath, [path.join(root, "node_modules/eslint/bin/eslint.js"), "."], { cwd: dir, encoding: "utf8" });
    writeFileSync(oldFile, 'const classes = "text-[11px]";');
    expect(run().status).toBe(0);
    writeFileSync(oldFile, 'const classes = "text-[11px] text-[10px]";');
    expect(run().status).toBe(1);
    writeFileSync(oldFile, 'const classes = "text-[11px]";');
    writeFileSync(path.join(dir, "new.js"), 'const classes = "text-[11px]";');
    expect(run().status).toBe(1);
    rmSync(path.join(dir, "new.js"));
    writeFileSync(oldFile, 'const classes = "text-xs";');
    expect(run().status).not.toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
