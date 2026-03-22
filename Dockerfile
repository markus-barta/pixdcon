FROM node:20-alpine

WORKDIR /app

# Install ALL dependencies (including devDeps for Tailwind build)
COPY package*.json ./
RUN npm ci && npm cache clean --force

# Copy application source (.dockerignore excludes secrets, devenv, tests, etc.)
COPY . .

# Build Tailwind CSS (scans lib/web-server.js for used classes)
RUN npm run build:css

# Prune devDependencies for smaller runtime image
RUN npm prune --production

# Data directory is mounted at runtime; create as fallback for local runs.
# Symlink /data/lib → /app/lib so mounted scenes can resolve ../../lib/ imports.
RUN mkdir -p /data && ln -s /app/lib /data/lib && ln -s /app/assets /data/assets

# ---- Runtime defaults (all can be overridden in docker-compose) ----
ENV PIXDCON_CONFIG_PATH=/data/config.json \
    MQTT_HOST=localhost \
    MQTT_PORT=1883 \
    MQTT_USER=smarthome \
    LOG_LEVEL=info \
    TZ=Europe/Vienna \
    WEB_PORT=8080

EXPOSE 8080

# Health check: verify the node process is running and the config file is readable
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "require('fs').accessSync(process.env.PIXDCON_CONFIG_PATH || '/data/config.json', require('fs').constants.R_OK); process.exit(0);" || exit 1

CMD ["node", "src/index.js"]
