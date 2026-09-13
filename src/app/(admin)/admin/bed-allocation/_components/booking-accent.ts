export interface BookingAccent {
  name: string;
  stripClassName: string;
  ringClassName: string;
}

// #2188 P2 (M1, #2181) — the decorative booking-strip palette migrates off the
// raw 9-hue Tailwind set onto the generated categorical scales cat1..cat5. This
// is the signed-off 9→5 collapse: sibling bookings now draw from FIVE distinct
// categorical hues instead of nine, so more sibling-booking colour collisions
// occur — accepted, and covered by the M1 veto-at-render evidence in the PR. The
// solid strip uses each scale's step 9 (the saturated solid band, = the old
// `-500` weight); the focus ring uses step 7 of the same scale, which reads as a
// subtle-but-visible ring in BOTH light and dark because the `--gen-*` substrate
// adapts per mode — so the old `dark:ring-*` companion pair is dropped.
// Typed as a NON-EMPTY tuple, which is what makes `BOOKING_ACCENTS[0]` below a
// proven `BookingAccent` rather than a lookup (#2801). A palette with no
// colours in it would have no accent to return at all.
export const BOOKING_ACCENTS: [BookingAccent, ...BookingAccent[]] = [
  { name: "cat1", stripClassName: "bg-cat1-9", ringClassName: "ring-cat1-7" },
  { name: "cat2", stripClassName: "bg-cat2-9", ringClassName: "ring-cat2-7" },
  { name: "cat3", stripClassName: "bg-cat3-9", ringClassName: "ring-cat3-7" },
  { name: "cat4", stripClassName: "bg-cat4-9", ringClassName: "ring-cat4-7" },
  { name: "cat5", stripClassName: "bg-cat5-9", ringClassName: "ring-cat5-7" },
];

function hashBookingId(bookingId: string) {
  let hash = 0;
  for (let index = 0; index < bookingId.length; index += 1) {
    hash = (hash * 31 + bookingId.charCodeAt(index)) >>> 0;
  }
  return hash;
}

export function getBookingAccent(bookingId: string): BookingAccent {
  // `hash % length` is in range for a non-empty palette, so the second arm is
  // unreachable — and it is the very colour bucket 0 returns, not an invented
  // default.
  return (
    BOOKING_ACCENTS[hashBookingId(bookingId) % BOOKING_ACCENTS.length] ??
    BOOKING_ACCENTS[0]
  );
}
