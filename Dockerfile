FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

EXPOSE 8080
CMD ["node", "src/server.mjs"]
