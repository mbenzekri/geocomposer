FROM node:24-alpine3.23

ARG GEOC_VERSION
ARG GEOC_RELEASE_BASE_URL
ARG GEOC_CONFIG_REPO
ARG GEOC_CONFIG_BRANCH

WORKDIR /app

RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    cairo-dev \
    pango-dev \
    jpeg-dev \
    giflib-dev \
    librsvg-dev \
    curl \
    tar \
    git

RUN curl -fsSL "${GEOC_RELEASE_BASE_URL}/${GEOC_VERSION}/geo-composer-${GEOC_VERSION}.tar.gz" \
    | tar -xz

RUN git clone \
    --depth 1 \
    --branch "$GEOC_CONFIG_BRANCH" \
    "$GEOC_CONFIG_REPO" \
    config

RUN rm -rf config/.git

RUN npm ci --omit=dev

EXPOSE 3000

#CMD ["/bin/sh"]
CMD ["node", "dist/geo-composer.js", "-c","/app/config/config.json" ]