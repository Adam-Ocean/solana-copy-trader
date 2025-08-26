# Multi-stage build for optimized image
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY dashboard-v2/package*.json ./dashboard-v2/

# Install dependencies
RUN npm ci --only=production
RUN cd dashboard-v2 && npm ci --only=production

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Build Next.js dashboard
RUN cd dashboard-v2 && npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Copy built application
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dashboard-v2/.next ./dashboard-v2/.next
COPY --from=builder /app/dashboard-v2/node_modules ./dashboard-v2/node_modules
COPY --from=builder /app/dashboard-v2/public ./dashboard-v2/public
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/dashboard-v2/package*.json ./dashboard-v2/

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

USER nodejs

# Expose ports
EXPOSE 4789 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:4789/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Start with signal handling
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]