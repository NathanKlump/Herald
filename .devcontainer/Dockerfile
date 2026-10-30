# Matches the "node": "18.x" engine in package.json.
# ffmpeg is provided by the @ffmpeg-installer/ffmpeg npm package,
# so no system ffmpeg is needed.
FROM node:18-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
