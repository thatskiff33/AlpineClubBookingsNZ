- **Reading an issue now shows the whole conversation by default, and a decided
  issue has to say so at the top (#2788).** Decisions about this project are
  usually made in a comment on an issue, some time after the issue itself was
  written. The standard command for reading an issue prints only the original
  description, so anyone — person or automated agent — reading it that way saw a
  list of options that still looked open, and either asked the owner a question
  they had already answered or built the option they had turned down. It
  happened once more this month, on a question the owner had settled the
  previous evening.

  A new command, `npm run issue -- <number>`, prints the description, every
  comment in order with its author and date, and the state of each issue the
  description links to. When the description still offers unticked options while
  a comment already records a decision, it says so loudly and names the comment.
  It has no option to print less, on purpose: the short command has to be the
  complete one, because the short command is the one people actually use.

  Alongside it, recording a decision now includes rewriting the issue's
  description in the same sitting — the decision at the top, the options struck
  through, and a link to the comment that decided it — so that reading the
  description, which is what everybody does, gives the answer. The instructions
  every automated agent reads carry this as a requirement rather than a
  suggestion.

  Nothing in the booking, membership or payment system changed.
