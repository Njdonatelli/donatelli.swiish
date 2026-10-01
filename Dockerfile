# Build Stage
FROM node:22-alpine AS build
WORKDIR /app

# Install git to allow branch detection
RUN apk add --no-cache git

COPY package*.json ./
COPY tailwind.config.js ./
COPY postcss.config.js ./
COPY scripts/ scripts/
RUN npm ci

COPY public/ public/
COPY src/ src/
COPY .git/ .git/

# Configure git to trust the directory (fixes dubious ownership in Docker)
RUN git config --global --add safe.directory /app

# Build the app (this triggers prebuild which runs capture-git-info.js)
RUN npm run build && rm -rf .git

# Production Stage
FROM node:22-alpine
WORKDIR /app

# Copy fonts first, then install them
COPY fonts/ ./fonts

# Install fonts for SVG text rendering in preview images
# Atkinson Hyperlegible font for improved accessibility (used in preview generation)
# Fonts are embedded in the project for reliability
RUN apk add --no-cache fontconfig \
    && mkdir -p /usr/share/fonts/opentype \
    && cp ./fonts/*.otf /usr/share/fonts/opentype/ \
    && fc-cache -f /usr/share/fonts/

COPY --from=build /app/build ./build
COPY --from=build /app/src/active-branch.json ./active-branch.json
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js .
COPY database.json .
COPY migrations/ ./migrations/
# lib/ holds the config, edition guard and admin modules; scripts/ holds the break-glass
# tools (set-password, backup-db) that must run inside this container.
COPY lib/ ./lib/
COPY scripts/ ./scripts/
# A published image is a conveyed copy of the program, so the license and notices travel with it.
COPY LICENSE COPYING NOTICE.md TRADEMARKS.md ./

# Create dirs for volumes
RUN mkdir -p data/backups uploads

EXPOSE 3000
HEALTHCHECK CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]
