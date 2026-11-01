- **Changing the central server address keeps the previous API key private (#4436).**
  The address change now clears the old key and server answers in one save.
  A simultaneous sync reads its address and key together, so it cannot send
  the previous server's key to the new address. Replacing a key also clears
  the previous connection's answers in the same save.
