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

// #4467 item 2: the same gate over the design-system rules, which are counted
// per element: trading one raw control for another in a file is an increase,
// and a count that fell must be lowered in the baseline before lint passes.
it("holds each raw-control count per file and rule, and asks for a prune when one falls", () => {
  const root = process.cwd();
  const scratch = path.join(root, ".artifacts");
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(path.join(scratch, "design-system-ratchet-"));
  try {
    const plugin = pathToFileURL(path.join(root, "scripts/eslint/design-system.mjs")).href;
    writeFileSync(path.join(dir, "eslint.config.mjs"), [
      `import designSystem from ${JSON.stringify(plugin)};`,
      "export default [{",
      "  languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },",
      '  plugins: { "design-system": designSystem },',
      '  rules: { "design-system/no-raw-select": "error", "design-system/no-raw-button": "error", "design-system/no-native-confirm": "error" },',
      "}];",
      "",
    ].join("\n"));
    const suppressions = path.join(dir, "eslint-suppressions.json");
    writeFileSync(suppressions, JSON.stringify({
      "old.js": { "design-system/no-raw-select": { count: 1 }, "design-system/no-native-confirm": { count: 1 } },
    }));
    const oldFile = path.join(dir, "old.js");
    const run = (...args) => spawnSync(process.execPath, [path.join(root, "node_modules/eslint/bin/eslint.js"), ".", ...args], { cwd: dir, encoding: "utf8" });
    const baseline = 'const a = <select />;\nwindow.confirm("x");\n';

    writeFileSync(oldFile, baseline);
    expect(run().status).toBe(0);
    // One more of the same in a baseline file.
    writeFileSync(oldFile, `${baseline}const b = <select />;\n`);
    expect(run().status).toBe(1);
    writeFileSync(oldFile, `${baseline}confirm("y");\n`);
    expect(run().status).toBe(1);
    // A raw select traded for a raw button is not a fall.
    writeFileSync(oldFile, 'const a = <button />;\nwindow.confirm("x");\n');
    const traded = run();
    expect(traded.status).not.toBe(0);
    expect(traded.stdout).toContain("design-system/no-raw-button");
    // A file that had none.
    writeFileSync(oldFile, baseline);
    writeFileSync(path.join(dir, "new.js"), "const a = <select />;\n");
    expect(run().status).toBe(1);
    rmSync(path.join(dir, "new.js"));
    // A migration lowers the count: lint fails until the baseline says so.
    writeFileSync(oldFile, 'window.confirm("x");\n');
    const stale = run();
    expect(stale.status).not.toBe(0);
    expect(`${stale.stdout}${stale.stderr}`).toContain("--prune-suppressions");
    expect(run("--prune-suppressions").status).toBe(0);
    expect(run().status).toBe(0);
    // Pruning removed only the migrated rule; the confirm is still held at one.
    writeFileSync(oldFile, 'const a = <select />;\nwindow.confirm("x");\n');
    expect(run().status).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

// A suppression is keyed by path. If its file is deleted, a NEW file created at
// that path would inherit the old file's allowance without anyone deciding so.
// A deleted file's entries go in the same change; a moved file's entry moves
// with it, at the same count (docs/TESTING.md -> "Design-system control ratchet").
it("records suppressions only for files that exist", async () => {
  const { existsSync, readFileSync } = await import("node:fs");
  const suppressions = JSON.parse(readFileSync(path.join(process.cwd(), "eslint-suppressions.json"), "utf8"));
  const files = Object.keys(suppressions);
  expect(files.length).toBeGreaterThan(0);
  expect(files.filter((file) => !existsSync(path.join(process.cwd(), file)))).toEqual([]);
});
