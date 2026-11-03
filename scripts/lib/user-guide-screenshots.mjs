/** Named PNG captures embedded by a member-guide page (#4469). */
export function userGuideScreenshotNames(source) {
  return [...source.matchAll(
    /!\[[^\]\n]+\]\(\.\.\/images\/public\/([^/()]+)\.png\)/g,
  )].map((match) => match[1]);
}
