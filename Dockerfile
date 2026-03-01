FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY . .

# Create data directory for config
RUN mkdir -p /data

# Default config path
ENV PIDICON_CONFIG_PATH=/data/config.json

# Run the daemon
CMD ["node", "src/index.js"]
