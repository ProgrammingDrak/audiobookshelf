# Build context is the validated frontend-gateway/out/bundle directory, never the host workspace.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
ARG BUILD_REVISION
LABEL org.opencontainers.image.title="Audiobookshelf separate frontend" \
      org.opencontainers.image.source="https://github.com/ProgrammingDrak/audiobookshelf" \
      org.opencontainers.image.revision="${BUILD_REVISION}" \
      org.opencontainers.image.licenses="GPL-3.0-only"
WORKDIR /app
RUN apk add --no-cache zlib=1.3.2-r1
COPY --chown=node:node client/dist ./client/dist
COPY --chown=node:node frontend-gateway/server.mjs frontend-gateway/package.json ./frontend-gateway/
COPY --chown=node:node frontend-gateway/docker/healthcheck.mjs ./frontend-gateway/docker/healthcheck.mjs
COPY --chown=node:node LICENSE source.tar.gz release.json ./
RUN node -e "const fs=require('fs');const m=JSON.parse(fs.readFileSync('release.json'));if(m.revision!==process.argv[1]||!/^[a-f0-9]{40}$/.test(m.revision)||!m.clientVersion)process.exit(1)" "$BUILD_REVISION"
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn* \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 CONTAINER_MODE=1
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 CMD ["node", "frontend-gateway/docker/healthcheck.mjs"]
CMD ["node", "frontend-gateway/server.mjs"]
