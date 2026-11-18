- **Closing a bed allocation dialog now leaves keyboard focus on the page section when the button that opened it has gone (#5183).** After removing an allocation, or moving one, the button that opened the dialog can disappear from the page. Focus is meant to fall back to the section around it, but the browser dropped it to the top of the page a moment later, so a keyboard or screen-reader user lost their place.

  Focus now stays on that section until the user moves on. Nothing about what the dialogs remove or move, or who may use them, changed.
