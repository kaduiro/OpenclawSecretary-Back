FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS base
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY tools ./tools
COPY migrations ./migrations
USER node

FROM base AS migrate
CMD ["node", "tools/migrate.mjs"]

FROM base AS runtime
EXPOSE 8080
CMD ["node", "src/api-server.js"]

FROM base AS gateway
EXPOSE 8080
CMD ["node", "src/gateway-server.js"]

FROM base AS auth-bootstrap
EXPOSE 8080
CMD ["node", "src/auth-bootstrap-server.js"]
