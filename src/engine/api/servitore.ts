/**
 * Il servitore: HTTP per l'interfaccia, WebSocket per stato, comandi e video.
 *
 * E l'unico punto in cui il motore parla col mondo. Electron non compare da
 * nessuna parte: e "un browser dedicato" che apre questo indirizzo, e il tablet
 * della Fase 3 e un secondo client identico.
 *
 * Si ascolta di proposito su 127.0.0.1 finche non si chiede altro. Il §6 dice
 * "sicurezza minima, ambiente chiuso", ma esporre di default il controllo
 * dell'audio di tutta la casa a chiunque sia sulla rete Wi-Fi degli ospiti e
 * un'altra cosa.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { WebSocketServer, type WebSocket } from 'ws'

import {
  impacchettaVideo,
  zMessaggioClient,
  type Comando,
  type Evento,
  type Stato,
} from './protocollo.js'

/** Cio che il servitore pretende dal motore. Niente di piu. */
export interface Motore {
  stato(): Stato
  esegui(comando: Comando): Promise<void>
  /** Registra chi vuole i fotogrammi. Restituisce come disiscriversi. */
  ascoltaVideo(
    ascoltatore: (telecameraId: string, chiave: boolean, dati: Uint8Array) => void,
  ): () => void
  /** Righe di diario destinate all'Operatore. */
  ascoltaDiario(ascoltatore: (e: Extract<Evento, { tipo: 'diario' }>) => void): () => void
  /**
   * L'unione delle iscrizioni di tutte le connessioni.
   *
   * Il motore apre il flusso verso una Telecamera solo se **qualcuno** lo
   * guarda: sei anteprime aperte in permanenza sono 6-12 Mbit/s continui su una
   * rete che sta gia portando 11 Mbit/s di PCM. Chiudere una scheda restituisce
   * banda agli Altoparlanti, e questo e il messaggio che glielo dice.
   */
  interessatoVideo(telecamere: readonly string[]): void
  /** L'ultimo fotogramma chiave, da mandare subito a chi si iscrive adesso. */
  ultimoIdr(telecameraId: string): Uint8Array | null
  /** L'elenco dei file registrati, servito su `/api/registrazioni`. */
  elencoRegistrazioni(): Promise<readonly unknown[]>
  /**
   * Un Suono caricato dall'interfaccia, come byte.
   *
   * Passa da qui e non da un percorso su disco perche l'interfaccia e una
   * pagina web: in Electron con `sandbox: true` un `<input type=file>` non da
   * il percorso vero del file, e il tablet della Fase 3 non ha nemmeno lo
   * stesso disco. I byte, invece, funzionano da tutti e tre i posti.
   */
  importaSuono(nome: string, dati: Buffer): Promise<void>
  /** Il progetto in JSON, senza password, per il pulsante "esporta". */
  esportaProgetto(): Promise<string>
  importaProgettoDaTesto(testo: string): Promise<void>
}

/** Un corpo di richiesta intero, con un tetto: 200 MB e un Suono lunghissimo. */
const TETTO_CORPO = 200 << 20

function leggiCorpo(req: IncomingMessage): Promise<Buffer> {
  return new Promise((risolvi, rifiuta) => {
    const pezzi: Buffer[] = []
    let quanti = 0
    req.on('data', (d: Buffer) => {
      quanti += d.length
      if (quanti > TETTO_CORPO) {
        req.destroy()
        rifiuta(new Error('file troppo grande'))
        return
      }
      pezzi.push(d)
    })
    req.on('end', () => risolvi(Buffer.concat(pezzi)))
    req.on('error', rifiuta)
  })
}

export interface OpzioniServitore {
  readonly porta: number
  /** Cartella dei file statici dell'interfaccia. `null` = solo API. */
  readonly cartellaUi: string | null
  /** Vero solo se l'Operatore ha scelto di comandare Regia da un tablet. */
  readonly ancheDallaRete: boolean
  /** Ogni quanto si manda l'istantanea dello stato. */
  readonly cadenzaStatoMs: number
}

export const OPZIONI_PREDEFINITE: OpzioniServitore = {
  porta: 7333,
  cartellaUi: null,
  ancheDallaRete: false,
  cadenzaStatoMs: 100,
}

const TIPI: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

class Connessione {
  /** Telecamere di cui questo client vuole i fotogrammi. Vuoto: nessuna. */
  video = new Set<string>()
  /** Ultima istantanea mandata, per non rimandare la stessa. */
  ultimaIstantanea = ''

  constructor(readonly socket: WebSocket) {}

  manda(e: Evento): void {
    if (this.socket.readyState === 1) this.socket.send(JSON.stringify(e))
  }
}

export class Servitore {
  private http: Server | null = null
  private ws: WebSocketServer | null = null
  private readonly connessioni = new Set<Connessione>()
  private battito: NodeJS.Timeout | null = null
  private staccaVideo: (() => void) | null = null
  private staccaDiario: (() => void) | null = null

  constructor(
    private readonly motore: Motore,
    private readonly opzioni: OpzioniServitore = OPZIONI_PREDEFINITE,
  ) {}

  /** Restituisce la porta davvero assegnata (con `porta: 0` la sceglie il sistema). */
  async avvia(): Promise<number> {
    const http = createServer((req, res) => void this.serviFile(req, res))
    const ws = new WebSocketServer({ server: http, path: '/regia' })
    this.http = http
    this.ws = ws

    ws.on('connection', (socket) => this.accogli(socket))
    // Senza questo, una porta gia occupata **uccide il processo**: il server
    // WebSocket riemette l'errore del server HTTP, e un evento `error` senza
    // ascoltatori in Node e un'eccezione non gestita. Il messaggio pulito che
    // `avvia()` sa produrre non arriverebbe mai a nessuno.
    ws.on('error', () => {})

    this.staccaVideo = this.motore.ascoltaVideo((telecameraId, chiave, dati) => {
      let pacchetto: Uint8Array | null = null
      for (const c of this.connessioni) {
        if (!c.video.has(telecameraId) || c.socket.readyState !== 1) continue
        // Si impacchetta una volta sola, e solo se qualcuno lo vuole davvero.
        pacchetto ??= impacchettaVideo(telecameraId, chiave, dati)
        c.socket.send(pacchetto)
      }
    })
    this.staccaDiario = this.motore.ascoltaDiario((e) => {
      for (const c of this.connessioni) c.manda(e)
    })

    const indirizzo = this.opzioni.ancheDallaRete ? '0.0.0.0' : '127.0.0.1'
    await new Promise<void>((ok, ko) => {
      http.once('error', ko)
      http.listen(this.opzioni.porta, indirizzo, ok)
    })

    this.battito = setInterval(() => this.trasmettiStato(), this.opzioni.cadenzaStatoMs)
    this.battito.unref?.()

    const a = http.address()
    return typeof a === 'object' && a ? a.port : this.opzioni.porta
  }

  async ferma(): Promise<void> {
    if (this.battito) clearInterval(this.battito)
    this.battito = null
    this.staccaVideo?.()
    this.staccaDiario?.()
    for (const c of this.connessioni) c.socket.close(1001, 'Regia si sta chiudendo')
    this.connessioni.clear()
    await new Promise<void>((ok) => (this.ws ? this.ws.close(() => ok()) : ok()))
    await new Promise<void>((ok) => (this.http ? this.http.close(() => ok()) : ok()))
    this.http = null
    this.ws = null
  }

  get clientiCollegati(): number {
    return this.connessioni.size
  }

  // ------------------------------------------------------------ interni

  private accogli(socket: WebSocket): void {
    const c = new Connessione(socket)
    this.connessioni.add(c)

    // Istantanea completa subito: un client che si collega a meta serata deve
    // vedere tutto senza aspettare il prossimo battito.
    c.ultimaIstantanea = JSON.stringify(this.motore.stato())
    c.manda({ tipo: 'stato', stato: JSON.parse(c.ultimaIstantanea) as Stato })

    socket.on('message', (dati, binario) => {
      if (binario) return // il canale binario e a senso unico, dal motore in giu
      void this.ricevi(c, dati.toString())
    })
    socket.on('close', () => {
      this.connessioni.delete(c)
      this.aggiornaInteresseVideo()
    })
    socket.on('error', () => {
      this.connessioni.delete(c)
      this.aggiornaInteresseVideo()
    })
  }

  private async ricevi(c: Connessione, testo: string): Promise<void> {
    let grezzo: unknown
    try {
      grezzo = JSON.parse(testo)
    } catch {
      return c.manda({ tipo: 'esito', id: '?', ok: false, errore: 'messaggio non e JSON' })
    }

    const letto = zMessaggioClient.safeParse(grezzo)
    if (!letto.success) {
      const id = typeof (grezzo as { id?: unknown })?.id === 'string' ? (grezzo as { id: string }).id : '?'
      return c.manda({
        tipo: 'esito', id, ok: false,
        errore: letto.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      })
    }

    if (letto.data.tipo === 'video.iscrivi') {
      const prima = c.video
      c.video = new Set(letto.data.telecamere)
      this.aggiornaInteresseVideo()
      // Un fotogramma chiave subito, per ogni Telecamera appena chiesta: senza,
      // la cella resta nera fino al prossimo IDR, che arriva ogni secondo e non
      // e configurabile. Ogni IDR e preceduto da SPS e PPS, quindi basta lui.
      for (const id of c.video) {
        if (prima.has(id)) continue
        const idr = this.motore.ultimoIdr(id)
        if (idr && c.socket.readyState === 1) c.socket.send(impacchettaVideo(id, true, idr))
      }
      return
    }

    const { id, comando } = letto.data
    try {
      await this.motore.esegui(comando)
      c.manda({ tipo: 'esito', id, ok: true })
    } catch (e) {
      // Un comando che fallisce non deve mai buttare giu la connessione: durante
      // l'Evento l'Operatore deve poter ripremere, non riavviare (§5.2).
      c.manda({ tipo: 'esito', id, ok: false, errore: (e as Error).message })
    }
    // Lo stato e cambiato: non aspettare il battito.
    this.trasmettiStato()
  }

  /**
   * Ridice al motore quali Telecamere servono davvero, adesso.
   *
   * E l'unione, non la somma: due interfacce che guardano la stessa Zona
   * restano una connessione sola verso il telefono (§4.5).
   */
  private aggiornaInteresseVideo(): void {
    const unione = new Set<string>()
    for (const c of this.connessioni) for (const id of c.video) unione.add(id)
    this.motore.interessatoVideo([...unione])
  }

  private trasmettiStato(): void {
    if (this.connessioni.size === 0) return
    const istantanea = JSON.stringify(this.motore.stato())
    let stato: Stato | null = null
    for (const c of this.connessioni) {
      if (c.ultimaIstantanea === istantanea) continue
      c.ultimaIstantanea = istantanea
      stato ??= JSON.parse(istantanea) as Stato
      c.manda({ tipo: 'stato', stato })
    }
  }

  private async serviFile(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url === '/salute') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, clienti: this.connessioni.size }))
      return
    }

    // L'elenco dei file registrati non sta nell'istantanea: sono centinaia di
    // righe che cambiano una volta ogni dieci minuti, e l'istantanea viaggia
    // dieci volte al secondo. Si va a prendere quando serve.
    if (req.url === '/api/registrazioni') {
      try {
        const elenco = await this.motore.elencoRegistrazioni()
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(elenco))
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ errore: (e as Error).message }))
      }
      return
    }

    if (req.url?.startsWith('/api/suoni') && req.method === 'POST') {
      const nome = new URL(req.url, 'http://x').searchParams.get('nome') ?? 'suono'
      try {
        await this.motore.importaSuono(nome, await leggiCorpo(req))
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end('{"ok":true}')
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ errore: (e as Error).message }))
      }
      return
    }

    if (req.url === '/api/progetto') {
      try {
        if (req.method === 'POST') {
          await this.motore.importaProgettoDaTesto((await leggiCorpo(req)).toString('utf8'))
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end('{"ok":true}')
        } else {
          const testo = await this.motore.esportaProgetto()
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-disposition': 'attachment; filename="progetto-regia.json"',
          })
          res.end(testo)
        }
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ errore: (e as Error).message }))
      }
      return
    }

    const radice = this.opzioni.cartellaUi
    if (!radice) {
      res.writeHead(404).end('interfaccia non servita da questo motore')
      return
    }

    const richiesto = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/')
    const relativo = richiesto === '/' ? 'index.html' : richiesto.replace(/^\/+/, '')
    const assoluto = path.resolve(radice, relativo)

    // Senza questo, "GET /../../progetto.json" servirebbe il file di progetto.
    if (assoluto !== path.resolve(radice) && !assoluto.startsWith(path.resolve(radice) + path.sep)) {
      res.writeHead(403).end('fuori dalla cartella dell interfaccia')
      return
    }

    try {
      const dati = await fs.readFile(assoluto)
      res.writeHead(200, { 'content-type': TIPI[path.extname(assoluto).toLowerCase()] ?? 'application/octet-stream' })
      res.end(dati)
    } catch {
      // Interfaccia a pagina unica: qualunque percorso sconosciuto torna l'indice.
      try {
        res.writeHead(200, { 'content-type': TIPI['.html']! })
        res.end(await fs.readFile(path.join(radice, 'index.html')))
      } catch {
        res.writeHead(404).end('non trovato')
      }
    }
  }
}
