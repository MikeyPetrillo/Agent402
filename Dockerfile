FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npx playwright install --with-deps chromium && rm -rf /var/lib/apt/lists/*

COPY src ./src

EXPOSE 3000
CMD ["node", "src/server.js"]
