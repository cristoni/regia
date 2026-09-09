/**
 * L'interfaccia si compila in `dist/ui`, e il motore la serve da li.
 *
 * In sviluppo la pagina la serve Vite, ma il WebSocket deve comunque finire nel
 * motore vero: da qui il proxy su `/regia`. Cosi l'indirizzo del WebSocket si
 * ricava sempre da `location`, identico in sviluppo e nell'app impacchettata,
 * e non esiste un ramo di codice che gira solo in uno dei due casi.
 */
import { defineConfig } from 'vite'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const qui = path.dirname(fileURLToPath(import.meta.url))

/** La stessa del servitore. Si puo cambiare per lo sviluppo con REGIA_PORTA. */
const portaMotore = Number(process.env['REGIA_PORTA'] ?? 7333)

export default defineConfig({
  root: qui,
  // Percorsi relativi: la pagina viene servita dalla radice, ma un `file://`
  // di emergenza deve comunque trovare i propri file.
  base: './',
  build: {
    outDir: path.resolve(qui, '../../dist/ui'),
    emptyOutDir: true,
    target: 'chrome120',
    // La Regia sta su una LAN chiusa e la si apre da Electron: le mappe dei
    // sorgenti costano niente e servono la sera in cui qualcosa non va.
    sourcemap: true,
  },
  server: {
    port: 7334,
    strictPort: true,
    proxy: {
      '/regia': { target: `ws://127.0.0.1:${portaMotore}`, ws: true },
      '/salute': { target: `http://127.0.0.1:${portaMotore}` },
    },
  },
})
