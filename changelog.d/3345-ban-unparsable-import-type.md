- **The security scanner now reads 166 files it was only reading part of, and
  a lint rule stops that happening again (#3318).** Nothing a member or an
  administrator sees changes; this is about how much of the code the automated
  security scan is actually able to check before a change is allowed to merge.

  The scanner cannot read one perfectly legal way of writing a TypeScript type,
  and where it hits one it silently skips the surrounding part of the file — so
  none of the security rules run there, and the scan still reports success. 169
  files were affected. All but three have been rewritten into a form the scanner
  reads, without changing what any of them do, and the rewrite was applied by
  the new rule's own automatic fix and then independently replayed and compared,
  rather than done by hand.

  The three that remain each contain a web address with an `&` in it inside a
  piece of text the scanner mis-reads, and there is no way to rewrite those
  without changing what the test is checking — in one case the exact address a
  test asserts on. Each of the three now records that reason next to itself, and
  the check refuses an entry that does not say why it is there. Closing the list
  completely needs a fix from the scanner's own authors.

  Two further findings came out of measuring it. The description of the fault
  everyone was working from was incomplete in two ways: an automatic code
  formatter reflowing a long line was enough to create a new unreadable region,
  which is how ten of the files got there in the first place; and one file
  was affected by a second, unrelated version of the same fault that nobody had
  written down. Both are now stated where the check tells you about them, and
  both are banned rather than merely described.
