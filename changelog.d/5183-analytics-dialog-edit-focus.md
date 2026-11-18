- **Pressing Edit in the Google Analytics settings now keeps keyboard focus in the dialog (#5183).** On **Integrations**, **Manage Google Analytics** opens a dialog. When a keyboard or screen-reader user pressed **Edit** there, the browser dropped focus to the page behind the dialog, so the next keystrokes went nowhere and the reader lost its place.

  Focus now moves to the first field Edit unlocks, the GA4 measurement ID, as it already does on the other settings sections. **Cancel** still returns focus to **Edit**. Nothing about what the settings save, or who may change them, changed.
