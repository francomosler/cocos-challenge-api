FROM node:26-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Node 26 ejecuta TypeScript de forma nativa: no hay paso de build.
COPY src ./src
COPY scripts ./scripts
COPY db ./db

USER node
EXPOSE 3000
CMD ["node", "src/server.ts"]
