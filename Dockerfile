FROM node:24-alpine3.23

ARG GEOC_VERSION
ARG GEOC_RELEASE_BASE_URL
ARG GEOC_CONFIG_REPO
ARG GEOC_CONFIG_BRANCH

WORKDIR /app

RUN apk add --no-cache \
    cairo \
    pango \
    jpeg \
    giflib \
    librsvg \
    curl \
    tar \
    git

RUN test -n "$GEOC_VERSION" \
    && test -n "$GEOC_RELEASE_BASE_URL" \
    && test -n "$GEOC_CONFIG_REPO" \
    && test -n "$GEOC_CONFIG_BRANCH"

RUN curl -fsSL "${GEOC_RELEASE_BASE_URL}/${GEOC_VERSION}/geo-composer-${GEOC_VERSION}.tar.gz" \
    | tar -xz --strip-components=1

RUN git clone \
    --depth 1 \
    --branch "$GEOC_CONFIG_BRANCH" \
    "$GEOC_CONFIG_REPO" \
    config

RUN npm ci --omit=dev

RUN rm -rf config/.git

EXPOSE 3000

CMD ["node", "dist/geo-composer.js", "-cc"]