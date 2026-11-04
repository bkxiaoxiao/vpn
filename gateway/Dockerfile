FROM ghcr.io/sagernet/sing-box:v1.13.21 AS singbox

FROM node:22-alpine
RUN apk add --no-cache ca-certificates tini
WORKDIR /app
COPY --from=singbox /usr/local/bin/sing-box /usr/local/bin/sing-box
COPY extension/lib/subscriptions.js /app/extension/lib/subscriptions.js
COPY gateway /app/gateway
RUN mkdir -p /data
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/app/gateway/server.mjs"]
