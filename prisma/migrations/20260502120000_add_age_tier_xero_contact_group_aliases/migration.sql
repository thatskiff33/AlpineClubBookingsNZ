CREATE TABLE "AgeTierXeroAcceptedContactGroup" (
  "id" TEXT NOT NULL,
  "ageTierSettingId" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "groupName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AgeTierXeroAcceptedContactGroup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgeTierXeroAcceptedContactGroup_groupId_key"
ON "AgeTierXeroAcceptedContactGroup"("groupId");

CREATE INDEX "AgeTierXeroAcceptedContactGroup_ageTierSettingId_idx"
ON "AgeTierXeroAcceptedContactGroup"("ageTierSettingId");

ALTER TABLE "AgeTierXeroAcceptedContactGroup"
ADD CONSTRAINT "AgeTierXeroAcceptedContactGroup_ageTierSettingId_fkey"
FOREIGN KEY ("ageTierSettingId") REFERENCES "AgeTierSetting"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;
