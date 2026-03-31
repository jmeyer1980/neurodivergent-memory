FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src

RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build

# Pre-create /data with correct ownership so named volumes at /data are writable by the node user
RUN mkdir -p /data && chown node:node /data

USER node

ENTRYPOINT ["node", "build/index.js"]