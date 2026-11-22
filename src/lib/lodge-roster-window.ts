/**
 * How many nights forward the member lodge roster looks, counted from the
 * club's today.
 *
 * A bounded window is part of the privacy contract rather than a performance
 * choice: there is no history, and no parameter that lets a caller widen it.
 * Its own module, without the roster loader's database imports, so the page
 * copy and the AI app action catalogue (ALP-718) state the same number.
 */
export const ROSTER_WINDOW_DAYS = 30;
