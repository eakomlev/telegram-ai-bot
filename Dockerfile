FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
# Optional corporate proxy CA; never copied into the runtime image.
RUN --mount=type=secret,id=npm_ca \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev \
    && mkdir /runtime && cp package*.json /runtime/ && mv dist node_modules /runtime/

FROM node:22-alpine AS runtime
# Empty selects the current release; set this build arg to pin a tested version.
ARG YT_DLP_VERSION=""
ARG GALLERY_DL_VERSION=""
ENV PATH="/opt/yt-dlp/bin:$PATH"
ENV NODE_ENV=production
WORKDIR /app
RUN --mount=type=secret,id=npm_ca \
    if [ -f /run/secrets/npm_ca ]; then \
      cat /etc/ssl/certs/ca-certificates.crt /run/secrets/npm_ca > /tmp/build-ca.pem; \
      export SSL_CERT_FILE=/tmp/build-ca.pem PIP_CERT=/tmp/build-ca.pem; \
    fi; \
    apk add --no-cache python3 py3-pip ffmpeg ca-certificates \
    && python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir "yt-dlp[default]${YT_DLP_VERSION:+==${YT_DLP_VERSION}}" "gallery-dl${GALLERY_DL_VERSION:+==${GALLERY_DL_VERSION}}" \
    && rm -f /tmp/build-ca.pem
COPY --from=build --chown=node:node /runtime ./
USER node
CMD ["node", "dist/index.js"]
