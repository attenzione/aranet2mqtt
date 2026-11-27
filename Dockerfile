# syntax=docker/dockerfile:1
#
# aranet2mqtt: upstream `aranet` CLI (Bluetooth) + translator + web UI, one image.
#
# Build on an arm64 machine (or with buildx --platform linux/arm64):
#   docker build -t aranet2mqtt:dev .
#
# Bluetooth needs a Linux host running BlueZ, with its /run/dbus mounted
# read-only (-v /run/dbus:/run/dbus:ro). See README.md.

# Upstream cameronrye/aranet, unmodified. Bump deliberately: it is a 0.x project.
ARG ARANET_REPO=https://github.com/cameronrye/aranet.git
ARG ARANET_REF=e6410de96e2189dbda436c917f25863ff55d8e8d

# ---------------------------------------------------------------------------
# 1. The upstream `aranet` CLI, without the terminal dashboard or desktop GUI.
FROM rust:1.99-alpine AS aranet-cli
ARG ARANET_REPO
ARG ARANET_REF
RUN apk add --no-cache musl-dev pkgconf dbus-dev openssl-dev
ADD --keep-git-dir=false ${ARANET_REPO}#${ARANET_REF} /src
WORKDIR /src
# Rust links musl binaries statically by default; libdbus has no static
# library on Alpine, so link dynamically against the image's dbus-libs.
ENV RUSTFLAGS="-C target-feature=-crt-static"
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p aranet-cli --no-default-features --features cli \
    && cp target/release/aranet /usr/local/bin/aranet

# ---------------------------------------------------------------------------
# 2. Node dependencies and the build.
FROM node:26-alpine AS node-base
RUN npm install -g pnpm@11.22.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM node-base AS deps
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --prod --frozen-lockfile

FROM node-base AS build
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY ui ./ui
RUN pnpm build

# ---------------------------------------------------------------------------
# 3. The image: Node, the aranet binary, the built app.
FROM node:26-alpine
ARG ARANET_REF
# dbus-libs: the aranet binary talks to BlueZ over the system D-Bus.
# libgcc: unwinding for the dynamically linked Rust binary.
# npm, npx, corepack and yarn go: the app never runs them, and their bundled
# packages were most of the image's fixable vulnerabilities.
RUN apk upgrade --no-cache \
    && apk add --no-cache dbus-libs libgcc tini \
    && rm -rf /usr/local/lib/node_modules /opt/yarn-* \
        /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
        /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=aranet-cli /usr/local/bin/aranet /usr/local/bin/aranet
WORKDIR /app
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# HOME: the aranet CLI looks for its own (unused) config there.
ENV NODE_ENV=production \
    ARANET2MQTT_DATA=/data \
    ARANET_REF=${ARANET_REF} \
    HOME=/tmp
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.ARANET2MQTT_PORT||8080}/api/health`).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# tini forwards SIGTERM to Node and reaps the aranet child processes.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server/main.js"]
