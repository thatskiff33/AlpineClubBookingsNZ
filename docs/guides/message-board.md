# Message Board

Audience: Operator

## What it is

A message board members write to themselves. Any member can post; you can hide a
post from members, correct its text, or remove it. Find the admin surface at
**Admin → Members → Message Board** (`/admin/message-board`), and the member's
own view at `/message-board`.

The board is gated by the **Message board** module (Admin → Modules), which is
**off by default** — if the entry is missing, that module is off. Hiding,
editing and removing are **membership**-area edit actions: a view-only
membership admin reads the board but cannot change anything.

Unlike [Member Notices](member-notices.md), which the committee writes and
targets at chosen members, this is written by members and seen by all of them.
Nobody targets a board post and nobody tracks who has read it.

Everything on the board currently **stays inside your club**. Members see a
"Share with all clubs" tickbox in the composer, switched off and not yet usable;
until that ships, nothing posted here leaves your club.

## When you'd use it

- A member has posted something that should not stay up, and you need it gone.
- A post is fine but has an error in it worth correcting.
- Somebody has asked for their own post to be taken down — they cannot do it
  themselves.
- You want to see what members have been posting.

## Step-by-step

### Find a post

1. Go to **Admin → Members → Message Board**.
2. **All posts** lists everything on the board, newest first. **Hidden** lists
   only what is currently hidden from members.
3. Search by any words in the post, or by the author's name.

### Hide a post

1. Find the post and click **Hide**.
2. It disappears from the member board and the dashboard card immediately. The
   text is kept.
3. The post now appears under **Hidden** with a "Hidden from members" label, and
   its button reads **Show to members**. Click that to put it back.

Hiding is the reversible option. Reach for it when you are not certain, or when
you want to take something out of view while you ask the author about it.

### Correct a post's text

1. Click **Edit text**, change the wording, and click **Save text**.
2. The original wording is written to the audit log, so what the member actually
   wrote can still be recovered.

You are rewriting somebody else's words under their name. Prefer asking the
member to repost, and keep edits to obvious corrections.

### Remove a post

1. Click **Remove** and confirm.
2. The text is **deleted permanently**. It cannot be recovered from this screen,
   and the audit log records that a removal happened without keeping a copy of
   what was said.

Use **Hide** unless you actually want the words gone.

## Good to know

- **Members cannot edit or delete their own posts.** Every request comes to you.
- **A post's author is taken from their login**, so a post cannot be made under
  somebody else's name.
- **Posts are limited to ten an hour per member**, so one person cannot fill the
  board.
- **Nothing is deleted automatically yet.** A retention setting is coming; until
  then the board keeps everything except what you remove.
- **Every action you take is recorded** in the audit log against your account.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| The Message Board entry is missing | The **Message board** module is off | Turn it on at **Admin → Setup & Configuration → Modules** |
| The buttons are greyed out | Your role has membership **view**, not **edit** | Ask a full admin for membership edit access |
| A hidden post still shows for a member | They are looking at a cached page | Ask them to reload; hiding takes effect immediately on the server |
| A member says their post vanished | It was hidden or removed by an admin | Check **Hidden**, and the audit log for a removal |

## Related links

- [Member Notices](member-notices.md) — committee-written, targeted news.
- [Modules](modules.md) — turning the board on and off.
- [The message board](../user-guide/the-message-board.md) — what members see.
