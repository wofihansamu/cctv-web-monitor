FROM docker.io/library/node:20-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg          # enables server-side recording
COPY package.json ./
RUN npm install --omit=dev
COPY server ./server
COPY public ./public
COPY cameras.example.json ./cameras.example.json
EXPOSE 3000
CMD ["node", "server/index.js"]
