FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

# SQLite index lives here; mount a volume so it survives upgrades.
ENV JUPITER_DB=/app/data/jupiter.db
ENV PORT=7000
VOLUME ["/app/data"]
EXPOSE 7000

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:7000/manifest.json >/dev/null || exit 1

CMD ["node", "src/server.js"]
