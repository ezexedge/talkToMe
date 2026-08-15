# MVP — Llamadas de solo audio (WebRTC + SSE + Redis Pub/Sub)

Monorepo Turborepo con dos apps:

- **`apps/front`** → React (Vite). Cliente de la llamada.
- **`apps/api`** → NestJS. Servidor de **señalización** (no transporta el audio).

El audio va **directo entre navegadores por WebRTC**. NestJS solo intercambia
los mensajes de señalización (offer/answer/ICE). Soporta **muchas rooms 1-a-1
simultáneas** y **múltiples instancias** del API gracias a Redis Pub/Sub.

## Arquitectura de transporte (3 capas)

1. **Navegador ↔ NestJS**: el navegador **recibe por SSE** (`@Sse()`) y **envía
   por HTTP POST**. Sin Socket.IO ni WebSockets.
2. **Instancia NestJS ↔ Instancia NestJS**: **Redis Pub/Sub** (`ioredis`), un
   canal por room: `room:{roomId}`.
3. **Navegador ↔ Navegador**: **WebRTC** (el audio directo).

### Por qué hay estado en RAM pese a usar Redis

Una conexión SSE abierta es un objeto vivo en la RAM del proceso. Redis no
puede empujar al navegador; empuja a la *instancia*, y la instancia empuja al
navegador por el `Subject` SSE que tiene en memoria. Por eso cada instancia
guarda **solo** un `Map<clientId, Subject>` de **sus propios** clientes
(`LocalSseRegistry`). Todo lo demás —membresía de rooms y enrutado entre
instancias— vive en Redis.

### Flujo de un `offer` (A en instancia 1 → B en instancia 2)

```
A --POST /offer--> API#1 --PUBLISH room:{id}--> Redis --broadcast--> API#1 (filtra: from===A)
   Bearer <JWT>     |                                          \-----> API#2 --SSE--> B
                    └─ JwtAuthGuard: verifica la firma vs JWKS
                       y fija from = sub del token (NO del body)
```

Pub/Sub hace broadcast a todos los suscriptores (incluida la instancia que
publicó). Cada mensaje lleva `from`; al recibir, una instancia entrega solo a
sus clientes locales de esa room **distintos de `from`**.

El `from` sale del token verificado, así que un cliente no puede publicar
señalización haciéndose pasar por otro.

## Componentes del API

- `SignalingController` — `@Sse('stream')` + `POST offer/answer/ice-candidate/leave`.
- `RoomsService` — membresía vía **Redis SET** `room:{roomId}:members` (add/remove/count/getPeer).
- `LocalSseRegistry` — el `Map` de Subjects SSE + contador de rooms por instancia (único estado en RAM).
- `RedisPubSubService` — los dos clientes `ioredis` (pub + sub), subscribe/publish y dispatch.
- `AuthModule` — valida los JWT de Auth0 (`passport-jwt` + `jwks-rsa`) y sincroniza el usuario con Postgres.
- `UsersModule` — entidad `User` + `UsersService.upsertFromAuth0()` + `GET /users/me`.
- `DatabaseModule` — TypeORM contra Neon (Postgres).

## Autenticación (Auth0 + Google)

**Toda** la señalización exige usuario logueado. El flujo es **SPA + JWT**:

1. El front hace login con Auth0 (Universal Login → Google) y recibe un access token.
2. Lo manda en `Authorization: Bearer` en cada POST, y como `?token=` en el SSE
   (`EventSource` no permite mandar headers).
3. El API verifica la firma contra el **JWKS público** de Auth0. No guarda ningún
   secreto de Auth0 ni sesiones: cualquier instancia valida por su cuenta, sin
   estado compartido — el mismo criterio que llevó la señalización a Redis.
4. En cada request válido se hace un **upsert** del usuario en Postgres. No hay
   endpoint de registro: entrar con Google crea la fila.

### Identidad: el `clientId` ES el `sub` de Auth0

Antes cada pestaña generaba un UUID y lo guardaba en `sessionStorage`. Ahora la
identidad de una room es el `sub` del token, que trae dos propiedades buscadas:

- **Sobrevive al F5 sin `sessionStorage`**: el `sub` es siempre el mismo, así que
  el server reconoce la reconexión y solo renegocia WebRTC.
- **Un usuario = un lugar**: con un id por pestaña, abrir dos pestañas te dejaba
  ocupando los dos lugares de la room hablando con vos mismo. Ahora la segunda
  pestaña es una reconexión de la misma persona.

Además, el front ya **no manda** el `clientId`: el server lo deriva del token. Si
viniera del body, cualquiera podría firmar señalización con el id de otro y, por
ejemplo, expulsar en su nombre.

### Un usuario, una sola room

Se impone con la clave Redis `user:{sub}:room`. Si un usuario ya está en una room
e intenta entrar a otra, el server responde `already-in-room` con el id de la room
en la que está. Un solo `GET` en vez de escanear todos los SET de miembros.

### Configurar el tenant de Auth0

1. **Applications → Create Application** → tipo **Single Page Application**.
   - *Allowed Callback URLs*: `http://localhost:3001`
   - *Allowed Logout URLs*: `http://localhost:3001`
   - *Allowed Web Origins*: `http://localhost:3001`
   - Anotá el **Domain** y el **Client ID**.
2. **APIs → Create API**.
   - *Identifier* (= audience), p. ej. `https://api.my-turborepo`. No hace falta
     que sea una URL real, pero tiene que coincidir **exacto** entre front y API.
   - Signing Algorithm: **RS256**.
3. **Authentication → Social → Google** habilitado, y activo para la app SPA.

> **El audience no es opcional.** Sin él, Auth0 devuelve un token *opaco* que el
> backend no puede validar y todo responde 401.

#### Email y avatar en el access token (opcional)

El access token de Auth0 **no** trae `email`/`name`/`picture` (esos viven en el ID
token). Sin ellos el usuario se crea igual, pero con el perfil vacío. Para tenerlos,
agregá una **Action** (Login flow) en Auth0:

```js
exports.onExecutePostLogin = async (event, api) => {
  const ns = 'https://my-turborepo/';
  api.accessToken.setCustomClaim(`${ns}email`, event.user.email);
  api.accessToken.setCustomClaim(`${ns}name`, event.user.name);
  api.accessToken.setCustomClaim(`${ns}picture`, event.user.picture);
};
```

El namespace tiene que ser el mismo que lee `jwt.strategy.ts`.

## Requisitos

- Node ≥ 18
- Una base **Redis de Upstash** (o cualquier Redis con TLS).
  - Usar `ioredis` con `REDIS_URL` en esquema **`rediss://`** (TLS).
  - **No** usar `@upstash/redis` (es REST, no soporta Pub/Sub).
- Una base **Postgres** (Neon). Requiere TLS.
- Un tenant de **Auth0** con la conexión de Google habilitada.

## Instalación

```bash
npm install
# ioredis y @nestjs/config ya están en apps/api/package.json
```

## Configuración

**API** — `apps/api/.env` (copiá de `.env.example`):

```env
PORT=3000
CORS_ORIGIN=http://localhost:3001
REDIS_URL=rediss://default:PASSWORD@your-host.upstash.io:6379

# Postgres (Neon)
DATABASE_URL=postgresql://user:password@your-host.neon.tech/neondb?sslmode=require

# Auth0 — acá NO va ningún client secret: el API valida contra el JWKS público.
AUTH0_DOMAIN=tu-tenant.us.auth0.com
AUTH0_AUDIENCE=https://api.my-turborepo
AUTH0_ISSUER_URL=https://tu-tenant.us.auth0.com/
```

**Front** — `apps/front/.env` (copiá de `.env.example`):

```env
VITE_API_URL=http://localhost:3000

# Públicos: viajan en el bundle. El flujo SPA usa PKCE, no necesita secret.
VITE_AUTH0_DOMAIN=tu-tenant.us.auth0.com
VITE_AUTH0_CLIENT_ID=tu-client-id-de-la-app-SPA
VITE_AUTH0_AUDIENCE=https://api.my-turborepo
```

> El `.env` real está gitignored. Nunca commitees la `REDIS_URL` ni la `DATABASE_URL`.

### Esquema de la base

`synchronize` está activo mientras `NODE_ENV !== 'production'`, así que la tabla
`users` se crea sola al levantar el API. **En producción hay que apagarlo y usar
migraciones**: `synchronize` puede borrar columnas al cambiar una entidad.

## Levantar en dev

```bash
# Terminal 1 — API
npm run dev --workspace=api

# Terminal 2 — Front
npm run dev --workspace=front
```

Abrí `http://localhost:3001` en **dos pestañas**, escribí el **mismo roomId** en
ambas y tocá **Unirse**. El segundo en entrar es el *initiator* y crea la oferta.

> `getUserMedia` requiere **HTTPS o `localhost`**. En localhost funciona; si lo
> servís por IP/LAN necesitás HTTPS.

## Probar el ruteo entre 2 instancias (Pub/Sub)

Levantá dos instancias del API en puertos distintos, ambas apuntando al **mismo
Redis**:

```bash
# Terminal A
PORT=3000 npm run dev --workspace=api

# Terminal B
PORT=3002 npm run dev --workspace=api
```

> El 3001 está tomado por el front (Vite), por eso las instancias del API usan
> 3000 y 3002.

Apuntá una pestaña a una instancia y la otra a la otra (cambiá `VITE_API_URL`,
o usá un proxy/balanceador). Como la membresía y la señalización viajan por
Redis, los dos navegadores se conectan aunque estén en instancias distintas:
así verificás que Pub/Sub enruta entre procesos.

## Notas de implementación

- **Initiator = segundo en entrar**: evita *glare* (que ambos ofrezcan a la vez).
- **ICE encolado**: los candidatos que llegan antes de `setRemoteDescription` se
  guardan y se aplican después (`addIceCandidate` falla sin descripción remota).
- **Dos clientes ioredis**: una conexión en modo `subscribe` no puede ejecutar
  otros comandos, así que `redisPub` (PUBLISH + SET) y `redisSub` (SUBSCRIBE) van
  separados.
- **Colgar**: `POST /leave` quita del SET, publica `peer-left` y limpia el estado
  local; al cerrar la pestaña se envía un `sendBeacon` a `/leave`.
