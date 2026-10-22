# agent402-tollbooth as a self-contained reverse proxy. Put it in front of any
# site: humans pass free, AI crawlers pay (USDC via x402, or free proof-of-work).
# Configure via env (see README): TOLLBOOTH_UPSTREAM, TOLLBOOTH_SECRET, TOLLBOOTH_PAYTO,
# and TOLLBOOTH_FACILITATOR_URL to actually SETTLE (x402 + MPP) - the x402
# packages are installed here so settlement mode works out of the box.
# Base pinned by digest to Node 22.23.4 (the October 2026 security release).
FROM node:22.23.4-alpine@sha256:ebc216c22db53dbde85719a874978d5aec04e6e405ad26a3804c6f9abc4ca1a9
WORKDIR /app
RUN npm init -y >/dev/null 2>&1 && npm install agent402-tollbooth@^0.8 @x402/express @x402/core @x402/evm
ENV PORT=4021
EXPOSE 4021
# Reverse-proxy mode (needs TOLLBOOTH_UPSTREAM); serves the operator dashboard at /__tollbooth.
CMD ["npx", "agent402-tollbooth"]
