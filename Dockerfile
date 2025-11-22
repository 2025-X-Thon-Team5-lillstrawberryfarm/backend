FROM node:22-alpine

WORKDIR /usr/src/app

# 1) 의존성 설치
COPY package*.json ./
RUN npm ci --omit=dev

# 2) 소스 복사
COPY . .

# 3) 타입스크립트 빌드
RUN npm run build

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# 4) 컴파일된 JS 실행
CMD ["npm", "start"]
