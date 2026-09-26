/** The one directory used by both the size-budget gate and release compiler. */
export const ALLOWANCE_DIR = "size-allowances.d";

const WINDOWS_DEVICE_NAME = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

export function isReservedAllowanceName(name) {
  return typeof name === "string" && name.toLowerCase() === "readme.md";
}

/** Portable direct-child fragment names accepted by both readers. */
export function isSafeAllowanceName(name) {
  return (
    typeof name === "string" &&
    name.toLowerCase().endsWith(".md") &&
    !WINDOWS_DEVICE_NAME.test(name) &&
    !/[<>:"/\\|?*]/.test(name) &&
    !/\p{Cf}/u.test(name) &&
    !/[. ]$/.test(name) &&
    [...name].every((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127;
    })
  );
}
