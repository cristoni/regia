/**
 * Il guscio Electron.
 *
 * Deliberatamente stupido. Tutta Regia sta nel motore, che non importa niente
 * di Electron; qui dentro c'e solo cio che serve ad avere una finestra: avvia
 * il motore in processo, apri l'indirizzo che ti dice, e non metterti in mezzo.
 *
 * Se un giorno questo file sparisse, Regia continuerebbe a funzionare con un
 * browser puntato sulla stessa porta. E il motivo per cui il tablet della Fase 3
 * costa quasi zero.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow, dialog, globalShortcut, Menu, shell } from 'electron'

import { avviaMotore, type MotoreAvviato } from '../engine/index.js'

/**
 * Dove sono i file compilati dell'interfaccia.
 *
 * Si cerca invece di scriverlo una volta sola perche questo file gira da tre
 * posti diversi -- `src/shell` sotto `tsx`, `dist/shell/shell` dopo `tsc`, e
 * dentro l'`asar` una volta impacchettato -- e un percorso relativo giusto in
 * uno dei tre e sbagliato negli altri due, con l'errore che si scopre solo
 * all'avvio dell'app impacchettata.
 */
function cartellaInterfaccia(): string | null {
  const qui = path.dirname(fileURLToPath(import.meta.url))
  const candidati = [
    path.resolve(qui, '../../dist/ui'),
    path.resolve(qui, '../../../dist/ui'),
    path.resolve(process.cwd(), 'dist/ui'),
    path.join(process.resourcesPath ?? '', 'ui'),
  ]
  return candidati.find((c) => fs.existsSync(path.join(c, 'index.html'))) ?? null
}

let motore: MotoreAvviato | null = null
let finestra: BrowserWindow | null = null

/** Una sola Regia per volta: due mixer sulle stesse porte non funzionerebbero. */
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!finestra) return
    if (finestra.isMinimized()) finestra.restore()
    finestra.focus()
  })
  // La finestra nasce solo DOPO che il motore e partito: se `principale()`
  // affonda, senza questo catch l'app resterebbe viva per sempre -- muta,
  // senza finestra, e col lucchetto di singola istanza occupato.
  void principale().catch(async (e: unknown) => {
    const messaggio = e instanceof Error ? e.message : String(e)
    dialog.showErrorBox(
      'Regia non è partita',
      (e as NodeJS.ErrnoException | null)?.code === 'EADDRINUSE'
        ? 'La porta di Regia è già occupata da un altro processo: un\'altra Regia, ' +
          'o un motore avviato da terminale e rimasto acceso. ' +
          `Chiudilo e rilancia.\n\n(${messaggio})`
        : messaggio,
    )
    await motore?.ferma().catch((err: unknown) => console.error('chiusura non pulita:', err))
    app.exit(1)
  })
}

async function principale(): Promise<void> {
  await app.whenReady()
  Menu.setApplicationMenu(null)

  const cartellaUi = cartellaInterfaccia()
  if (!cartellaUi) {
    // Meglio dirlo subito e chiaro che aprire una finestra bianca: senza
    // interfaccia compilata il motore risponde 404 e non si capisce perche.
    console.error('interfaccia non trovata: esegui "npm run build:ui" prima di avviare Regia.')
  }
  motore = await avviaMotore(cartellaUi === null ? {} : { cartellaUi })

  finestra = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    // Tema scuro obbligatorio (§5.1): la Regia sta in una stanza buia, e un
    // lampo bianco all'avvio acceca l'Operatore per mezzo minuto.
    backgroundColor: '#0b0b0d',
    autoHideMenuBar: true,
    webPreferences: {
      // La pagina e servita dal nostro motore su loopback e non ha bisogno di
      // toccare Node: se un giorno mostrasse contenuto di terzi, questo confine
      // e cio che impedisce il disastro.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })

  finestra.once('ready-to-show', () => finestra?.show())
  finestra.on('closed', () => (finestra = null))

  // Un link esterno apre il browser di sistema invece di dirottare la Regia.
  finestra.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  await finestra.loadURL(motore.indirizzo)

  // F11 schermo intero, F12 strumenti di sviluppo. Le scorciatoie dei Suoni e
  // lo STOP TUTTO stanno nella pagina, non qui: devono funzionare anche dal
  // tablet, dove questo file non esiste.
  finestra.webContents.on('before-input-event', (evento, input) => {
    if (input.type !== 'keyDown' || !finestra) return
    if (input.key === 'F11') {
      finestra.setFullScreen(!finestra.isFullScreen())
      evento.preventDefault()
    } else if (input.key === 'F12') {
      finestra.webContents.toggleDevTools()
      evento.preventDefault()
    }
  })
}

app.on('window-all-closed', () => app.quit())

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

/**
 * La chiusura deve essere ordinata: i file di registrazione vanno chiusi bene o
 * restano illeggibili (§3.7), e l'ultima modifica del progetto va scritta.
 * Electron non aspetta le promesse, quindi si rimanda l'uscita finche il motore
 * non ha finito.
 */
let inChiusura = false
app.on('before-quit', (evento) => {
  if (inChiusura || !motore) return
  evento.preventDefault()
  inChiusura = true
  void motore
    .ferma()
    .catch((e: unknown) => console.error('chiusura non pulita:', e))
    .finally(() => {
      motore = null
      app.quit()
    })
})
