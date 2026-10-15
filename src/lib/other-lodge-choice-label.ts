/**
 * Two Other lodges may share a name (#69): the central server's id is what
 * makes them distinct, and a person picking one cannot see an id. Wherever a
 * lodge is chosen from a list, each choice whose name another choice shares is
 * labelled with its location too ("Ruapehu Lodge (Whakapapa)"); every other
 * choice is labelled with its name alone. Two lodges of one name at one
 * location (or with none) still read alike: an accepted limit.
 *
 * No `server-only` import: the pickers render the label in the browser, and the
 * public booking-request form receives it from the server already made.
 */

/**
 * The key two names are compared on, as the central server compares them for
 * its "looks the same" warning: compatibility forms folded, invisible
 * characters and every space removed, lower-cased. "Ruapehu Lodge" and
 * "ruapehu lodge" are the same name to a person choosing between them.
 */
function nameKey(name: string): string {
  return name.normalize("NFKC").replace(/[\p{Cf}\p{Cc}]/gu, "").replace(/\s/gu, "").toLowerCase();
}

export function otherLodgeChoiceLabel(
  lodge: { name: string; location: string | null },
  choices: ReadonlyArray<{ name: string }>,
): string {
  const key = nameKey(lodge.name);
  const shared = choices.filter((c) => nameKey(c.name) === key).length > 1;
  const location = lodge.location?.trim();
  return shared && location ? `${lodge.name} (${location})` : lodge.name;
}

/**
 * One lodge's name with its location, for a view that shows a single lodge
 * and cannot know whether another shares its name (the officer's booking
 * request queue): "Ruapehu Lodge (Whakapapa)", or the name alone when the
 * location is not known.
 */
export function otherLodgeNameWithLocation(lodge: { name: string; location?: string | null }): string {
  const location = lodge.location?.trim();
  return location ? `${lodge.name} (${location})` : lodge.name;
}

/** Each choice as `{ id, name, label }`, its location used only for the label. */
export function withOtherLodgeChoiceLabels(
  choices: ReadonlyArray<{ id: string; name: string; location: string | null }>,
): Array<{ id: string; name: string; label: string }> {
  return choices.map((c) => ({ id: c.id, name: c.name, label: otherLodgeChoiceLabel(c, choices) }));
}
