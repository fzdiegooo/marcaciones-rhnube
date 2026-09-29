# Node 24: incluye node:sqlite y fetch nativos (sin módulos nativos que compilar).
FROM node:24-alpine

WORKDIR /app

# Dependencias primero (mejor caché de capas).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Código.
COPY src ./src

# Carpeta persistente para el espejo SQLite y las cookies de sesión.
RUN mkdir -p /app/data

EXPOSE 3000
CMD ["npm", "start"]
