FROM golang:1.25-alpine AS bridge-builder
RUN apk add --no-cache git ca-certificates
WORKDIR /src/bridge-e2ee
COPY deplao-builder/src/bridge-e2ee/go.mod deplao-builder/src/bridge-e2ee/go.sum ./
RUN git clone --depth 1 https://github.com/mautrix/meta.git ./meta && go mod download
COPY deplao-builder/src/bridge-e2ee/ ./
RUN go mod tidy && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/fbchat-bridge-e2ee .

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3200 DATA_DIR=/app/data FBCHAT_E2EE_BIN=/app/bin/fbchat-bridge-e2ee
COPY libredesk/services/facebook-connector/package.json ./package.json
COPY libredesk/services/facebook-connector/server.js ./server.js
COPY libredesk/services/facebook-connector/supervisor.js ./supervisor.js
COPY --from=bridge-builder /out/fbchat-bridge-e2ee /app/bin/fbchat-bridge-e2ee
RUN mkdir -p /app/data /app/tmp && chown -R node:node /app
USER node
EXPOSE 3200
CMD ["node", "supervisor.js"]
