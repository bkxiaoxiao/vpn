FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY lib ./lib
COPY public ./public
COPY server.mjs ./
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
