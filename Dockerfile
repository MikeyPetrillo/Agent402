FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json ./
# ffmpeg powers the audio tools (normalize/convert/info); installed alongside
# Chromium's deps in one layer.
RUN npm ci --omit=dev && npx playwright install --with-deps chromium \
  && apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY src ./src
# scripts/demo-payment.js is served at /demo.js (the runnable buyer demo)
COPY scripts ./scripts

EXPOSE 3000
CMD ["node", "src/server.js"]
