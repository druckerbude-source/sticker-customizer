FROM node:18-alpine
RUN apk add --no-cache openssl

WORKDIR /app
ENV NODE_ENV=production

# Copy only deps first (better caching)
COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force

# Optional: remove Shopify CLI in prod image
RUN npm remove @shopify/cli || true

# Copy the rest
COPY . .

# ✅ Prisma client (needed if you use Prisma at runtime)
RUN npx prisma generate

# ✅ Build Remix app
RUN npm run build

# Render provides PORT env var; app must listen on it
EXPOSE 3000

# ✅ Run migrations then start
CMD ["sh", "-c", "npx prisma migrate deploy && npm run docker-start"]
