import { scannableLines } from "./markdown-blocks.mjs";

/** Named PNG captures embedded by a member-guide page (#4469). */
export function userGuideScreenshotNames(source) {
  const visible = scannableLines(source).map((line) => line.text).join("\n");
  return [...visible.matchAll(
    /!\[[^\]\n]+\]\(\.\.\/images\/public\/([^/()]+)\.png\)/g,
  )].map((match) => match[1]);
}
