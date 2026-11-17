- **The Members list no longer reloads its own address when it opens (#5155).**
  Opening the Members page used to repeat a navigation to the address it was
  already on, which briefly removed the browser tab's page title. The page now
  changes its address only when the filters, search, sort or page number need
  it to. Nothing about what the list shows has changed.
