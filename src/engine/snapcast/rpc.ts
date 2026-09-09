/**
 * Client JSON-RPC verso snapserver.
 *
 * Parla la porta di controllo TCP (1705): richieste JSON separate da newline,
 * risposte e notifiche sullo stesso canale. Si e scelto il TCP e non il
 * WebSocket sulla 1780 perche e una dipendenza in meno e perche le notifiche
 * arrivano identiche; il percorso WebSocket, se un giorno servisse, e
 * esattamente `/jsonrpc`.
 *
 * La connessione e **persistente**: le notifiche (`Client.OnConnect`,
 * `Server.OnUpdate`, ...) sono cio che sveglia il riconciliatore, e arrivano
 * solo a chi resta collegato.
 */
import { EventEmitter } from 'node:events'
import { connect, type Socket } from 'node:net'

import type { ClientOsservato, GruppoOsservato, StatoOsservato } from './riconciliatore.js'

export class ErroreRpc extends Error {
  constructor(
    readonly codice: number,
    messaggio: string,
    readonly dettaglio?: string,
  ) {
    super(dettaglio ? `${messaggio}: ${dettaglio}` : messaggio)
    this.name = 'ErroreRpc'
  }
}

interface InAttesa {
  risolvi: (v: unknown) => void
  rifiuta: (e: Error) => void
  scadenza: NodeJS.Timeout
}

export interface OpzioniRpc {
  readonly host: string
  readonly porta: number
  readonly timeoutMs: number
}

export const OPZIONI_RPC: OpzioniRpc = { host: '127.0.0.1', porta: 1705, timeoutMs: 5000 }

/**
 * Eventi emessi:
 *   'notifica'   (metodo, params)  -- una notifica dal server
 *   'collegato'                    -- connessione stabilita
 *   'caduto'     (Error)           -- connessione persa
 */
export class ClientRpc extends EventEmitter {
  private socket: Socket | null = null
  private buffer = ''
  private prossimoId = 1
  private readonly attese = new Map<number, InAttesa>()

  constructor(private readonly opzioni: OpzioniRpc = OPZIONI_RPC) {
    super()
  }

  get collegato(): boolean {
    return this.socket !== null && !this.socket.destroyed
  }

  async collega(): Promise<void> {
    if (this.collegato) return
    await new Promise<void>((ok, ko) => {
      const s = connect({ host: this.opzioni.host, port: this.opzioni.porta })
      const suErrore = (e: Error) => {
        s.destroy()
        ko(e)
      }
      s.once('error', suErrore)
      s.once('connect', () => {
        s.off('error', suErrore)
        s.setNoDelay(true)
        this.socket = s
        s.on('data', (d) => this.ricevi(d.toString('utf8')))
        s.on('error', (e) => this.chiudiCon(e))
        s.on('close', () => this.chiudiCon(new Error('connessione di controllo chiusa')))
        this.emit('collegato')
        ok()
      })
    })
  }

  async chiudi(): Promise<void> {
    const s = this.socket
    this.socket = null
    this.rifiutaTutte(new Error('client di controllo fermato'))
    if (!s) return
    await new Promise<void>((ok) => {
      s.once('close', () => ok())
      s.destroy()
    })
  }

  /** Manda una richiesta e aspetta la risposta. */
  async chiama<T = unknown>(metodo: string, params?: unknown): Promise<T> {
    const s = this.socket
    if (!s || s.destroyed) throw new Error('non collegato al server di controllo')

    const id = this.prossimoId++
    const messaggio = JSON.stringify(
      params === undefined
        ? { id, jsonrpc: '2.0', method: metodo }
        : { id, jsonrpc: '2.0', method: metodo, params },
    )

    return new Promise<T>((risolvi, rifiuta) => {
      const scadenza = setTimeout(() => {
        this.attese.delete(id)
        rifiuta(new Error(`${metodo}: nessuna risposta entro ${this.opzioni.timeoutMs} ms`))
      }, this.opzioni.timeoutMs)
      scadenza.unref?.()
      this.attese.set(id, { risolvi: risolvi as (v: unknown) => void, rifiuta, scadenza })
      s.write(messaggio + '\n')
    })
  }

  // ------------------------------------------------- comodita tipizzate

  async stato(): Promise<StatoOsservato> {
    const r = await this.chiama<{ server: RispostaServer }>('Server.GetStatus')
    return leggiStato(r.server)
  }

  gruppoClient(gruppoId: string, clientIds: readonly string[]): Promise<unknown> {
    return this.chiama('Group.SetClients', { id: gruppoId, clients: [...clientIds] })
  }
  gruppoStream(gruppoId: string, streamId: string): Promise<unknown> {
    return this.chiama('Group.SetStream', { id: gruppoId, stream_id: streamId })
  }
  nomeClient(clientId: string, nome: string): Promise<unknown> {
    return this.chiama('Client.SetName', { id: clientId, name: nome })
  }
  volumeClient(clientId: string, percentuale: number, muto: boolean): Promise<unknown> {
    return this.chiama('Client.SetVolume', { id: clientId, volume: { muted: muto, percent: percentuale } })
  }
  /** Il server tronca al `buffer`: si rilegge il valore ottenuto dalla risposta. */
  async latenzaClient(clientId: string, latenzaMs: number): Promise<number> {
    const r = await this.chiama<{ latency: number }>('Client.SetLatency', { id: clientId, latency: latenzaMs })
    return r.latency
  }
  dimenticaClient(clientId: string): Promise<unknown> {
    return this.chiama('Server.DeleteClient', { id: clientId })
  }

  // ------------------------------------------------------------ interni

  private ricevi(testo: string): void {
    this.buffer += testo
    let taglio: number
    while ((taglio = this.buffer.indexOf('\n')) >= 0) {
      const riga = this.buffer.slice(0, taglio).trim()
      this.buffer = this.buffer.slice(taglio + 1)
      if (!riga) continue
      try {
        this.smista(JSON.parse(riga) as Record<string, unknown>)
      } catch {
        // Una riga illeggibile non deve buttare giu la connessione: perderemmo
        // le notifiche, e con quelle il riconciliatore.
        this.emit('notifica', '__illeggibile__', riga)
      }
    }
  }

  private smista(m: Record<string, unknown>): void {
    if (typeof m['method'] === 'string') {
      this.emit('notifica', m['method'], m['params'])
      return
    }
    const id = m['id']
    if (typeof id !== 'number') return
    const attesa = this.attese.get(id)
    if (!attesa) return
    this.attese.delete(id)
    clearTimeout(attesa.scadenza)

    const errore = m['error'] as { code?: number; message?: string; data?: string } | undefined
    if (errore) {
      attesa.rifiuta(new ErroreRpc(errore.code ?? -1, errore.message ?? 'errore', errore.data))
    } else {
      attesa.risolvi(m['result'])
    }
  }

  private chiudiCon(e: Error): void {
    if (!this.socket) return
    this.socket = null
    this.rifiutaTutte(e)
    this.emit('caduto', e)
  }

  private rifiutaTutte(e: Error): void {
    for (const [, a] of this.attese) {
      clearTimeout(a.scadenza)
      a.rifiuta(e)
    }
    this.attese.clear()
  }
}

// ------------------------------------------- traduzione dalle forme di Snapcast

interface RispostaServer {
  groups: Array<{
    id: string
    stream_id: string
    clients: Array<{
      id: string
      connected: boolean
      host?: { ip?: string; name?: string }
      config: { name: string; latency: number; volume: { muted: boolean; percent: number } }
    }>
  }>
  streams: Array<{ id: string }>
}

/**
 * Traduce `Server.GetStatus` nella forma che il riconciliatore si aspetta.
 *
 * Le forme sono state verificate contro un snapserver 0.35 vero: vedi
 * `docs/fatti-verificati.md`. In particolare `volume.percent` va da 0 a 100 e
 * un client scollegato resta comunque nel suo gruppo, con la sua configurazione.
 */
export function leggiStato(server: RispostaServer): StatoOsservato {
  const gruppi: GruppoOsservato[] = []
  const clienti: ClientOsservato[] = []

  for (const g of server.groups ?? []) {
    gruppi.push({ id: g.id, streamId: g.stream_id, clientIds: (g.clients ?? []).map((c) => c.id) })
    for (const c of g.clients ?? []) {
      // Il nome mostrato in Snapdroid puo stare in `config.name` o, se non e
      // mai stato riscritto, solo in `host.name`: si prende il primo che c'e.
      clienti.push({
        id: c.id,
        connesso: c.connected,
        nome: c.config?.name || c.host?.name || '',
        volumePercentuale: c.config?.volume?.percent ?? 100,
        muto: c.config?.volume?.muted ?? false,
        latenzaMs: c.config?.latency ?? 0,
        ...(c.host?.ip ? { indirizzo: c.host.ip } : {}),
      })
    }
  }

  return { gruppi, clienti, streamIds: (server.streams ?? []).map((s) => s.id) }
}
