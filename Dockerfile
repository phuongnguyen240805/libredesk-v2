# =========================
# Build stage
# =========================
FROM golang:1.25-alpine AS builder

RUN apk add --no-cache \
    make \
    git \
    nodejs \
    npm

RUN npm install -g pnpm@9.15.3

RUN node --version && pnpm --version && go version

WORKDIR /src

COPY . .

RUN make


# =========================
# Runtime stage
# =========================
FROM alpine:3.18

RUN apk --no-cache add \
    ca-certificates \
    tzdata

WORKDIR /libredesk

COPY --from=builder /src/libredesk ./libredesk
COPY --from=builder /src/config.sample.toml ./config.toml

EXPOSE 9000

CMD ["sh", "-c", "./libredesk --install --idempotent-install --yes --config /libredesk/config.toml && ./libredesk --upgrade --yes --config /libredesk/config.toml && exec ./libredesk --config /libredesk/config.toml"]