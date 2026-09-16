- **The kiosk PIN a hut leader types can no longer be read by the club's own
  Site Appearance styling (#2981).** The club can add its own CSS to the public
  website from Admin > Site Appearance, and the page where a hut leader enters
  their six-digit kiosk PIN is one of the pages that styling reaches. Because of
  the way the page was built, the browser was publishing each character of the
  PIN as it was typed, in a form that a stylesheet could read one character at a
  time — so anyone who could edit the club's styling could have recovered a hut
  leader's PIN without ever seeing the screen.

  This was checked in three real browsers before anything was changed, because
  the original evidence came from a simulated browser and a simulation is not
  proof about the real thing. Chrome, Firefox and Safari all behaved the same
  way, and all three published the PIN. They no longer do: the PIN field now
  holds what is typed in a place a stylesheet cannot reach at all, and a browser
  test types a known PIN character by character and fails if a single character
  ever becomes readable again.

  Nothing changes for a hut leader: the field looks the same, accepts only six
  digits as before, and its password-manager behaviour is unchanged. Nothing
  changes for an administrator either — the club's Raw CSS feature is untouched
  and still does everything it did before.
