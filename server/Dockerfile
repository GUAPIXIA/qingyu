FROM node:18-slim

WORKDIR /app

COPY app/package.json ./

RUN npm install --production

COPY app/ ./

EXPOSE 3000

CMD ["node", "server.js"]
