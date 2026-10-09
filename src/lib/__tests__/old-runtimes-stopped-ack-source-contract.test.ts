import { describe, expect, it } from "vitest";

import { readRepoFile } from "@/lib/__tests__/helpers/compose";

/**
 * THE MIGRATION VALIDATOR READS `BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED` ONLY
 * FROM THE DEPLOY SHELL (#3964, #3413).
 *
 * Since #3964 the same name also lives in the project `.env`, where it is the
 * app's lasting acknowledgement that no pre-#3413 runtime remains, and
 * `docker-compose.yml` hands it to the app containers. That copy must never
 * satisfy the windowed-migration check: an operator who set it once for #3413
 * would otherwise have pre-acknowledged every future maintenance window.
 *
 * So both scripts may name the variable only in a closed set of shapes — the
 * shell default, a pass-through to the validator, a test of the shell value, and
 * an operator message — and neither may load `.env` into its shell. A read from
 * `.env`, `get_env_file_value` or `docker compose config` is none of those
 * shapes and fails here. `test:related` cannot select this file (it reads shell
 * from disk); run it with `pnpm run test:named`.
 */

const NAME = "BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED";
const SCRIPTS = [
  "scripts/run-production-blue-green-deploy.sh",
  "scripts/validate-blue-green-migrations.sh",
];

const ALLOWED_SHAPES: RegExp[] = [
  // The shell default: the variable's own environment value, else 0.
  new RegExp(`^${NAME}="\\$\\{${NAME}:-0\\}"$`),
  // Passing the shell value on to the validator.
  new RegExp(`^${NAME}="\\$${NAME}" \\\\$`),
  // Testing the shell value.
  new RegExp(`^\\[ "\\$${NAME}" != "1" \\]; then$`),
  // An operator message.
  /^echo "[^$`]*"( >&2)?$/,
];

/**
 * Bounded, line-local Bash command scan. Quotes and escapes protect separators
 * in messages, while quoted filenames remain arguments. This is not JavaScript
 * comment normalization or an evaluator of aliases, eval or command substitutions.
 */
function loadsDotenv(line: string): boolean {
  const commands: { value: string; quoted: boolean }[][] = [];
  let command: { value: string; quoted: boolean }[] = [];
  let word = "";
  let quoted = false;
  let quote: "'" | '"' | undefined;
  const flushWord = () => {
    if (word || quoted) command.push({ value: word, quoted });
    word = "";
    quoted = false;
  };
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === "\\" && quote !== "'") {
      word += line[++index] ?? "";
      quoted = true;
    } else if (quote) {
      if (character === quote) quote = undefined;
      else word += character;
    } else if (character === "'" || character === '"') {
      quote = character;
      quoted = true;
    } else if (character === "#" && word === "") {
      break;
    } else if (/[;&|()]/.test(character) ||
      (word === "" && /[{}]/.test(character) &&
        (index + 1 === line.length || /\s/.test(line[index + 1])))) {
      flushWord();
      commands.push(command);
      command = [];
    } else if (/\s/.test(character)) {
      flushWord();
    } else {
      word += character;
    }
  }
  flushWord();
  commands.push(command);
  return commands.some((words) => {
    let start = 0;
    while (words[start] && !words[start].quoted &&
      /^(?:if|elif|then|else|do|while|until|!)$/.test(words[start].value)) start++;
    if (words[start]?.value === "builtin") start++;
    const name = words[start]?.value;
    if (name === "set" && /^-[a-z]*a/.test(words[start + 1]?.value ?? "")) return true;
    if (name !== "source" && name !== ".") return false;
    if (words[start + 1]?.value === "--") start++;
    return /\.env\b/.test(words[start + 1]?.value ?? "");
  });
}

describe(`${NAME} is read only from the deploy shell (#3964)`, () => {
  it.each([
    'source "${SOURCE_REPO}/.env"',
    '. "${SOURCE_REPO}/.env"',
    'if source "${SOURCE_REPO}/.env"; then :; fi',
    'elif . "${SOURCE_REPO}/.env"; then :; fi',
    'while source "${SOURCE_REPO}/.env"; do :; done',
    'until . "${SOURCE_REPO}/.env"; do :; done',
    'if true; then source "${SOURCE_REPO}/.env"; fi',
    'if source -- "${SOURCE_REPO}/.env"; then :; fi',
    '{ source "${SOURCE_REPO}/.env"; }',
    'builtin source "${SOURCE_REPO}/.env"',
    'builtin . -- "${SOURCE_REPO}/.env"',
    'echo "if true; then source .env"; source "${SOURCE_REPO}/.env"',
  ])("detects an ordinary dotenv loader: %s", (line) => {
    expect(loadsDotenv(line)).toBe(true);
  });

  it.each([
    '# if source "${SOURCE_REPO}/.env"; then :; fi',
    'echo "if source .env"',
    'echo "if true; then source .env"',
    "echo 'if true; then source .env'",
    'echo if\\ true\\;\\ then\\ source\\ .env',
    'source "${SOURCE_REPO}/helpers.sh"',
  ])("ignores comments, messages and other source files: %s", (line) => {
    expect(loadsDotenv(line)).toBe(false);
  });

  for (const script of SCRIPTS) {
    const lines = readRepoFile(script)
      .split(/\r?\n/)
      .map((line, index) => ({ line: line.trim(), number: index + 1 }));

    it(`${script} names it only in the shell-only shapes`, () => {
      const uses = lines.filter(
        ({ line }) => line.includes(NAME) && !line.startsWith("#"),
      );
      expect(uses.length, `${script} no longer names ${NAME} at all`).toBeGreaterThan(0);
      const offenders = uses
        .filter(({ line }) => !ALLOWED_SHAPES.some((shape) => shape.test(line)))
        .map(({ line, number }) => `${script}:${number}: ${line}`);
      expect(
        offenders,
        `${NAME} may be read only from the deploy shell's environment. A copy in ` +
          ".env is the app's lasting #3413 acknowledgement and must never satisfy " +
          "the windowed-migration validator (#3964).",
      ).toEqual([]);
    });

    it(`${script} never loads .env into its shell`, () => {
      const loads = lines
        .filter(({ line }) => loadsDotenv(line))
        .map(({ line, number }) => `${script}:${number}: ${line}`);
      expect(
        loads,
        `Loading .env into the shell would let its ${NAME} satisfy the ` +
          "windowed-migration validator (#3964).",
      ).toEqual([]);
    });
  }
});
