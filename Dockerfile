FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY dashboard/package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY dashboard/server.js ./
COPY dashboard/public ./public
COPY lib ./lib
COPY demo ./demo
USER node
# The server listens on $PORT (Render injects it; docker-compose sets PORT=3000; fallback 3000).
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s CMD sh -c 'wget -qO- "http://127.0.0.1:${PORT:-3000}/api/health" >/dev/null || exit 1'
CMD ["node", "server.js"]
