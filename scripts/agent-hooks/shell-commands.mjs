/**
 * Split a Bash command line into the simple commands it would run (#4462).
 *
 * The agent-rule hook asks "does any command in this line force-push?", which
 * a regular expression over the raw text cannot answer: `cd x && git push -f`
 * hides the push after an operator, and `git commit -m "never use npx"` only
 * MENTIONS a banned command inside quoted data. So the line is tokenised the
 * way a shell would, far enough to tell those apart:
 *
 * - `&&`, `||`, `;`, `|`, `&`, newlines, `( … )`, `{ … }` and control-flow
 *   keywords separate commands;
 * - quotes make data, but `$( … )` and backticks inside double quotes still run,
 *   so they are parsed as commands of their own;
 * - here-strings and quoted here-documents (`<<'EOF'`) are data; an unquoted
 *   here-document (`<<EOF`) is scanned like double-quoted text, because the
 *   shell runs its `$( … )` and backticks;
 * - ANSI-C quoting (`$'…'`) is one quoted word;
 * - redirections and their targets are not arguments;
 * - leading `VAR=value` assignments and wrappers (`env`, `timeout`, `nice`,
 *   `nohup`, `sudo`, `xargs`, `command`, `exec`, …) are stripped, and
 *   `bash -c '<script>'` / `eval` are parsed recursively.
 *
 * It is not a shell. It never throws on malformed input — an unterminated quote
 * simply ends the line — because the hook that calls it must fail open.
 * Node built-ins only; it runs before every Bash call an agent makes.
 */

const MAX_DEPTH = 8;

/** Words that start or join a compound command rather than name a program. */
const KEYWORDS = new Set(["!", "{", "}", "then", "do", "done", "else", "elif", "fi", "if", "while", "until", "esac"]);

/** Read until the closing double quote, parsing substitutions as commands. */
function readDoubleQuoted(src, start, append, commands, depth) {
  append("");
  let i = start;
  while (i < src.length && src[i] !== '"') {
    const c = src[i];
    if (c === "\\") {
      const next = src[i + 1];
      if (next === "\n") {
        i += 2;
      } else if (next !== undefined && '"\\$`'.includes(next)) {
        append(next);
        i += 2;
      } else {
        append(c);
        i += 1;
      }
    } else if (c === "$" && src[i + 1] === "(" && src[i + 2] !== "(") {
      const inner = parseSequence(src, i + 2, ")", depth + 1);
      commands.push(...inner.commands);
      i = inner.end;
    } else if (c === "`") {
      const inner = parseSequence(src, i + 1, "`", depth + 1);
      commands.push(...inner.commands);
      i = inner.end;
    } else {
      append(c);
      i += 1;
    }
  }
  return i + 1;
}

/** Parse the `$( … )` and backtick substitutions in unquoted here-document text. */
function scanSubstitutions(text, commands, depth) {
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
    } else if (text[i] === "$" && text[i + 1] === "(" && text[i + 2] !== "(") {
      const inner = parseSequence(text, i + 2, ")", depth + 1);
      commands.push(...inner.commands);
      i = inner.end;
    } else if (text[i] === "`") {
      const inner = parseSequence(text, i + 1, "`", depth + 1);
      commands.push(...inner.commands);
      i = inner.end;
    } else {
      i += 1;
    }
  }
}

/**
 * Skip the bodies of the here-documents opened on the line just ended. A
 * quoted delimiter makes the body data; an unquoted one leaves the shell to run
 * its substitutions, so those are parsed into `commands`.
 */
function skipHeredocBodies(src, start, pending, commands, depth) {
  let i = start;
  for (const { delimiter, stripTabs, quoted } of pending) {
    const bodyStart = i;
    let bodyEnd = src.length;
    while (i < src.length) {
      const newline = src.indexOf("\n", i);
      const lineEnd = newline === -1 ? src.length : newline;
      let line = src.slice(i, lineEnd);
      if (stripTabs) line = line.replace(/^\t+/, "");
      if (line === delimiter) {
        bodyEnd = i;
        i = lineEnd + 1;
        break;
      }
      i = lineEnd + 1;
    }
    if (!quoted) scanSubstitutions(src.slice(bodyStart, Math.min(bodyEnd, src.length)), commands, depth);
  }
  return Math.min(i, src.length);
}

/** Read a here-document delimiter word, removing any quoting. */
function readHeredocDelimiter(src, start) {
  let i = start;
  while (src[i] === " " || src[i] === "\t") i += 1;
  let delimiter = "";
  let quoted = false;
  while (i < src.length && !/[\s;&|<>()]/.test(src[i])) {
    const c = src[i];
    if (c === "'" || c === '"') {
      quoted = true;
      const close = src.indexOf(c, i + 1);
      const end = close === -1 ? src.length : close;
      delimiter += src.slice(i + 1, end);
      i = end + 1;
    } else if (c === "\\") {
      quoted = true;
      delimiter += src[i + 1] ?? "";
      i += 2;
    } else {
      delimiter += c;
      i += 1;
    }
  }
  return { delimiter, quoted, end: i };
}

/**
 * Parse commands from `start` until `terminator` (`)`, a backtick, or the end).
 * Returns the raw word lists and the index just past the terminator.
 */
function parseSequence(src, start, terminator, depth) {
  const commands = [];
  if (depth > MAX_DEPTH) return { commands, end: src.length };
  let words = [];
  let word = null;
  let redirectTarget = false;
  let heredocs = [];
  let i = start;

  const append = (text) => {
    word = (word ?? "") + text;
  };
  const endWord = () => {
    if (word === null) return;
    if (redirectTarget) redirectTarget = false;
    else words.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    redirectTarget = false;
    if (words.length > 0) commands.push(words);
    words = [];
  };

  while (i < src.length) {
    const c = src[i];
    if (c === terminator) {
      endCommand();
      return { commands, end: i + 1 };
    }
    if (c === "\\") {
      if (src[i + 1] !== "\n" && i + 1 < src.length) append(src[i + 1]);
      i += 2;
    } else if (c === "$" && src[i + 1] === "'") {
      // ANSI-C quoting: one word, in which a backslash escapes the next
      // character, so `\'` does not close it.
      let j = i + 2;
      let text = "";
      while (j < src.length && src[j] !== "'") {
        if (src[j] === "\\" && j + 1 < src.length) {
          text += src[j + 1];
          j += 2;
        } else {
          text += src[j];
          j += 1;
        }
      }
      append(text);
      i = j + 1;
    } else if (c === "'") {
      const close = src.indexOf("'", i + 1);
      const end = close === -1 ? src.length : close;
      append(src.slice(i + 1, end));
      i = end + 1;
    } else if (c === '"') {
      i = readDoubleQuoted(src, i + 1, append, commands, depth);
    } else if (c === "`") {
      const inner = parseSequence(src, i + 1, "`", depth + 1);
      commands.push(...inner.commands);
      append("");
      i = inner.end;
    } else if (c === "$" && src.startsWith("$((", i)) {
      const close = src.indexOf("))", i + 3);
      const end = close === -1 ? src.length : close + 2;
      append(src.slice(i, end));
      i = end;
    } else if (c === "$" && src[i + 1] === "(") {
      const inner = parseSequence(src, i + 2, ")", depth + 1);
      commands.push(...inner.commands);
      append("");
      i = inner.end;
    } else if (c === "#" && word === null) {
      while (i < src.length && src[i] !== "\n") i += 1;
    } else if (c === " " || c === "\t" || c === "\r") {
      endWord();
      i += 1;
    } else if (c === "\n") {
      endCommand();
      i = skipHeredocBodies(src, i + 1, heredocs, commands, depth);
      heredocs = [];
    } else if (c === "&" && src[i + 1] === ">") {
      endWord();
      i += 1;
    } else if (c === ";" || c === "|" || c === "&") {
      endCommand();
      i += 1;
      while (src[i] === ";" || src[i] === "|" || src[i] === "&") i += 1;
    } else if (c === "(") {
      endCommand();
      const inner = parseSequence(src, i + 1, ")", depth + 1);
      commands.push(...inner.commands);
      i = inner.end;
    } else if (c === ")") {
      endCommand();
      i += 1;
    } else if (c === "<" || c === ">") {
      if (word !== null && /^\d+$/.test(word)) word = null;
      endWord();
      if (src.startsWith("<<<", i)) {
        i += 3;
        redirectTarget = true;
      } else if (src.startsWith("<<", i)) {
        i += 2;
        const stripTabs = src[i] === "-";
        if (stripTabs) i += 1;
        const read = readHeredocDelimiter(src, i);
        if (read.delimiter) heredocs.push({ delimiter: read.delimiter, stripTabs, quoted: read.quoted });
        i = read.end;
      } else {
        i += 1;
        while (src[i] === ">" || src[i] === "<" || src[i] === "&" || src[i] === "|") i += 1;
        redirectTarget = true;
      }
    } else {
      append(c);
      i += 1;
    }
  }
  endCommand();
  return { commands, end: src.length };
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;

/** Skip a wrapper's own options; `valued` options take the next word. */
function skipOptions(words, start, valued = new Set()) {
  let i = start;
  while (i < words.length && words[i].startsWith("-") && words[i] !== "-") {
    if (words[i] === "--") return i + 1;
    i += valued.has(words[i]) ? 2 : 1;
  }
  return i;
}

const WRAPPER_VALUED_OPTIONS = {
  env: new Set(["-u", "--unset", "-C", "--chdir"]),
  nice: new Set(["-n", "--adjustment"]),
  sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T"]),
  xargs: new Set(["-n", "-I", "-L", "-P", "-d", "-E", "-s", "-a"]),
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
};
const PLAIN_WRAPPERS = new Set(["exec", "nohup", "builtin", "noglob", "time", "command"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

/** The program a word names, without its directory. */
export function programName(word) {
  return word.slice(word.lastIndexOf("/") + 1);
}

/**
 * Strip assignments, keywords and wrappers from one raw word list; expand
 * `bash -c` and `eval`. Pushes zero or more normalised commands to `out`.
 */
function normalise(rawWords, out, depth) {
  let words = rawWords;
  for (;;) {
    let i = 0;
    while (i < words.length && (ASSIGNMENT.test(words[i]) || KEYWORDS.has(words[i]))) i += 1;
    words = words.slice(i);
    if (words.length === 0) return;
    const program = programName(words[0]);
    if (program === "command" && /^-[vV]/.test(words[1] ?? "")) return;
    if (PLAIN_WRAPPERS.has(program)) {
      words = words.slice(skipOptions(words, 1));
    } else if (program in WRAPPER_VALUED_OPTIONS) {
      let next = skipOptions(words, 1, WRAPPER_VALUED_OPTIONS[program]);
      if (program === "timeout") next += 1;
      words = words.slice(next);
    } else {
      break;
    }
  }
  const program = programName(words[0]);
  if (SHELLS.has(program)) {
    const flag = words.findIndex((word, index) => index > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(word));
    if (flag !== -1 && words[flag + 1] !== undefined) {
      for (const inner of parseSequence(words[flag + 1], 0, null, depth + 1).commands) {
        normalise(inner, out, depth + 1);
      }
      return;
    }
  }
  if (program === "eval") {
    for (const inner of parseSequence(words.slice(1).join(" "), 0, null, depth + 1).commands) {
      normalise(inner, out, depth + 1);
    }
    return;
  }
  out.push([program, ...words.slice(1)]);
}

/**
 * Every simple command a Bash line would run, each as `[program, ...args]` with
 * the program reduced to its base name. Never throws.
 */
export function simpleCommands(source) {
  if (typeof source !== "string" || source.length === 0) return [];
  const out = [];
  for (const raw of parseSequence(source, 0, null, 0).commands) normalise(raw, out, 0);
  return out;
}
