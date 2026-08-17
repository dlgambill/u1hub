# U1 Print Hub — small runtime image for always-on hosts (Raspberry Pi, NAS,
# homelab boxes). Runs the same Node/Express server as the desktop builds.
FROM node:22-alpine

WORKDIR /app

# The container only needs the runtime dependency (express). @yao-pkg/pkg is a
# build-time-only tool CI uses to make the desktop binaries, so drop it here to
# keep the image small.
COPY package.json ./
RUN npm pkg delete devDependencies \
 && npm install --omit=dev \
 && npm cache clean --force

# App source. (Issue #1 fix: auth.js, fs-colors.js and tunnel.js were missing
# from this COPY list, which broke the Docker install path on Pi/NAS while the
# pkg binaries — which bundle everything — kept working. Every server-side
# module server.js require()s MUST be listed here; rfid.js + the filament
# snapshot + scripts/ are the v2.9 additions.)
COPY server.js parser.js auth.js fs-colors.js tunnel.js rfid.js filament-swatches.json ./
COPY scripts ./scripts
COPY public ./public

# config.json and gcode/ are expected to be mounted as volumes (see
# docker-compose.yml). The server creates sane defaults if they're absent.
EXPOSE 4545
CMD ["node", "server.js"]
