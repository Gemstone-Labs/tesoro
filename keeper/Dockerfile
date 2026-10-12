# Keeper image. Build from the repo root:  docker build -f keeper/Dockerfile -t tesoro-keeper .
# No key is baked in: KEEPER_SECRET_KEY, KEEPER_ORACLE_SECRET_KEY and KEEPER_EVM_PRIVATE_KEY come from the
# host's secrets at run time. .dockerignore admits only the files listed there.
FROM node:22.22.0-slim

ENV CI=1 NODE_ENV=production
RUN corepack enable && npm install -g tsx@4.23.15

WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY app/package.json app/
COPY keeper/package.json keeper/
# The keeper imports the app's chain clients (app/src), so the app's runtime dependencies are needed too.
RUN pnpm install --frozen-lockfile --prod --filter @tesoro/keeper --filter @tesoro/app && pnpm store prune

COPY app/src app/src
COPY keeper/src keeper/src

# Hosted: refuse to start without KEEPER_SECRET_KEY instead of minting a throwaway payer.
ENV KEEPER_KEYS_FROM_ENV=1 \
    KEEPER_HEALTH_PORT=8080 \
    KEEPER_STATE_DIR=/tmp/tesoro-keeper
USER node
WORKDIR /repo/keeper
CMD ["tsx", "src/index.ts"]
