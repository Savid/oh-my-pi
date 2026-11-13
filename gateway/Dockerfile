# Supervisoor's OMP auth broker and gateway: the published packages pinned in
# gateway/package.json with this fork's packages/ai/src and packages/catalog/src in
# place of pi-ai's and pi-catalog's, so no native build is needed. Keep that pin
# equal to packages/ai/package.json's version.
# Build from the repository root: docker build -f gateway/Dockerfile .
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d
WORKDIR /opt/gateway
COPY gateway/package.json gateway/bun.lock ./
RUN bun install --frozen-lockfile
# The published pi-ai and pi-catalog src match their release tag; replace them
# with the fork's.
RUN rm -rf node_modules/@oh-my-pi/pi-ai/src node_modules/@oh-my-pi/pi-catalog/src
COPY packages/ai/src node_modules/@oh-my-pi/pi-ai/src
COPY packages/catalog/src node_modules/@oh-my-pi/pi-catalog/src
COPY gateway/start.ts ./start.ts
ENV HOME=/state
ENTRYPOINT ["bun", "/opt/gateway/start.ts"]
