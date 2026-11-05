FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright PORT=8080
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev \
 && npx playwright install --with-deps chromium \
 && npm i -g @github/copilot \
 && chmod -R a+rX /ms-playwright \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/server/index.js"]
