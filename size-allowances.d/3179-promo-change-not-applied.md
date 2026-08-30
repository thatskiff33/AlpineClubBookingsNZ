# File-size allowances for #3179

file: src/components/edit-booking-panel.tsx
lines: 1925
reason: this is the panel's save handler and its post-save render, and the
  change is both halves of one rule: an edit that saved WITHOUT the promo-code
  change it carried must not close the panel as though it had gone through. The
  save handler reads the notice off the response and the render branch beside
  `savedPromoCoverage` shows it with a heading and an acknowledgement button.
  The two have to move together - a state set with nothing rendering it is a
  silent partial with extra steps - and they sit either side of a 1,900-line
  component whose seam does not exist yet. Splitting the post-save states out
  is worth doing, but as its own change: two suites scan this file BY PATH
  (`effect-registration-order`, `notify-member-stays-in-the-policed-file`), and
  moving code out of a path a disk-scanning guard hardcodes is this
  repository's known silent-false-green failure - the guard keeps passing over
  the half that stayed behind. The file was 1,179 lines over its 700-line
  budget before this change and stays over it by that margin plus forty-six.
