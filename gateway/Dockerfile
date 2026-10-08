# Supervisoor's OMP auth broker and gateway: the published packages pinned in
# gateway/package.json with this fork's packages/ai/src in place of pi-ai's, so no
# native build is needed. Keep that pin equal to packages/ai/package.json's version.
# Build from the repository root: docker build -f gateway/Dockerfile .
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
WORKDIR /opt/gateway
COPY gateway/package.json gateway/bun.lock ./
RUN bun install --frozen-lockfile
# The published pi-ai src matches its release tag; replace it with the fork's.
RUN rm -rf node_modules/@oh-my-pi/pi-ai/src
COPY packages/ai/src node_modules/@oh-my-pi/pi-ai/src
COPY gateway/start.ts ./start.ts
ENV HOME=/state
ENTRYPOINT ["bun", "/opt/gateway/start.ts"]
