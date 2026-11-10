"use client"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { buildXeroContactUrl } from "@/lib/xero-links"
import { SyncReportView } from "./shared"
import type { SyncResult } from "./types"

// #2108: cap the membership-type detail lists so a large import never renders
// thousands of rows; the full picture is on the summary audit row.
const IMPORT_LIST_CAP = 20

export function SyncResultsPanel({
  syncResult,
  shortCode,
  currentXeroPath,
}: {
  syncResult: SyncResult | null
  /**
   * Organisation short code for the "Open in Xero" links, or null when
   * unavailable — the links then degrade to the generic session-scoped Xero
   * URL, they are never hidden (#2283).
   */
  shortCode: string | null
  currentXeroPath: string
}) {
  if (!syncResult) return null
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>Results</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2 text-sm">
          {syncResult.message ? <p>{syncResult.message}</p> : null}
          {syncResult.created !== undefined ? (
            <>
              <p>
                <span className="text-muted-foreground">New members created:</span>{" "}
                <span className="font-medium text-success">{syncResult.created}</span>
              </p>
              {syncResult.createdMembers && syncResult.createdMembers.length > 0 ? (
                <ul className="ml-4 mt-1 space-y-0.5 text-sm">
                  {syncResult.createdMembers.map((member, index) => (
                    <li key={`${member.xeroContactId}-${index}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span>{member.name}</span>
                      <span className="text-xs text-muted-foreground">{member.email}</span>
                      <Badge variant="outline" className="text-xs">{member.group}</Badge>
                      <a href={buildXeroContactUrl(member.xeroContactId, { shortCode })} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">Open in Xero</a>
                    </li>
                  ))}
                </ul>
              ) : null}
              {syncResult.createdAsDependent !== undefined && syncResult.createdAsDependent > 0 ? (
                <div>
                  <p>
                    <span className="text-muted-foreground">Family dependents created:</span>{" "}
                    <span className="font-medium text-info">{syncResult.createdAsDependent}</span>
                  </p>
                  {syncResult.createdDependents && syncResult.createdDependents.length > 0 ? (
                    <ul className="ml-4 mt-1 space-y-0.5 text-sm">
                      {syncResult.createdDependents.map((member, index) => (
                        <li key={`${member.xeroContactId}-${index}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span>{member.name}</span>
                          <span className="text-xs text-muted-foreground">{member.email}</span>
                          <Badge variant="outline" className="text-xs">{member.group}</Badge>
                          <span className="text-xs text-muted-foreground">Linked to {member.parentName}</span>
                          <a href={buildXeroContactUrl(member.xeroContactId, { shortCode })} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">Open in Xero</a>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
              {syncResult.skippedExisting !== undefined && syncResult.skippedExisting > 0 ? (
                <p><span className="text-muted-foreground">Skipped (already exist):</span> {syncResult.skippedExisting}</p>
              ) : null}
              {syncResult.linkedExisting !== undefined && syncResult.linkedExisting > 0 ? (
                <div>
                  <p><span className="text-muted-foreground">Existing members linked to Xero:</span> {syncResult.linkedExisting}</p>
                  {syncResult.linkedExistingDetails && syncResult.linkedExistingDetails.length > 0 ? (
                    <ul className="ml-4 mt-1 space-y-0.5 text-sm">
                      {syncResult.linkedExistingDetails.map((member, index) => (
                        <li key={`${member.memberId}-${member.xeroContactId}-${index}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span>{member.name}</span>
                          <span className="text-xs text-muted-foreground">{member.email}</span>
                          <Badge variant="outline" className="text-xs">{member.group}</Badge>
                          <a href={buildXeroContactUrl(member.xeroContactId, { shortCode })} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">Open in Xero</a>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
              {syncResult.skippedNoEmail !== undefined && syncResult.skippedNoEmail > 0 ? (
                <div>
                  <p><span className="text-muted-foreground">Skipped (no email):</span> {syncResult.skippedNoEmail}</p>
                  {syncResult.skippedNoEmailDetails && syncResult.skippedNoEmailDetails.length > 0 ? (
                    <ul className="ml-4 mt-1 space-y-0.5 text-sm">
                      {syncResult.skippedNoEmailDetails.map((contact, index) => (
                        <li key={`${contact.xeroContactId}-${index}`} className="flex items-center gap-2">
                          <span>{contact.name}</span>
                          <a href={buildXeroContactUrl(contact.xeroContactId, { shortCode })} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">Open in Xero</a>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
              {syncResult.skippedArchived !== undefined && syncResult.skippedArchived > 0 ? (
                <div>
                  <p><span className="text-muted-foreground">Skipped (not active in Xero):</span> {syncResult.skippedArchived}</p>
                  {syncResult.skippedArchivedDetails && syncResult.skippedArchivedDetails.length > 0 ? (
                    <ul className="ml-4 mt-1 space-y-0.5 text-sm">
                      {syncResult.skippedArchivedDetails.map((contact, index) => (
                        <li key={`${contact.xeroContactId}-${index}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span>{contact.name}</span>
                          <Badge variant="outline" className="text-xs">{contact.group}</Badge>
                          {contact.reason ? <span className="text-xs text-muted-foreground">{contact.reason}</span> : null}
                          <a href={buildXeroContactUrl(contact.xeroContactId, { shortCode })} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">Open in Xero</a>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
              {syncResult.groupsProcessed && syncResult.groupsProcessed.length > 0 ? (
                <p><span className="text-muted-foreground">Groups processed:</span> {syncResult.groupsProcessed.join(", ")}</p>
              ) : null}
              {/* #2108: membership-type import outcomes. */}
              {syncResult.assignmentsCreated !== undefined && syncResult.assignmentsCreated > 0 ? (
                <p>
                  <span className="text-muted-foreground">Membership type assignments created:</span>{" "}
                  <span className="font-medium text-success">{syncResult.assignmentsCreated}</span>
                </p>
              ) : null}
              {syncResult.keptExistingAssignments && syncResult.keptExistingAssignments.length > 0 ? (
                <div>
                  <p>
                    <span className="text-muted-foreground">Existing assignments kept (not overwritten):</span>{" "}
                    <span className="font-medium text-warning">{syncResult.keptExistingAssignments.length}</span>
                  </p>
                  <ul className="ml-4 mt-1 space-y-0.5 text-sm">
                    {syncResult.keptExistingAssignments.slice(0, IMPORT_LIST_CAP).map((kept, index) => (
                      <li key={`${kept.memberId}-${index}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span>{kept.name}</span>
                        <Badge variant="outline" className="text-xs">{kept.group}</Badge>
                        {kept.sameType ? (
                          <span className="text-xs text-muted-foreground">
                            already on {kept.existingMembershipTypeName ?? "this type"}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            kept {kept.existingMembershipTypeName ?? "existing type"} — attempted {kept.attemptedMembershipTypeName ?? "new type"}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                  {syncResult.keptExistingAssignments.length > IMPORT_LIST_CAP ? (
                    <p className="ml-4 text-xs text-muted-foreground">
                      +{syncResult.keptExistingAssignments.length - IMPORT_LIST_CAP} more
                    </p>
                  ) : null}
                  {syncResult.keptExistingAssignments.some((kept) => !kept.sameType) ? (
                    <p className="ml-4 text-xs text-muted-foreground">
                      To change a member kept on a different type, use Members → bulk membership type.
                    </p>
                  ) : null}
                </div>
              ) : null}
              {syncResult.droppedDuplicates && syncResult.droppedDuplicates.length > 0 ? (
                <div>
                  <p>
                    <span className="text-muted-foreground">Duplicate contacts dropped (first group wins):</span>{" "}
                    <span className="font-medium">{syncResult.droppedDuplicates.length}</span>
                  </p>
                  <ul className="ml-4 mt-1 space-y-0.5 text-sm">
                    {syncResult.droppedDuplicates.slice(0, IMPORT_LIST_CAP).map((dropped, index) => (
                      <li key={`${dropped.xeroContactId}-${index}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span>{dropped.name}</span>
                        <span className="text-xs text-muted-foreground">
                          in <span className="font-medium">{dropped.group}</span> — kept in <span className="font-medium">{dropped.keptGroup}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                  {syncResult.droppedDuplicates.length > IMPORT_LIST_CAP ? (
                    <p className="ml-4 text-xs text-muted-foreground">
                      +{syncResult.droppedDuplicates.length - IMPORT_LIST_CAP} more
                    </p>
                  ) : null}
                </div>
              ) : null}
              {syncResult.memberCollisions && syncResult.memberCollisions.length > 0 ? (
                <div>
                  <p>
                    <span className="text-muted-foreground">Member mapping collisions (first group wins):</span>{" "}
                    <span className="font-medium text-warning">{syncResult.memberCollisions.length}</span>
                  </p>
                  <ul className="ml-4 mt-1 space-y-0.5 text-sm">
                    {syncResult.memberCollisions.slice(0, IMPORT_LIST_CAP).map((collision, index) => (
                      <li key={`${collision.memberId}-${index}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span>{collision.name}</span>
                        <span className="text-xs text-muted-foreground">
                          kept mapping from <span className="font-medium">{collision.keptGroup}</span> — dropped <span className="font-medium">{collision.droppedGroup}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                  {syncResult.memberCollisions.length > IMPORT_LIST_CAP ? (
                    <p className="ml-4 text-xs text-muted-foreground">
                      +{syncResult.memberCollisions.length - IMPORT_LIST_CAP} more
                    </p>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
          {syncResult.syncReport ? <SyncReportView report={syncResult.syncReport} shortCode={shortCode} returnTo={currentXeroPath} /> : null}
          {syncResult.checked !== undefined ? (
            <>
              <p><span className="text-muted-foreground">Members checked:</span> {syncResult.checked}</p>
              {syncResult.checked === 0 ? <p className="text-warning">No members with linked Xero contacts found. Use the setup tools below to import and link members first.</p> : null}
            </>
          ) : null}
          {syncResult.errors !== undefined && syncResult.errors > 0 ? (
            <div className="text-danger">
              <p><span className="text-muted-foreground">Errors:</span> {syncResult.errors}</p>
              {syncResult.errorDetails && syncResult.errorDetails.length > 0 ? (
                <ul className="mt-2 list-inside list-disc space-y-1 text-sm">
                  {syncResult.errorDetails.map((detail, index) => (
                    <li key={`${detail.member}-${index}`}><span className="font-medium">{detail.member}</span>: {detail.error}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}
