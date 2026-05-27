-- CreateEnum
CREATE TYPE "PasswordResetTokenType" AS ENUM ('PASSWORD_RESET', 'FIRST_LOGIN_SETUP');

-- AlterTable
ALTER TABLE "PasswordResetToken" ADD COLUMN     "type" "PasswordResetTokenType" NOT NULL DEFAULT 'PASSWORD_RESET';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
