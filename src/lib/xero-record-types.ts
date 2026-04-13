export interface XeroRecordReference {
  localModel: string
  localId: string
  label: string
  relation: string
  url: string | null
}

export interface XeroRecordBackLink {
  href: string
  label: string
}

export interface XeroRecordActivitySummary {
  totalOperations: number
  failedOperations: number
  pendingOperations: number
  partialOperations: number
  activeLinks: number
}

export interface XeroRecordActivityOperation {
  id: string
  direction: string
  entityType: string
  operationType: string
  localModel: string | null
  localId: string | null
  localUrl: string | null
  localLabel: string | null
  status: string
  idempotencyKey: string | null
  correlationKey: string | null
  attemptCount: number
  replayable: boolean
  lastErrorCode: string | null
  lastErrorMessage: string | null
  requestPayload: unknown
  responsePayload: unknown
  xeroObjectType: string | null
  xeroObjectId: string | null
  xeroObjectNumber: string | null
  xeroObjectUrl: string | null
  createdByMemberId: string | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
  supported: boolean
  reason: string | null
}

export interface XeroRecordObjectLink {
  id: string
  localModel: string
  localId: string
  localUrl: string | null
  localLabel: string | null
  xeroObjectType: string
  xeroObjectId: string
  xeroObjectNumber: string | null
  xeroObjectUrl: string | null
  role: string
  active: boolean
  metadata: unknown
  createdAt: string
  updatedAt: string
}

export interface XeroRecordActivityData {
  rootRecord: XeroRecordReference
  scopeRecords: XeroRecordReference[]
  relatedRecords: XeroRecordReference[]
  summary: XeroRecordActivitySummary
  operations: XeroRecordActivityOperation[]
  links: XeroRecordObjectLink[]
  backLink: XeroRecordBackLink | null
}
