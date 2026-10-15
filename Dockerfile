FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src
COPY tsconfig.json ./

EXPOSE 8788
CMD ["npx", "tsx", "src/server.ts"]