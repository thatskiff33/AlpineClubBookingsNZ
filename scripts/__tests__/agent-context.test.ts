import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  generateAgentContext,
  normalizeTrackedPath,
  parseAgentContextArgs,
} from "../agent-context";

type Fixture = {
  root: string;
  outputRoot: string;
  write(relativePath: string, content: string): void;
  cleanup(): void;
};

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function createFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "agent-context-test-"));
  const write = (relativePath: string, content: string): void => {
    const absolute = path.join(root, ...relativePath.split("/"));
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  };
  write(
    "src/entry.ts",
    [
      'import { local } from "./local";',
      'import { alias } from "@/alias";',
      'import type { ReactNode } from "react";',
      'export const loadDynamic = () => import("./dynamic");',
      "export const entry = local + alias;",
      "export type EntryNode = ReactNode;",
      "",
    ].join("\n"),
  );
  write("src/local.ts", 'import { deep } from "./deep";\nexport const local = deep;\n');
  write("src/deep.ts", "export const deep = 1;\n");
  write("src/alias.ts", "export const alias = 2;\n");
  write("src/dynamic.ts", "export const dynamic = 3;\n");
  write("src/importer.ts", 'import { entry } from "./entry";\nexport const imported = entry;\n');
  write(
    "src/__tests__/entry.test.ts",
    'import { entry } from "../entry";\nit("loads", () => expect(entry).toBe(3));\n',
  );
  write("src/__tests__/unrelated.test.ts", 'it("unrelated", () => expect(1).toBe(1));\n');
  write("docs/note.md", "# Note\n");
  write(
    "prisma/schema.prisma",
    [
      "model User {",
      "  id       String    @id",
      "  bookings Booking[]",
      "}",
      "",
      "model Booking {",
      "  id      String @id",
      "  user    User   @relation(fields: [userId], references: [id])",
      "  userId  String",
      "  lodge   Lodge  @relation(fields: [lodgeId], references: [id])",
      "  lodgeId String",
      "}",
      "",
      "model Lodge {",
      "  id       String    @id",
      "  bookings Booking[]",
      "}",
      "",
    ].join("\n"),
  );
  git(root, "init", "-q");
  git(root, "config", "user.email", "agent-context@example.invalid");
  git(root, "config", "user.name", "Agent Context Test");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  return {
    root,
    outputRoot: path.join(root, ".artifacts", "agent-context"),
    write,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function readArtifact(directory: string, fileName: string): string {
  return readFileSync(path.join(directory, fileName), "utf8");
}

describe("agent context generator", () => {
  const fixtures: Fixture[] = [];

  afterEach(() => {
    for (const fixture of fixtures.splice(0)) fixture.cleanup();
  });

  it("produces deterministic sorted tracked-only artifacts", () => {
    const fixture = createFixture();
    fixtures.push(fixture);
    fixture.write("untracked-secret.env", "SHOULD_NOT_APPEAR=secret-like-value\n");

    const options = {
      base: "HEAD",
      entries: ["src/entry.ts"],
      models: ["Booking"],
      depth: 2 as const,
      maxChars: 100_000,
      repoRoot: fixture.root,
    };
    const first = generateAgentContext(options);
    const firstFiles = ["manifest.json", "overview.md", "typescript.md", "prisma.md"].map(
      (fileName) => readArtifact(first.outputDirectory, fileName),
    );
    const second = generateAgentContext(options);
    const secondFiles = ["manifest.json", "overview.md", "typescript.md", "prisma.md"].map(
      (fileName) => readArtifact(second.outputDirectory, fileName),
    );

    expect(second.outputDirectory).toBe(first.outputDirectory);
    expect(secondFiles).toEqual(firstFiles);
    expect(firstFiles.join("\n")).not.toContain("SHOULD_NOT_APPEAR");
    const manifest = JSON.parse(firstFiles[0]) as {
      sectionChars: Record<string, number>;
      combinedChars: number;
    };
    expect(manifest.sectionChars["manifest.json"]).toBe(firstFiles[0].length);
    expect(manifest.combinedChars).toBe(firstFiles.reduce((sum, text) => sum + text.length, 0));
  });

  it("normalises Windows separators and rejects paths outside the repository", () => {
    const fixture = createFixture();
    fixtures.push(fixture);

    expect(normalizeTrackedPath(".\\src\\entry.ts")).toBe("src/entry.ts");
    expect(() => normalizeTrackedPath("..\\secret.txt")).toThrow(/escapes the repository/);
    expect(() => normalizeTrackedPath("C:\\outside\\secret.txt")).toThrow(/repository-relative/);
    const result = generateAgentContext({
      base: "HEAD",
      entries: ["src\\entry.ts"],
      repoRoot: fixture.root,
      maxChars: 100_000,
    });
    expect(readArtifact(result.outputDirectory, "overview.md")).toContain("`src/entry.ts`");
    expect(() =>
      generateAgentContext({
        base: "HEAD",
        entries: ["untracked.txt"],
        repoRoot: fixture.root,
      }),
    ).toThrow(/not a Git-tracked file/);
  });

  it("maps relative, alias and dynamic imports, reverse importers, nearby tests and depth", () => {
    const fixture = createFixture();
    fixtures.push(fixture);

    const depthOne = generateAgentContext({
      base: "HEAD",
      entries: ["src/entry.ts"],
      depth: 1,
      maxChars: 100_000,
      repoRoot: fixture.root,
    });
    const oneHop = readArtifact(depthOne.outputDirectory, "typescript.md");
    expect(oneHop).toContain("## `src/local.ts`");
    expect(oneHop).toContain("## `src/alias.ts`");
    expect(oneHop).toContain("## `src/dynamic.ts`");
    expect(oneHop).toContain("## `src/importer.ts`");
    expect(oneHop).toContain("`src/__tests__/entry.test.ts`");
    expect(oneHop).toContain("`react`");
    expect(oneHop).not.toContain("## `src/deep.ts`");
    // #2903: "nearby" means the test names this module. Listing every sibling
    // test instead put all 1,108 files of `src/lib/__tests__/` under each node
    // and failed the cap for most real entrypoints.
    expect(oneHop).not.toContain("unrelated.test.ts");

    const depthTwo = generateAgentContext({
      base: "HEAD",
      entries: ["src/entry.ts"],
      depth: 2,
      maxChars: 100_000,
      repoRoot: fixture.root,
    });
    expect(readArtifact(depthTwo.outputDirectory, "typescript.md")).toContain(
      "## `src/deep.ts`",
    );
    expect(() =>
      generateAgentContext({
        base: "HEAD",
        entries: ["src/entry.ts"],
        depth: 3 as 1,
        repoRoot: fixture.root,
      }),
    ).toThrow(/depth must be 1 or 2/);
  });

  it("indexes every Prisma model and expands only requested models plus direct neighbours", () => {
    const fixture = createFixture();
    fixtures.push(fixture);

    const result = generateAgentContext({
      base: "HEAD",
      entries: ["docs/note.md"],
      models: ["Booking"],
      maxChars: 100_000,
      repoRoot: fixture.root,
    });
    const prisma = readArtifact(result.outputDirectory, "prisma.md");
    expect(prisma).toContain("- `Booking`");
    expect(prisma).toContain("- `Lodge`");
    expect(prisma).toContain("- `User`");
    expect(prisma).toContain("### `Booking` (requested)");
    expect(prisma).toContain("### `Lodge` (direct relation neighbour)");
    expect(prisma).toContain("### `User` (direct relation neighbour)");
    expect(() =>
      generateAgentContext({
        base: "HEAD",
        entries: ["docs/note.md"],
        models: ["MissingModel"],
        repoRoot: fixture.root,
      }),
    ).toThrow(/Unknown Prisma model/);
  });

  it("changes identity for relevant dirty contents and fails on a missing base", () => {
    const fixture = createFixture();
    fixtures.push(fixture);
    const clean = generateAgentContext({
      base: "HEAD",
      entries: ["src/entry.ts"],
      maxChars: 100_000,
      repoRoot: fixture.root,
    });
    fixture.write(
      "src/entry.ts",
      `${readFileSync(path.join(fixture.root, "src", "entry.ts"), "utf8")}\n// relevant dirty content\n`,
    );
    const dirty = generateAgentContext({
      base: "HEAD",
      entries: ["src/entry.ts"],
      maxChars: 100_000,
      repoRoot: fixture.root,
    });
    expect(dirty.fingerprint).not.toBe(clean.fingerprint);
    expect(dirty.outputDirectory).not.toBe(clean.outputDirectory);
    expect(() =>
      generateAgentContext({
        base: "refs/heads/does-not-exist",
        entries: ["src/entry.ts"],
        repoRoot: fixture.root,
      }),
    ).toThrow(/git rev-parse failed/);
  });

  it("enforces the combined cap before writing and permits a narrowed scope", () => {
    const fixture = createFixture();
    fixtures.push(fixture);
    const measurementRoot = path.join(fixture.root, "measurement-output");
    const measured = generateAgentContext({
      base: "HEAD",
      entries: ["src/entry.ts"],
      depth: 2,
      maxChars: 100_000,
      repoRoot: fixture.root,
      outputRoot: measurementRoot,
    });
    const narrowedMeasurement = generateAgentContext({
      base: "HEAD",
      entries: ["docs/note.md"],
      maxChars: 100_000,
      repoRoot: fixture.root,
      outputRoot: measurementRoot,
    });
    const cap = Math.floor((measured.combinedChars + narrowedMeasurement.combinedChars) / 2);
    rmSync(measurementRoot, { recursive: true, force: true });
    const capRoot = path.join(fixture.root, "cap-output");

    expect(() =>
      generateAgentContext({
        base: "HEAD",
        entries: ["src/entry.ts"],
        depth: 2,
        maxChars: cap,
        repoRoot: fixture.root,
        outputRoot: capRoot,
      }),
    ).toThrow(/No artifact was written/);
    expect(existsSync(capRoot)).toBe(false);

    const narrowed = generateAgentContext({
      base: "HEAD",
      entries: ["docs/note.md"],
      maxChars: cap,
      repoRoot: fixture.root,
      outputRoot: capRoot,
    });
    expect(existsSync(narrowed.outputDirectory)).toBe(true);
    expect(narrowed.combinedChars).toBeLessThan(measured.combinedChars);
  });

  // #2903: the documented command carries a doubled `--` so that one line works
  // in PowerShell, which eats the first separator. A POSIX shell forwards the
  // extra `--` to the script, so the parser must skip it rather than reject it.
  it("parses the documented command in every shell and explains a stripped separator", () => {
    const expected = {
      base: "origin/main",
      entries: ["src/entry.ts", "src/local.ts"],
      models: ["Booking"],
      depth: 2,
      maxChars: 32_000,
    };
    const flags = [
      "--base",
      "origin/main",
      "--entry",
      "src/entry.ts",
      "--entry",
      "src/local.ts",
      "--model",
      "Booking",
      "--depth",
      "2",
      "--max-chars",
      "32000",
    ];

    // POSIX shell: npm forwards the second separator verbatim.
    expect(parseAgentContextArgs(["--", ...flags])).toEqual(expected);
    // PowerShell: the first separator is stripped, so the script sees flags only.
    expect(parseAgentContextArgs(flags)).toEqual(expected);

    // Single `--` under PowerShell: npm consumes the flags and only bare values
    // survive. The error has to name that cause, not just the stray value.
    expect(() =>
      parseAgentContextArgs(["origin/main", "src/entry.ts"]),
    ).toThrow(/Unexpected bare value: origin\/main\. .*shell or npm consumed them/);

    expect(() => parseAgentContextArgs(["--entry", "src/entry.ts"])).toThrow(/--base is required/);
    expect(() => parseAgentContextArgs(["--base", "origin/main"])).toThrow(/At least one --entry/);
    expect(() => parseAgentContextArgs(["--base", "--entry", "src/entry.ts"])).toThrow(
      /--base requires a value/,
    );
    expect(() => parseAgentContextArgs(["--nope", "x"])).toThrow(/Unknown argument: --nope/);
  });
});
