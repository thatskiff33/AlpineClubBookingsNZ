# File-size allowance for #5261

file: src/lib/auth.ts
lines: 987
reason: the password provider's `authorize` tops a refused compare up to the
  current bcrypt cost and upgrades an older stored hash after a proved sign-in,
  each where its branch already decides; the work itself lives in
  password-hashing.ts and password-rehash.ts.
