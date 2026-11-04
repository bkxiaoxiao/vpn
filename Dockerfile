# Cloud Run's repository trigger builds with the repository root as its context.
# For a build from enterprise-server/ itself, use enterprise-server/Dockerfile.
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY enterprise-server/package.json enterprise-server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY enterprise-server/lib ./lib
COPY enterprise-server/public ./public
COPY enterprise-server/server.mjs ./
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
