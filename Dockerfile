FROM node:20-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /build
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/ ./
# Remove dev dependencies after full install (native modules already compiled)
RUN npm prune --omit=dev

FROM node:20-alpine
ENV TZ=America/Sao_Paulo
RUN apk add --no-cache tini ffmpeg tzdata
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
WORKDIR /app
# Copy pre-compiled node_modules from builder (includes native bcrypt binary)
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./
# Copy all source files preserving directory structure
COPY --from=builder /build/src ./src
COPY --from=builder /build/migrations ./migrations
COPY --from=builder /build/scripts ./scripts
# Create uploads directory for media storage
RUN mkdir -p /app/uploads
RUN chown -R nodejs:nodejs /app
USER nodejs
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
# Start the real server
CMD ["node", "src/server.js"]
