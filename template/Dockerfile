FROM node:24-alpine3.23

ARG GEOC_VERSION
ARG GEOC_RELEASE_BASE_URL

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
    font-noto \
    font-noto-cjk \
    font-noto-extra

RUN curl -fsSL "${GEOC_RELEASE_BASE_URL}/${GEOC_VERSION}/geo-composer-${GEOC_VERSION}.tar.gz" \
    | tar -xz

RUN npm ci --omit=dev

COPY config.json /app/config.json
COPY styles/ /app/styles/
COPY site/ /app/site/
COPY site/ /app/site/

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "dist/geo-composer.js", "--config", "/app/config.json"]
