FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .

EXPOSE 3457

CMD ["npx", "tsx", "src/server.ts"]
