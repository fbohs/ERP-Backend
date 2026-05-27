/*
  Warnings:

  - You are about to drop the column `token` on the `PlatformAdminLoginToken` table. All the data in the column will be lost.
  - You are about to drop the column `usedAt` on the `PlatformAdminLoginToken` table. All the data in the column will be lost.
  - You are about to drop the column `token` on the `PlatformAdminSession` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[tokenHash]` on the table `PlatformAdminLoginToken` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tokenHash]` on the table `PlatformAdminSession` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `tokenHash` to the `PlatformAdminLoginToken` table without a default value. This is not possible if the table is not empty.
  - Added the required column `tokenHash` to the `PlatformAdminSession` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "PlatformAdminLoginToken_token_key";

-- DropIndex
DROP INDEX "PlatformAdminSession_token_key";

-- AlterTable
ALTER TABLE "PlatformAdminLoginToken" DROP COLUMN "token",
DROP COLUMN "usedAt",
ADD COLUMN     "tokenHash" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "PlatformAdminSession" DROP COLUMN "token",
ADD COLUMN     "ipAddress" TEXT,
ADD COLUMN     "tokenHash" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "PlatformAuditLog" (
    "id" BIGSERIAL NOT NULL,
    "adminId" BIGINT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ipAddress" TEXT,
    "requestId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlatformAuditLog_adminId_occurredAt_idx" ON "PlatformAuditLog"("adminId", "occurredAt");

-- CreateIndex
CREATE INDEX "PlatformAuditLog_action_occurredAt_idx" ON "PlatformAuditLog"("action", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformAdminLoginToken_tokenHash_key" ON "PlatformAdminLoginToken"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformAdminSession_tokenHash_key" ON "PlatformAdminSession"("tokenHash");
