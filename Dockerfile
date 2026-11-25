# NodeGSM headless (web mode) image. Build: docker build -t nodegsm .   Run: see docker-compose.example.yml
# Game servers run INSIDE this container. SteamCMD needs the 32-bit runtime libraries, installed below.
FROM node:20-slim

ENV NODE_ENV=production \
    NODEGSM_DATA=/data \
    NODEGSM_HOST=0.0.0.0 \
    NODEGSM_PORT=8730 \
    NODEGSM_HTTPS=0

RUN dpkg --add-architecture i386 \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tar lib32gcc-s1 lib32stdc++6 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY plugins ./plugins
COPY assets ./assets

# non-root user; /data holds settings, servers, backups and the access token (mount a volume here)
RUN useradd --create-home --uid 10001 nodegsm && mkdir -p /data && chown -R nodegsm:nodegsm /data /app
USER nodegsm
VOLUME ["/data"]
EXPOSE 8730

# /healthz is unauthenticated and returns only {"ok":true}
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.NODEGSM_PORT||8730,path:'/healthz',timeout:4000},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Binding 0.0.0.0 inside the container is fine: publish the port on 127.0.0.1 only (see the compose file) and use a TLS reverse proxy.
CMD ["node", "src/server/headless.js"]
