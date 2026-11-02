FROM node:20-alpine
WORKDIR /app

COPY package.json ./
COPY index.html claim.json verify.html bridge.jpg ./
COPY portal ./portal
COPY sandbox ./sandbox
COPY scripts ./scripts

ENV NODE_ENV=production \
    SANDBOX_API_HOST=0.0.0.0 \
    SANDBOX_API_PORT=8787 \
    SANDBOX_AUDIT_FILE=/data/audit.jsonl
EXPOSE 8787

USER node
CMD ["node", "sandbox/server.mjs"]
