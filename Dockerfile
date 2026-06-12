# Smart Money Tracker — panel web + scheduler interno
FROM node:22-bookworm-slim

# better-sqlite3 usa prebuilds para linux x64; build tools por si toca compilar
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npx tsc --noEmit

# Railway inyecta PORT; DATA_DIR/OUTPUT_DIR deben apuntar al volumen montado
ENV NODE_ENV=production
EXPOSE 3000

CMD ["npx", "tsx", "src/server/index.ts"]
