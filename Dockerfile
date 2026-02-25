FROM node:20-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /build
COPY backend/package.json ./
RUN npm install
COPY backend/ ./

FROM node:20-alpine
RUN apk add --no-cache tini
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
WORKDIR /app
COPY backend/package.json ./
RUN npm install --omit=dev && npm cache clean --force
# Copy all source files preserving directory structure
COPY --from=builder /build/src ./src
COPY --from=builder /build/migrations ./migrations
COPY --from=builder /build/scripts ./scripts
# Copy debug servers
COPY --from=builder /build/debug-server.js ./debug-server.js
COPY --from=builder /build/test-server.js ./test-server.js
COPY --from=builder /build/simple-server.js ./simple-server.js
RUN chown -R nodejs:nodejs /app
USER nodejs
EXPOSE 3001
ENTRYPOINT ["/sbin/tini", "--"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
# Use simple server for now
CMD ["node", "simple-server.js"]