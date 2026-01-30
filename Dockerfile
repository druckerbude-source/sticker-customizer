FROM node:18-alpine
RUN apk add --no-cache openssl

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
RUN npm remove @shopify/cli || true

COPY . .

# Prisma client für Runtime (falls setup es nicht macht)
RUN npx prisma generate

RUN npm run build

EXPOSE 3000

# Beim Start: setup (migrate deploy) + start
CMD ["npm", "run", "docker-start"]
