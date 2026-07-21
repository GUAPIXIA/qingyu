FROM node:18-alpine

WORKDIR /app

COPY app/package.json app/package-lock.json* ./

RUN npm install --production

COPY app/ ./

EXPOSE 3000

CMD ["node", "server.js"]
