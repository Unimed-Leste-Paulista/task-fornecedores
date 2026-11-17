FROM node:24-bookworm-slim AS builder

USER root
WORKDIR /home/node/build

COPY package*.json ./
RUN npm ci

COPY . .

RUN npm run build

RUN npm prune --omit=dev

# -------------------
# STAGE 2: Runner
# -------------------
FROM node:24-bookworm-slim AS runner

RUN apt-get update && apt-get install -y libaio1 --no-install-recommends

ENV TZ="America/Sao_Paulo" \
    LD_LIBRARY_PATH=/opt/oracle/instantclient_23_7 \
    OCI_LIB_DIR=/opt/oracle/instantclient_23_7 \
    OCI_INC_DIR=/opt/oracle/instantclient_23_7/sdk/include \
    LIB_DIR=/opt/oracle/instantclient_23_7 \
    NODE_ENV="production"

WORKDIR /home/node/app

USER node

COPY --from=builder /home/node/build/package*.json ./
COPY --from=builder /home/node/build/node_modules ./node_modules
COPY --from=builder /home/node/build/dist ./dist

CMD ["node", "dist/main"]
