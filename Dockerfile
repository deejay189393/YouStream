FROM node:20-alpine

WORKDIR /app

# Install production deps first so this layer caches across code changes.
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

# Railway injects PORT; server.js reads it and falls back to 3000 locally.
CMD ["node", "server.js"]
