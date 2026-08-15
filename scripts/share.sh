#!/usr/bin/env bash
#
# share.sh — expone la app a internet con ngrok para usarla con otra persona.
#
# Qué hace, en orden:
#   1. Arranca ngrok con DOS túneles (API :3000 y front :5173).
#   2. Lee del API local de ngrok (localhost:4040) las URLs públicas que generó.
#   3. Escribe VITE_API_URL en apps/front/.env.local apuntando a la API pública.
#   4. Imprime la URL del FRONT para que se la pases a la otra persona.
#
# Requisitos ANTES de correr esto (en otras terminales):
#   - La API levantada:   cd apps/api  && npm run start:dev
#   - El front levantado:  cd apps/front && npm run dev
#   (el front hay que reiniciarlo DESPUÉS de que este script escriba el .env.local;
#    el script te lo recuerda al final.)
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONT_ENV="$ROOT/apps/front/.env.local"

echo "🚀 Arrancando ngrok (API :3000 + front :5173)..."
ngrok start --all --config "$ROOT/ngrok.yml" > /dev/null &
NGROK_PID=$!
trap 'kill $NGROK_PID 2>/dev/null || true' EXIT

# Esperar a que el API local de ngrok (4040) tenga los dos túneles listos.
echo "⏳ Esperando que ngrok publique las URLs..."
API_URL=""
FRONT_URL=""
for _ in $(seq 1 30); do
  TUNNELS_JSON="$(curl -s http://localhost:4040/api/tunnels || true)"
  API_URL="$(echo "$TUNNELS_JSON"   | grep -o '"public_url":"https://[^"]*"' | sed 's/.*"https/https/;s/"$//' | head -1 || true)"
  # Mapear cada URL pública a su puerto local para saber cuál es API y cuál front.
  API_URL="$(echo "$TUNNELS_JSON"   | tr ',' '\n' | grep -A2 '"addr":"http://localhost:3000"' >/dev/null 2>&1 && \
             echo "$TUNNELS_JSON" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(next(t["public_url"] for t in d["tunnels"] if t["config"]["addr"].endswith(":3000")))' || true)"
  FRONT_URL="$(echo "$TUNNELS_JSON" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(next(t["public_url"] for t in d["tunnels"] if t["config"]["addr"].endswith(":5173")))' 2>/dev/null || true)"
  if [[ -n "$API_URL" && -n "$FRONT_URL" ]]; then break; fi
  sleep 1
done

if [[ -z "$API_URL" || -z "$FRONT_URL" ]]; then
  echo "❌ No pude leer las URLs de ngrok. ¿Está corriendo? Revisá http://localhost:4040"
  exit 1
fi

echo "VITE_API_URL=$API_URL" > "$FRONT_ENV"

echo ""
echo "✅ Listo. URLs públicas:"
echo "   API   → $API_URL"
echo "   FRONT → $FRONT_URL"
echo ""
echo "📝 Escribí VITE_API_URL en apps/front/.env.local"
echo "⚠️  IMPORTANTE: reiniciá el dev server del front para que tome la nueva URL:"
echo "      (Ctrl+C en la terminal del front y de nuevo  npm run dev)"
echo ""
echo "🔗 Pasale a la otra persona ESTA url:  $FRONT_URL"
echo "   (que abra la misma room que vos)"
echo ""
echo "Dejá esta terminal abierta (mantiene ngrok vivo). Ctrl+C para cortar."
wait $NGROK_PID
