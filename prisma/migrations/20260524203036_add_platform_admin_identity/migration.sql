-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'PLATFORM_ADMIN');

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "actorType" "ActorType" NOT NULL DEFAULT 'USER';

-- CreateTable
CREATE TABLE "PlatformAdmin" (
    "id" BIGSERIAL NOT NULL,
    "publicId" UUID NOT NULL DEFAULT uuidv7(),
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformAdmin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformAdminSession" (
    "id" BIGSERIAL NOT NULL,
    "token" TEXT NOT NULL,
    "adminId" BIGINT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformAdminSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformAdminLoginToken" (
    "id" BIGSERIAL NOT NULL,
    "token" TEXT NOT NULL,
    "adminId" BIGINT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformAdminLoginToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlatformAdmin_publicId_key" ON "PlatformAdmin"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformAdmin_email_key" ON "PlatformAdmin"("email");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformAdminSession_token_key" ON "PlatformAdminSession"("token");

-- CreateIndex
CREATE INDEX "PlatformAdminSession_adminId_idx" ON "PlatformAdminSession"("adminId");

-- CreateIndex
CREATE INDEX "PlatformAdminSession_expiresAt_idx" ON "PlatformAdminSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformAdminLoginToken_token_key" ON "PlatformAdminLoginToken"("token");

-- CreateIndex
CREATE INDEX "PlatformAdminLoginToken_adminId_idx" ON "PlatformAdminLoginToken"("adminId");

-- CreateIndex
CREATE INDEX "PlatformAdminLoginToken_expiresAt_idx" ON "PlatformAdminLoginToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "PlatformAdminSession" ADD CONSTRAINT "PlatformAdminSession_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "PlatformAdmin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformAdminLoginToken" ADD CONSTRAINT "PlatformAdminLoginToken_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "PlatformAdmin"("id") ON DELETE CASCADE ON UPDATE CASCADE;
