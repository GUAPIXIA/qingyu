FROM node:22-slim

WORKDIR /app

# npmmirror 预构建源（better-sqlite3 等 native 依赖走国内镜像）
COPY .npmrc ./

COPY app/package.json ./

RUN npm install --production

COPY app/ ./

EXPOSE 3000

CMD ["node", "server.js"]
