"use client"

import { useEffect, useId, useState } from "react"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { buildHrefWithReturnTo } from "@/lib/internal-return-path"
import { formatAgeTierName } from "@/lib/use-age-tier-options"
import type {
  FamilyTreeNode,
  MemberFamilyTree,
} from "@/lib/member-family-tree"

/**
 * Word the truncation notice for the bound that actually fired. Blaming the
 * generation cap for a family that was cut off by its SIZE would send an admin
 * hunting for a great-great-grandparent that is not the problem.
 */
function truncationNotice(reason: MemberFamilyTree["truncatedReason"]): string {
  switch (reason) {
    case "generations":
      return "some connected members are more than three generations above or below this member and are not shown"
    case "size":
      return "this family is larger than the tree can show, so some connected members are not shown"
    default:
      return "some connected members are outside the generation limit or beyond the size this tree can show, and are not shown"
  }
}

interface MemberFamilyTreeCardProps {
  memberId: string
  currentMemberPath: string
  className?: string
}

/**
 * Read-only family tree in the member page's Family section (#2253) — under
 * the family-group chips, above the billing family and parent link cards, per
 * `page.tsx`. Renders the server-derived tree as plain nested lists — no
 * tree-rendering library — with
 * CSS rails carrying the line language from the sign-off mockup: solid rail =
 * recorded parent link, dashed rail = second-parent link, double rule =
 * confirmed partner, dashed outline = derived-not-stored relationship.
 * Every node carries an sr-only sentence stating the relationship in words.
 *
 * The tree is a VIEW of the Parent Links, Dependents and Partner cards below
 * it — it offers no actions of its own, and nothing here can be edited.
 *
 * Mobile treatment: nesting is drawn with indentation, so a deep family is
 * WIDER than a phone and the card sits inside `overflow-hidden` ancestors (the
 * Family accordion item) that would otherwise clip the far side away with no
 * way to reach it. The list therefore scrolls inside its own focusable, named
 * `region` — the same pattern the #1819 contract pins for the hut-fees rate
 * table and the admin data table (WCAG 2.1.1, axe `scrollable-region-focusable`:
 * Chrome auto-focuses scrollers, Safari and Firefox do not).
 */
export function MemberFamilyTreeCard({
  memberId,
  currentMemberPath,
  className,
}: MemberFamilyTreeCardProps) {
  const [tree, setTree] = useState<MemberFamilyTree | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const headingId = useId()

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError("")
      try {
        const res = await fetch(`/api/admin/members/${memberId}/family-tree`)
        if (!res.ok) {
          if (!cancelled) setError("Failed to load the family tree")
          return
        }
        const data = (await res.json()) as MemberFamilyTree
        if (!cancelled) setTree(data)
      } catch {
        if (!cancelled) setError("Failed to load the family tree")
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [memberId])

  const hasLinks =
    tree !== null && (tree.memberCount > 1 || tree.roots.some((root) => root.children.length > 0))

  return (
    <Card className={className}>
      <CardHeader className="flex flex-col gap-2 space-y-0 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle
            id={headingId}
            className="flex flex-wrap items-center gap-2 text-base font-medium"
          >
            Family tree
            <Badge variant="secondary" className="border-border bg-muted text-foreground">
              Read-only
            </Badge>
          </CardTitle>
          {tree && hasLinks && (
            <p className="mt-1 text-xs text-muted-foreground">
              {tree.generationSpan}{" "}
              {tree.generationSpan === 1 ? "generation" : "generations"} ·{" "}
              {tree.memberCount} {tree.memberCount === 1 ? "member" : "members"}
              {tree.truncated ? ` · ${truncationNotice(tree.truncatedReason)}` : ""}
            </p>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading family tree…</p>
        ) : error ? (
          <p className="text-sm text-danger">{error}</p>
        ) : !tree ? null : !hasLinks ? (
          <p className="text-sm text-muted-foreground">
            No family links yet. Add a parent in Parent Links, or a dependant in
            Dependents, and they appear here.
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Worked out from the parent, dependant and partner links below.
              Nothing here can be edited from this card.
              {tree.hasDerivedRelationships &&
                " Relationships marked Derived are not stored anywhere — they follow from the recorded links, so they cannot be edited or disputed."}
            </p>
            {/*
              Focusable, named scroll region — see the component docstring. A
              bare `overflow-x-auto` div here would trip axe
              `scrollable-region-focusable` and strand keyboard-only admins on
              whatever a deep family pushes off the right edge.
            */}
            <div
              className="max-w-full overflow-x-auto"
              role="region"
              tabIndex={0}
              aria-labelledby={headingId}
            >
              <ul className="space-y-3">
                {tree.roots.map((node) => (
                  <FamilyTreeNodeItem
                    key={node.id}
                    node={node}
                    currentMemberPath={currentMemberPath}
                  />
                ))}
              </ul>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function FamilyTreeNodeItem({
  node,
  currentMemberPath,
}: {
  node: FamilyTreeNode
  currentMemberPath: string
}) {
  // Line language from the mockup: solid rail = recorded (primary) parent
  // link, dashed rail = second-parent link. Forest roots have no rail.
  const rail =
    node.linkToDisplayParent === "SECONDARY"
      ? "border-l-2 border-dashed border-border pl-3"
      : node.linkToDisplayParent === "PRIMARY"
        ? "border-l-2 border-border pl-3"
        : ""

  return (
    <li className={rail}>
      <span className="sr-only">{node.relationship.description}</span>
      <FamilyTreeNodeCard node={node} currentMemberPath={currentMemberPath} />
      {node.attachedPartner && (
        // Double rule = confirmed partner (mockup): the married-in partner
        // renders beside their partner rather than as a disconnected root.
        <div className="mt-2 border-l-4 border-double border-border pl-3">
          <span className="sr-only">
            {node.attachedPartner.relationship.description}
          </span>
          <FamilyTreeNodeCard
            node={node.attachedPartner}
            currentMemberPath={currentMemberPath}
          />
        </div>
      )}
      {node.children.length > 0 && (
        <ul className="ml-3 mt-2 space-y-2">
          {node.children.map((child) => (
            <FamilyTreeNodeItem
              key={child.id}
              node={child}
              currentMemberPath={currentMemberPath}
            />
          ))}
        </ul>
      )}
      {node.attachedPartner && node.attachedPartner.children.length > 0 && (
        <ul className="ml-3 mt-2 space-y-2">
          {node.attachedPartner.children.map((child) => (
            <FamilyTreeNodeItem
              key={child.id}
              node={child}
              currentMemberPath={currentMemberPath}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

function FamilyTreeNodeCard({
  node,
  currentMemberPath,
}: {
  node: FamilyTreeNode
  currentMemberPath: string
}) {
  const detailParts: string[] = []
  if (node.archived) {
    detailParts.push("Contact details hidden while archived")
  } else if (node.email) {
    detailParts.push(node.email)
  }
  if (node.emailRecipientCount > 0) {
    detailParts.push(
      `Club email for ${node.emailRecipientCount} ${
        node.emailRecipientCount === 1 ? "member" : "members"
      } in this tree`,
    )
  }
  if (node.secondParentInline) {
    detailParts.push(`Second parent: ${node.secondParentInline.name}`)
  }
  if (node.partner && !node.partner.attachedHere) {
    detailParts.push(`Confirmed partner of ${node.partner.name}`)
  }

  return (
    <div
      className={`min-w-0 rounded-md border p-2 ${
        node.relationship.derived ? "border-dashed" : "border-border"
      } ${node.isRoot ? "ring-2 ring-info" : ""}`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="break-words text-xs text-muted-foreground">
          {node.relationship.label}
          {/*
            The label alone can overstate the data — "Half-sibling" is the
            derivation's answer whenever the recorded parent sets differ, and
            with optional second-parent records that routinely means one side's
            record is simply incomplete. Say so where it is read, not only to a
            screen reader.
          */}
          {node.relationship.qualifier ? ` · ${node.relationship.qualifier}` : ""}
        </span>
        <Link
          href={buildHrefWithReturnTo(`/admin/members/${node.id}`, currentMemberPath)}
          className="break-words text-sm font-medium text-foreground underline-offset-2 hover:underline"
        >
          {node.name}
        </Link>
        {node.isRoot && (
          <Badge variant="secondary" className="border-info/20 bg-info-muted text-info">
            Viewing
          </Badge>
        )}
        {node.relationship.derived && (
          <Badge variant="secondary" className="border-dashed border-border bg-muted text-muted-foreground">
            Derived
          </Badge>
        )}
        <Badge variant="secondary">{formatAgeTierName(node.ageTier)}</Badge>
        {node.canLogin ? (
          <Badge variant="secondary" className="border-border bg-muted text-foreground">
            Can Login
          </Badge>
        ) : (
          <Badge variant="secondary" className="border-info/20 bg-info-muted text-info">
            Non-Login
          </Badge>
        )}
        {node.archived ? (
          <Badge variant="secondary" className="border-border bg-muted text-foreground">
            Archived
          </Badge>
        ) : (
          <Badge
            variant={node.active ? "default" : "destructive"}
            className={
              node.active
                ? "border-success/20 bg-success-muted text-success"
                : ""
            }
          >
            {node.active ? "Active" : "Inactive"}
          </Badge>
        )}
        {node.cancelled && (
          <Badge variant="secondary" className="border-warning/20 bg-warning-muted text-warning">
            Cancelled
          </Badge>
        )}
        {node.familyGroups.map((group) => (
          <Badge
            key={group.id}
            variant="secondary"
            className="border-cat3-6 bg-cat3-3 text-cat3-11"
          >
            {group.name || "Unnamed"}
            {group.billing ? " · billing family" : ""}
          </Badge>
        ))}
      </div>
      {node.notificationEmail && node.notificationEmail.beyondDirectParent && (
        <p className="mt-1 break-words text-xs text-warning">
          {/*
            The mailbox holder is named only when they are part of this tree.
            An inheritance source can be any member club-wide (#2255), and
            printing an unconnected member's name on a family card would assert
            a family connection nothing records — so say the fact, name nobody,
            and link nothing.
          */}
          {node.notificationEmail.inTree && node.notificationEmail.sourceName ? (
            <>
              Club email goes to {node.notificationEmail.sourceName}
              {node.notificationEmail.sourceRelationship
                ? ` · ${node.notificationEmail.sourceRelationship}`
                : ""}
            </>
          ) : (
            "Club email goes to a member outside this family tree"
          )}
        </p>
      )}
      {detailParts.length > 0 && (
        <p className="mt-1 break-words text-xs text-muted-foreground">
          {detailParts.join(" · ")}
        </p>
      )}
    </div>
  )
}
