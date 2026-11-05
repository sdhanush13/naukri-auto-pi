# Base image tag MUST match the exact "playwright" version in package.json (1.64.1),
# otherwise the bundled browsers will not match the library. Multi-arch: arm64 on the Pi.
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.64.1-noble

FROM ${PLAYWRIGHT_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM ${PLAYWRIGHT_IMAGE}
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NAUKRI_IN_DOCKER=1 \
    HOME=/tmp
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Overridden at runtime with --user <naukri uid>:<naukri gid>; never root.
USER pwuser
# xvfb-run (shipped in the Playwright image) provides a virtual display for browserMode "headed".
# It is harmless in headless mode. Its socket, lock and auth files go to the /tmp tmpfs, and it
# passes through the app's exit code (0/1/2).
ENTRYPOINT ["xvfb-run", "--auto-servernum", "--server-args=-screen 0 1366x900x24 -nolisten tcp", "node", "/app/dist/index.js"]
