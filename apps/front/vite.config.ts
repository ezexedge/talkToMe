import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Puerto fijo del front. Tiene que coincidir con las tres URLs cargadas en
    // Auth0 (callback/logout/web origins) y con el CORS_ORIGIN del API.
    port: 3001,
    // strictPort: si el 3001 está ocupado, falla en vez de saltar al 3002 en
    // silencio. Un puerto distinto rompería el login (Auth0 valida el origen
    // exacto), así que es preferible el error ruidoso.
    strictPort: true,
    // host: true → escucha en todas las interfaces (necesario para que ngrok
    // pueda alcanzar el dev server de Vite).
    host: true,
    // ngrok genera un subdominio al azar; permitimos sus dominios para que Vite
    // no rechace el request con "Invalid Host header".
    allowedHosts: ['.ngrok-free.app', '.ngrok.app', '.ngrok.io'],
  },
})
