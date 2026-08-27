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

A post **stays inside your club unless its author shares it**. When your club
has an Alpine Central Server connection (Admin → Integrations), members may
tick **Share with all clubs** in the composer: the post is sent to the central
server and appears on every other club's board. Without that connection the
tickbox is disabled and says so, and every post is club-only.

Posts **other clubs share** appear on your board too — on a differently shaded
card with the origin club's name — and their pictures are copied to and served
by your own installation, so your members' reading habits are not disclosed to
anyone else and the board keeps working when the central server is down.

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

### Moderating another club's post

You can **hide** or **remove** another club's post from your own board — both
are local acts that change nothing anywhere else. You cannot **edit** its
words: the post still carries the other club's name, and rewriting it here
would misrepresent that club to your members. The Edit control refuses with
exactly that explanation.

### When a shared post is taken down on the network

If the central server removes a post (its administrator acted, or enough clubs
reported it), your board follows: another club's post disappears, and **your
own club's post is hidden rather than deleted** — the words belong to your
member, so takedown convergence is a moderation act, not an erasure. You can
unhide it from the **Hidden** tab, at which point it is a club-only post that
is no longer on the network.

### Remove a post

1. Click **Remove** and confirm.
2. The text is **deleted permanently**. It cannot be recovered from this screen,
   and the audit log records that a removal happened without keeping a copy of
   what was said.

Use **Hide** unless you actually want the words gone.

Removing a post **your club had shared** also withdraws it from the central
server, so it comes off the other clubs' boards too. If the central server is
unreachable at that moment the local removal still completes, and the
withdrawal is retried.

### Set how long posts are kept

1. On the same screen, find the **Retention** card.
2. Click **Edit**, choose a period, and click **Save**. **Cancel** puts it back.
3. Before you save, the card tells you how many posts on the board are already
   older than the period you have chosen — those are the ones that would go.

The default is **Keep everything**, and nothing is deleted automatically until
you change it.

Once a period is set, a scheduled job deletes posts older than it. That job
runs every few hours, not once at night, so a post reaching the end of the
window goes within hours rather than waiting for the next evening. **This is
permanent**: hidden posts are deleted too, and there is no recovery from this
screen. A post exactly on the boundary is kept rather than deleted.

**Run cleanup now** does the same job immediately and tells you how many posts
it deleted. If the scheduled job happens to be running, it says so and does
nothing rather than deleting twice.

### How posts travel (for the technically curious)

Sharing is push-with-a-polling-backstop. The central server notifies your
installation the moment something changes, and a scheduled pull reconciles the
board a few times a day regardless — so a missed notification delays a post,
never loses one. Two rows on **Admin → Background jobs** watch this: **Club
message board mirror sync** (the pull) and **Club message board share retry**
(your own outbound shares). The push registration happens automatically the
first time the sync runs; installations without a public https address simply
stay on polling.

## Good to know

- **Members cannot edit or delete their own posts.** Every request comes to you.
- **A post's author is taken from their login**, so a post cannot be made under
  somebody else's name.
- **Posts are limited to ten an hour per member**, so one person cannot fill the
  board.
- **Nothing is deleted automatically until you set a retention period.** The
  default keeps everything.
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
