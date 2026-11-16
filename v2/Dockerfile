# pixdcon 2 container image (pixdcon2).
#
# Build from the repository root, because scenes and their helpers are shared
# with v1 and live outside v2/:
#
#   docker build -f v2/Dockerfile -t pixdcon2 .
#
# v2/Dockerfile.dockerignore keeps the build context to what is copied below.
#
# Layout in the image (src/scenes/v1-shared.js finds it by itself):
#   /app/src, /app/web, /app/node_modules     pixdcon 2
#   /app/lib, /app/scenes, /app/assets        shared with v1, unchanged
#   /app/version.json, /app/vendor            release coordinate and its presentation bundle
#   /data                                     mount a DIRECTORY here (config.json is replaced
#                                             atomically, which a single-file bind mount cannot do)
#
# Mounts on the host (edge lane and production; details in PAIMOS knowledge
# "guideline pixdcon-2-interfaces"):
#   <pixdcon2 dir>            → /data                    config.json, config.json.bak
#   <shared scenes dir>       → /data/scenes             the same scene files v1 runs
#   <shared generated dir>    → /data/generated-scenes
# At start pixdcon 2 creates /data/lib and /data/assets as links to /app/lib and
# /app/assets, so mounted scenes resolve ../../lib and ../../assets as in v1.

FROM node:24-alpine AS deps
WORKDIR /app
COPY v2/package.json v2/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY v2/package.json ./
COPY v2/src ./src
COPY v2/web ./web

# Shared with v1 and read-only for v2.
COPY lib/pixoo-image.js lib/pixoo-font.js ./lib/
COPY lib/collectors ./lib/collectors
COPY scenes ./scenes
COPY assets ./assets
COPY version.json ./
COPY vendor/inspr-versioning ./vendor/inspr-versioning

RUN mkdir -p /data

# Runtime defaults; all can be overridden. No credentials belong here:
# MOSQUITTO_PASS and the scene tokens come from the host's secret file.
ENV PIXDCON_CONFIG_PATH=/data/config.json \
    WEB_PORT=8080 \
    LOG_LEVEL=info \
    TZ=Europe/Vienna \
    MOSQUITTO_HOST=localhost \
    MQTT_PORT=1883 \
    MOSQUITTO_USER=smarthome \
    PIXDCON2_INSTANCE=pixdcon2

EXPOSE 8080

# Healthy means: the process answers and reports itself ok or degraded
# (v1 only checked that config.json was readable, matrix A-161).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEB_PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "src/main.js"]
