/**
 * Source with every comment blanked out, newlines preserved.
 *
 * THE ONE DEFINITION IN THE TREE, and it is shared rather than copied for a
 * reason that cost this repository a real blind spot (#3123).
 *
 * `club-time-escape-hatch-census.test.ts` strips comments before counting;
 * `club-time-boundary-guard.test.ts`'s staleness leg used to read RAW source.
 * The two claim to be independent instruments measuring the same thing, and for
 * that claim to hold they have to measure it the same way. They did not. This
 * repository documents each defect at the site where it removed it, so the
 * strings these scanners grep for are densest in exactly the files that no
 * longer commit the defect — and `member-guest-delegate-page.ts` kept its
 * environment-zone exemption alive on the strength of a docblock explaining the
 * defect that had already been fixed. A guard a postmortem can satisfy is not a
 * guard.
 *
 * The census's own history is the other half of the argument. Counting raw text
 * reported 14 files reading a host clock face and 96 naming `APP_TIME_ZONE`; the
 * real numbers were 0 and 9. A census that counts its own postmortems reports
 * the epic's success as its failure.
 *
 * Newlines are preserved rather than deleted so a reported line number still
 * points at the real line. String literals are tracked because `"https://x"`
 * contains a `//` that is not a comment, and template literals because they can
 * contain both — and because a call inside a `${...}` interpolation is real
 * code that a scanner blanking whole templates would miss.
 */
export function stripComments(source: string): string {
  let out = "";
  let index = 0;
  type Mode = "code" | "line" | "block" | "single" | "double" | "template";
  let mode: Mode = "code";

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];

    if (mode === "code") {
      if (character === "/" && next === "/") {
        mode = "line";
        index += 2;
        continue;
      }
      if (character === "/" && next === "*") {
        mode = "block";
        index += 2;
        continue;
      }
      if (character === "'") mode = "single";
      else if (character === '"') mode = "double";
      else if (character === "`") mode = "template";
      out += character;
      index++;
      continue;
    }

    if (mode === "line") {
      if (character === "\n") {
        mode = "code";
        out += character;
      }
      index++;
      continue;
    }

    if (mode === "block") {
      if (character === "*" && next === "/") {
        mode = "code";
        index += 2;
        continue;
      }
      if (character === "\n") out += character;
      index++;
      continue;
    }

    // Inside a string or template literal: copy through, honouring escapes.
    out += character;
    if (character === "\\") {
      if (index + 1 < source.length) out += source[index + 1];
      index += 2;
      continue;
    }
    if (
      (mode === "single" && character === "'") ||
      (mode === "double" && character === '"') ||
      (mode === "template" && character === "`")
    ) {
      mode = "code";
    }
    index++;
  }

  return out;
}
