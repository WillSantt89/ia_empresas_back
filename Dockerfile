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
COPY --from=builder /build/src ./src
COPY --from=builder /build/migrations ./migrations
COPY --from=builder /build/scripts ./scripts
RUN chown -R nodejs:nodejs /app
USER nodejs
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "src/server.js"]