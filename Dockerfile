FROM node:24-alpine3.23

ARG GEOC_VERSION
ARG GEOC_RELEASE_BASE_URL
ARG GEOC_CONFIG_REPO
ARG GEOC_CONFIG_BRANCH

WORKDIR /app

# -- install des librairies 
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

# -- install les polices minimales 
RUN apk add --no-cache font-noto font-noto-cjk font-noto-extra

# -- install la version de geo-composer cible
RUN curl -fsSL "${GEOC_RELEASE_BASE_URL}/${GEOC_VERSION}/geo-composer-${GEOC_VERSION}.tar.gz" | tar -xz

# -- install la branche de config à deployer
RUN git clone --depth 1 --branch "$GEOC_CONFIG_BRANCH" "$GEOC_CONFIG_REPO"  config

RUN rm -rf config/.git

RUN npm ci --omit=dev

EXPOSE 3000

#CMD ["/bin/sh"]
CMD ["node", "dist/geo-composer.js", "-c","/app/config/config.json" ]
