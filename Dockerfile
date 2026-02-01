FROM node:18-alpine
RUN apk add --no-cache openssl

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci && npm cache clean --force
RUN npm remove @shopify/cli || true

COPY . .

# Prisma client für Runtime (falls setup es nicht macht)
RUN npx prisma generate

RUN npm run build

# ✅ Startscript rein (führt migrate deploy aus und startet dann die App)
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

EXPOSE 3000

# ✅ Beim Start: prisma generate + prisma migrate deploy + npm run start
CMD ["/app/start.sh"]
