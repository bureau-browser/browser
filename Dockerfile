FROM node:20-slim

# Pinned Camoufox version for reproducible builds
# Update these when upgrading Camoufox
ARG CAMOUFOX_VERSION=135.0.1
ARG CAMOUFOX_RELEASE=beta.24
ARG ARCH=x86_64

# Run as a non-root user (uid 1001) to match the cluster securityContext
# (runAsNonRoot / runAsUser: 1001). Camoufox resolves its binary cache
# (~/.cache/camoufox) and cookie dir (~/.camofox) via $HOME / os.homedir(),
# so give 1001 a real, writable home and bake the browser cache THERE —
# /root is mode 700 and a non-root uid can't traverse it, which is what
# broke stealth on the new cluster (legacy k8s ran as root and worked).
ENV HOME=/home/camofox
RUN groupadd -g 1001 camofox \
    && useradd -u 1001 -g 1001 -m -d /home/camofox -s /usr/sbin/nologin camofox

# Install dependencies for Camoufox (Firefox-based)
RUN apt-get update && apt-get install -y \
    # Firefox dependencies
    libgtk-3-0 \
    libdbus-glib-1-2 \
    libxt6 \
    libasound2 \
    libx11-xcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    # Mesa OpenGL/EGL for WebGL support (software rendering via llvmpipe)
    # Without these, Firefox cannot create WebGL contexts — a major bot detection signal
    libegl1-mesa \
    libgl1-mesa-dri \
    libgbm1 \
    # Xvfb virtual display — runs Camoufox as if on a real desktop (better anti-detection)
    xvfb \
    # Fonts
    fonts-liberation \
    fonts-noto-color-emoji \
    fontconfig \
    # Utils
    ca-certificates \
    unzip \
    # yt-dlp runtime dependency
    python3-minimal \
    # ffmpeg for x11grab screen recording (the Playwright-Firefox video
    # path doesn't work on Camoufox, so we record the Xvfb display
    # directly — see `recordVideo` branch in server.js).
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Pre-bake Camoufox browser binary into image via bind mount (downloaded by Makefile)
# Note: unzip returns exit code 1 for warnings (Unicode filenames), so we use || true and verify
RUN --mount=type=bind,source=dist,target=/dist \
    mkdir -p "$HOME/.cache/camoufox" \
    && (unzip -q /dist/camoufox-${ARCH}.zip -d "$HOME/.cache/camoufox" || true) \
    && echo "{\"version\":\"${CAMOUFOX_VERSION}\",\"release\":\"${CAMOUFOX_RELEASE}\"}" > "$HOME/.cache/camoufox/version.json" \
    && test -f "$HOME/.cache/camoufox/camoufox-bin" && echo "Camoufox installed successfully" \
    && chown -R 1001:1001 "$HOME/.cache" \
    && chmod -R 755 "$HOME/.cache/camoufox"

# Install yt-dlp for YouTube transcript extraction (no browser needed)
RUN --mount=type=bind,source=dist,target=/dist \
    install -m 755 /dist/yt-dlp-${ARCH} /usr/local/bin/yt-dlp

WORKDIR /app

COPY package.json ./
# better-sqlite3 builds a native addon during install. node-gyp finds
# python via the python3-minimal installed above, but still needs a
# C/C++ toolchain (make + g++). Install them for the build, then purge
# so they don't bloat the runtime image. python3-minimal is left intact
# (yt-dlp depends on it).
RUN apt-get update \
    && apt-get install -y --no-install-recommends make g++ \
    && npm install --production \
    && apt-get purge -y --auto-remove make g++ \
    && rm -rf /var/lib/apt/lists/*

# Playwright ffmpeg binary — required for `page.video()` / recordVideo
# contexts. Without this, any newContext({ recordVideo }) call fails with
# "Executable doesn't exist at $HOME/.cache/ms-playwright/ffmpeg-XXXX/ffmpeg-linux".
# Installs under $HOME (=/home/camofox) since HOME is set above; chown so the
# non-root runtime user can read it. Only the ffmpeg helper is installed (not
# the Playwright browsers, which Camoufox ships separately).
RUN npx playwright install ffmpeg \
    && chown -R 1001:1001 "$HOME/.cache"

COPY server.js ./
COPY lib/ ./lib/

# /app is owned by root from the COPY/npm steps (world-readable, fine). The
# runtime user only needs to WRITE under $HOME (cookies, mozilla profile,
# Xvfb) — hand that to 1001 and drop to the non-root user.
RUN chown -R 1001:1001 /home/camofox
USER camofox

ENV NODE_ENV=production
ENV CAMOFOX_PORT=3000

EXPOSE 9377

CMD ["sh", "-c", "node --max-old-space-size=${MAX_OLD_SPACE_SIZE:-128} server.js"]
