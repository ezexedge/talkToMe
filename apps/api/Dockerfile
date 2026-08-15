# Dockerfile del API (NestJS).
#
# IMPORTANTE: el contexto de build es la RAÍZ del monorepo, no esta carpeta.
# Turborepo usa npm workspaces, así que el package-lock.json y la resolución de
# dependencias viven arriba. Construir desde apps/api dejaría afuera el lock y
# npm reinstalaría con versiones distintas a las del repo.
#   docker build -f apps/api/Dockerfile .

# ---------- build ----------
FROM node:20-alpine AS builder
WORKDIR /repo

# Primero SOLO los manifiestos: si no cambian, Docker reutiliza la capa de
# node_modules y el build siguiente no reinstala nada.
COPY package.json package-lock.json turbo.json ./
COPY apps/api/package.json apps/api/

RUN npm ci --workspace=api --include-workspace-root

# Ahora sí el código.
COPY apps/api apps/api

RUN npm run build --workspace=api

# ---------- runtime ----------
FROM node:20-alpine AS runner
WORKDIR /repo

ENV NODE_ENV=production

# Solo dependencias de producción: la imagen final no necesita el compilador de
# TypeScript ni las herramientas de test.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci --workspace=api --include-workspace-root --omit=dev

COPY --from=builder /repo/apps/api/dist apps/api/dist

# Usuario sin privilegios: si alguien logra ejecutar algo dentro del
# contenedor, no lo hace como root.
USER node

EXPOSE 3000

# `node` directo y NO `npm start`: npm no reenvía SIGTERM a su hijo, así que el
# graceful shutdown nunca correría y cada deploy cortaría las llamadas de golpe.
CMD ["node", "apps/api/dist/main.js"]
