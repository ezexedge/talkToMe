import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import CssBaseline from '@mui/material/CssBaseline'
import { ThemeProvider } from '@mui/material/styles'
import './index.css'
import { theme } from './theme.ts'
import Home from './Home.tsx'
import Room from './Room.tsx'
import { AuthProvider, RequireAuth } from './auth0.tsx'

// Sin StrictMode a propósito: en dev StrictMode monta/desmonta los effects dos
// veces, lo que abriría el SSE y pediría el micrófono dos veces y rompería el
// handshake WebRTC. Para una app de llamada en tiempo real preferimos un único
// montaje.
createRoot(document.getElementById('root')!).render(
  <ThemeProvider theme={theme}>
    {/* CssBaseline aplica el fondo crema del tema al <body>. */}
    <CssBaseline />
    {/* Auth0 envuelve al router: el callback del login vuelve a "/" y el
        provider necesita estar montado para procesarlo. */}
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          {/* El Home es PÚBLICO: cualquiera puede ver el lobby y las salas
              activas. La sesión se pide recién al entrar a una sala. */}
          <Route path="/" element={<Home />} />
          <Route
            path="/room/:roomId"
            element={
              <RequireAuth>
                <Room />
              </RequireAuth>
            }
          />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  </ThemeProvider>,
)
