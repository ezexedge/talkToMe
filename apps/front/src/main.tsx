import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import CssBaseline from '@mui/material/CssBaseline'
import { ThemeProvider } from '@mui/material/styles'
import './index.css'
import { theme } from './theme.ts'
import Home from './Home.tsx'
import Room from './Room.tsx'
import { AuthProvider, RequireAuth } from './auth0.tsx'

createRoot(document.getElementById('root')!).render(
  <ThemeProvider theme={theme}>
    <CssBaseline />
    <AuthProvider>
      <BrowserRouter>
        <Routes>
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
