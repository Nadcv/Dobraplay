FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .
ENV NODE_ENV=production PORT=3000 DB_FILE=/data/dobraplay.db
# A base de dados vive num volume para não se perder em reinícios/deploys.
VOLUME ["/data"]
EXPOSE 3000
CMD ["npm", "start"]
