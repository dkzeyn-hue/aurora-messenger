# Aurora Messenger — production image
# Works on Render, Railway, Fly.io, Google Cloud Run, or any Docker host.
FROM node:20-slim

WORKDIR /app

# install production deps (better-sqlite3 ships prebuilt binaries for linux x64/arm64)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# app code
COPY server ./server
COPY public ./public

# runtime data (mount a volume here on your host to persist messages/uploads)
RUN mkdir -p /app/data /app/data/uploads
ENV DB_PATH=/app/data/aurora.db \
    UPLOADS_DIR=/app/data/uploads \
    NODE_ENV=production

EXPOSE 3000
CMD ["node", "server/index.js"]
