# Bottle Imp server + built client
FROM node:22-alpine AS build

WORKDIR /app

# Server deps
COPY package.json package-lock.json* ./
COPY shared ./shared
COPY server ./server
COPY test ./test
RUN npm install

# Client deps + build
COPY client ./client
RUN cd client && npm install && npm run build

# Runtime image
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/shared ./shared
COPY --from=build /app/server ./server
COPY --from=build /app/client/dist ./client/dist
# Empty data dir (persisted via compose volume)
RUN mkdir -p /app/data

EXPOSE 3001

# tsx runs the TypeScript server directly (plain `node` cannot load .ts,
# and tsc emits nothing under this project's noEmit tsconfig).
CMD ["npx", "tsx", "server/index.ts"]
