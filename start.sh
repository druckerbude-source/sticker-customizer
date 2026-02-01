#!/usr/bin/env sh
set -e

echo "==> Prisma generate"
npx prisma generate

echo "==> Prisma migrate deploy"
npx prisma migrate deploy

echo "==> Start app"
npm run start