/**
 * A free-text postal address as printed lines (#5066): one line per line typed,
 * each trimmed, blank lines dropped. The one rule the Club identity form's
 * dirty check, its route's stored value and the generated invoice's supplier
 * block all read (`INV-SSOT`). Pure and client-safe.
 */
export function postalAddressLines(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** What is stored for a typed address: its printed lines joined, or null when there are none. */
export function storedPostalAddress(value: string | null | undefined): string | null {
  const lines = postalAddressLines(value);
  return lines.length > 0 ? lines.join("\n") : null;
}
