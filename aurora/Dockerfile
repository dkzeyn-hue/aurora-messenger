# Aurora Messenger — production image
# Works on Render, Railway, Fly.io, Google Cloud Run, or any Docker host.
FROM node:20-slim

WORKDIR /app

# Install deps: python3/make/g++ are required when better-sqlite3 has no
# prebuilt binary for the platform and node-gyp compiles it from source.
# The toolchain is purged again in the same layer after npm ci so the
# final image stays small (runtime never needs to compile anything).
COPY package.json package-lock.json ./
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && npm ci --omit=dev \
 && apt-get purge -y --auto-remove python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

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
