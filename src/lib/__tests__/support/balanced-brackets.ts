import { blankLiterals } from "./strip-comments";

const CLOSE_FOR: Readonly<Record<string, string>> = { "(": ")", "{": "}", "[": "]" };

function assertOffsetPreserving(source: string, structure: string): void {
  if (structure.length !== source.length) {
    throw new Error(
      `structure must be offset-preserving: ${structure.length} characters against a source of ${source.length}`,
    );
  }
}

/** Read a bracketed region, preserving original text and inclusive closing offset.
 *
 * Literal/comment masking belongs to the shared lexer. Callers that already
 * hold offset-preserving masked code pass it as `structure`: masking twice is
 * unsafe because a blanked regex has lost its closing slash.
 * `parts` splits on commas outside nested parentheses, braces and brackets.
 * An invalid opener or an unclosed region throws rather than hiding a site, so
 * a call-site regex must run over masked text: a hit inside a comment or string
 * is not a call, and its offset is not an opening bracket. `structure` must be
 * the same length as `source`.
 */
export function balancedBrackets(
  source: string,
  start: number,
  structure = blankLiterals(source),
): {
  text: string;
  end: number;
  parts: string[];
} {
  const code = structure;
  assertOffsetPreserving(source, code);
  if (CLOSE_FOR[code[start] ?? ""] === undefined) {
    throw new Error(
      `Expected opening bracket at offset ${start}; the offset may sit inside a comment or literal, ` +
        "so match call sites over masked text (blankLiterals) rather than the raw source",
    );
  }

  const stack: string[] = [];
  let partStart = start + 1;
  const parts: string[] = [];
  const addPart = (end: number): void => {
    if (code.slice(partStart, end).trim()) {
      parts.push(source.slice(partStart, end).trim());
    }
  };
  for (let index = start; index < code.length; index += 1) {
    const char = code[index]!;
    const close = CLOSE_FOR[char];
    if (close !== undefined) stack.push(close);
    else if (")]}".includes(char) && stack.pop() !== char) {
      throw new Error(`Mismatched bracket at offset ${index}`);
    }

    if (stack.length === 0) {
      addPart(index);
      return {
        text: source.slice(start, index + 1),
        end: index,
        parts,
      };
    }
    if (char === "," && stack.length === 1) {
      addPart(index);
      partStart = index + 1;
    }
  }
  throw new Error(`Unbalanced brackets at offset ${start}`);
}

/** Read one expression: the text from `start` to the first comma outside any
 * bracket, or to the bracket that closes the region holding it, or to the end of
 * the source when neither comes first. It is for a property or argument value,
 * whose end is not marked by an opener, so `balancedBrackets` has nothing to
 * start from. `end` is the offset of the terminating comma or closing bracket,
 * or the length of the source, and `text` is the original text up to it.
 *
 * It takes `structure` as `balancedBrackets` does, and throws on a mismatched
 * bracket or an expression that opens one it never closes.
 */
export function expressionAt(
  source: string,
  start: number,
  structure = blankLiterals(source),
): { text: string; end: number } {
  const code = structure;
  assertOffsetPreserving(source, code);

  const stack: string[] = [];
  for (let index = start; index < code.length; index += 1) {
    const char = code[index]!;
    const close = CLOSE_FOR[char];
    if (close !== undefined) stack.push(close);
    else if (")]}".includes(char)) {
      if (stack.length === 0) return { text: source.slice(start, index), end: index };
      if (stack.pop() !== char) throw new Error(`Mismatched bracket at offset ${index}`);
    } else if (char === "," && stack.length === 0) {
      return { text: source.slice(start, index), end: index };
    }
  }
  if (stack.length > 0) {
    throw new Error(`Unbalanced brackets in the expression at offset ${start}`);
  }
  return { text: source.slice(start), end: source.length };
}
