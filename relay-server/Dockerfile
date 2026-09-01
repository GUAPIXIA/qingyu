FROM node:22-alpine AS build
WORKDIR /app/relay-server
COPY relay-server/package.json relay-server/pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --ignore-scripts
COPY shared /app/shared
COPY relay-server/tsconfig.json ./tsconfig.json
COPY relay-server/src ./src
COPY relay-server/test ./test
RUN pnpm build && pnpm prune --prod --ignore-scripts

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/relay-server/node_modules ./relay-server/node_modules
COPY --from=build /app/relay-server/dist ./relay-server/dist
COPY relay-server/migrations ./relay-server/migrations
USER node
EXPOSE 3100
CMD ["node", "relay-server/dist/relay-server/src/server.js"]
