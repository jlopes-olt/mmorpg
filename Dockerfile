FROM node:22-alpine

WORKDIR /app

COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV STATE_FILE=/app/server/data/state.json

RUN mkdir -p /app/server/data

EXPOSE 3000

CMD ["node", "server/index.js"]
