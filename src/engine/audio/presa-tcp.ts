/**
 * La `Destinazione` vera: una socket TCP verso una sorgente di snapserver.
 *
 * Tutta la parte delicata sta nello `Scrittore`, che questa classe non conosce.
 * Qui c'e solo una regola, ma va rispettata alla lettera:
 *
 *   **`connect()` che riesce NON e prova che snapserver stia leggendo.**
 *
 * In `mode=server` snapserver posta un solo `async_accept` e non ne posta un
 * altro finche la connessione corrente non va in errore; il kernel pero
 * completa lo handshake e parcheggia le altre nella coda di accettazione. Una
 * seconda socket sembra quindi perfettamente viva e non viene letta da nessuno:
 * i suoi byte usciranno dalle casse minuti dopo, quando la prima cadra.
 *
 * Per questo `apri()` non promette che il server stia ascoltando, e chi la usa
 * deve verificarlo altrove -- l'unica conferma applicativa e lo stato dello
 * stream che passa da `idle` a `playing`, letto via JSON-RPC.
 */
import { connect, type Socket } from 'node:net'

import type { Destinazione } from './scrittore.js'

export class PresaTcp implements Destinazione {
  private socket: Socket | null
  private attesaScarico: Promise<void> | null = null

  private constructor(socket: Socket) {
    this.socket = socket
    socket.on('error', () => this.spegni())
    socket.on('close', () => this.spegni())
  }

  static async apri(host: string, porta: number, timeoutMs = 3000): Promise<PresaTcp> {
    return new Promise<PresaTcp>((ok, ko) => {
      const s = connect({ host, port: porta })
      const scadenza = setTimeout(() => {
        s.destroy()
        ko(new Error(`${host}:${porta}: nessuna risposta entro ${timeoutMs} ms`))
      }, timeoutMs)

      s.once('error', (e) => {
        clearTimeout(scadenza)
        s.destroy()
        ko(e)
      })
      s.once('connect', () => {
        clearTimeout(scadenza)
        // Senza questo, Nagle accorpa i blocchi da 20 ms e li consegna a
        // raffica: il ritmo lo detta la cadenza, non lo stack di rete.
        s.setNoDelay(true)
        ok(new PresaTcp(s))
      })
    })
  }

  get aperta(): boolean {
    return this.socket !== null && !this.socket.destroyed && this.socket.writable
  }

  scrivi(dati: Uint8Array): boolean {
    const s = this.socket
    if (!s || s.destroyed) throw new Error('scrittura su una presa chiusa')
    // `write` restituisce falso quando la coda interna supera la soglia: e un
    // segnale di memoria, non di tempo. Lo Scrittore lo usa per non gonfiare il
    // processo, mai per regolare il ritmo.
    return s.write(dati)
  }

  attendiScarico(): Promise<void> {
    const s = this.socket
    if (!s || s.destroyed) return Promise.resolve()
    // Una sola attesa condivisa: chiamarla due volte non deve accumulare
    // ascoltatori su 'drain'.
    this.attesaScarico ??= new Promise<void>((ok) => {
      const finito = () => {
        this.attesaScarico = null
        s.off('drain', finito)
        s.off('close', finito)
        ok()
      }
      s.once('drain', finito)
      s.once('close', finito)
    })
    return this.attesaScarico
  }

  async chiudi(): Promise<void> {
    const s = this.socket
    this.socket = null
    if (!s || s.destroyed) return
    await new Promise<void>((ok) => {
      s.once('close', () => ok())
      // `destroy` e non `end`: chiudere a meta strada e cio che vogliamo, e un
      // FIN cortese lascerebbe la socket in TIME_WAIT sulla porta della
      // sorgente -- che e la porta su cui dobbiamo poter rientrare subito.
      s.destroy()
    })
  }

  /** Byte accodati nel processo e non ancora consegnati al kernel. */
  get inCoda(): number {
    return this.socket?.writableLength ?? 0
  }

  private spegni(): void {
    this.socket = null
  }
}
