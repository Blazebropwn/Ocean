FROM node:20-bookworm-slim AS node-build-base
RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM node-build-base AS node-deps
COPY package.json package-lock.json ./
RUN npm ci

FROM node-deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    DATABASE_PATH=/data/ocean.db \
    BACKUP_DIRECTORY=/data/backups \
    KRYPTOTRON_PYTHON=/opt/venv/bin/python

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/venv

WORKDIR /app
COPY services/kryptotron/requirements.txt /tmp/kryptotron-requirements.txt
RUN /opt/venv/bin/pip install --no-cache-dir -r /tmp/kryptotron-requirements.txt

COPY package.json package-lock.json ./
COPY --from=node-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public ./public
COPY services ./services

RUN mkdir -p /data && chmod 700 /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD curl -fsS "http://127.0.0.1:${PORT:-3000}/api/health" >/dev/null || exit 1
CMD ["npm", "start"]
