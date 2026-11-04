FROM golang:1.26.7-bookworm AS core
ENV CGO_ENABLED=0
RUN go install -trimpath -tags 'with_quic,with_utls,with_v2ray_api' github.com/sagernet/sing-box/cmd/sing-box@v1.13.21
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir /data && chown node:node /data
COPY --from=core /go/bin/sing-box /usr/local/bin/sing-box
COPY collector ./collector
USER node
ENV COLLECTOR_STATE=/data/collector.local.json CORE_CONFIG=/data/core.local.json
CMD ["node", "collector/agent.mjs"]
