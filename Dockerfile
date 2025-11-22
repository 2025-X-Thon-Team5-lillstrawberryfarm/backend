FROM node:22-alpine

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci   # ← devDependencies까지 전부 설치

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]

