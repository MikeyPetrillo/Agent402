# agent402-tollbooth as a self-contained reverse proxy. Put it in front of any
# site: humans pass free, AI crawlers pay (USDC via x402, or free proof-of-work).
# Configure via env (see README): TOLLBOOTH_UPSTREAM, TOLLBOOTH_SECRET, TOLLBOOTH_PAYTO.
FROM node:20-alpine
WORKDIR /app
RUN npm init -y >/dev/null 2>&1 && npm install agent402-tollbooth@^0.2
ENV PORT=4021
EXPOSE 4021
# Reverse-proxy mode (needs TOLLBOOTH_UPSTREAM); serves the operator dashboard at /__tollbooth.
CMD ["npx", "agent402-tollbooth"]
