- **The Members list no longer reloads its own address when it opens (#5155).**
  Opening the Members page used to repeat a navigation to the address it was
  already on, and that repeat is the likely cause of an intermittent "page has
  no title" result in our automated accessibility check. The page now changes
  its address only when the filters, search, sort or page number need it to.
  Nothing about what the list shows has changed.
