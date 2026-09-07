# Cloudflare Containers / Node backend
# Keep build and runtime stages separate so dev tools (esbuild) are available only while building.
FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package*.json ./

# esbuild/typescript live in devDependencies and are required to create dist/server.cjs.
RUN npm install --include=dev --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0
ENV PYTHONUNBUFFERED=1

# ffmpeg is required for media conversion. yt-dlp is installed from its current
# official release instead of Debian Bookworm's very old repository package.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates wget python3 \
  && wget -q https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp \
  && chmod 0755 /usr/local/bin/yt-dlp \
  && yt-dlp --version \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force

COPY --from=build /app/dist ./dist

RUN mkdir -p /tmp/haatlink_downloads /tmp/haatlink_cache \
  && chown -R node:node /app /tmp/haatlink_downloads /tmp/haatlink_cache

USER node
EXPOSE 8080
CMD ["node", "dist/server.cjs"]
