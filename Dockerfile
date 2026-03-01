FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY workers ./workers

EXPOSE 8080
CMD ["node", "workers/uk_aq_prune_daily/server.mjs"]
