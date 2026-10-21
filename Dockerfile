# n8n Vault — secure version history for self-hosted n8n
FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY inject ./inject

# Run as a non-root user; /app/data holds the SQLite database.
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV DATA_DIR=/app/data

EXPOSE 3444
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3444)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
