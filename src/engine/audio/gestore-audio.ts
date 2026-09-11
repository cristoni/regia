/**
 * Il gestore audio: tutti i mixer e tutti gli scrittori, e la logica che
 * risponde ai comandi.
 *
 * Vive nel thread audio, ma **non sa di viverci**: non importa `worker_threads`
 * e non tocca `parentPort`. Cosi lo si puo collaudare chiamandolo direttamente,
 * e il worker resta un guscio di venti righe.
 *
 * Un solo gestore per tutte le Zone, e non uno per Zona: tredici thread che si
 * contendono la stessa CPU sarebbero peggio di uno che fa tredici cose piccole
 * in ordine. Il lavoro per blocco e una somma di interi -- il problema non e
 * mai stato la potenza, e stato essere interrotti.
 */
import * as fs from 'node:fs/promises'

import { BYTE_PER_CAMPIONE, type ImpostazioniAudio } from '../dominio/progetto.js'
import type { Livello } from '../api/protocollo.js'
import { campionato, MixerZona, type Campionato } from './mixer.js'
import { PresaTcp } from './presa-tcp.js'
import { Scrittore, type Destinazione } from './scrittore.js'
import type { ComandoAudio, EventoAudio, FlussoDaServire, StatoFlusso } from './protocollo-audio.js'

interface Servito {
  readonly flusso: FlussoDaServire
  readonly mixer: MixerZona
  readonly scrittore: Scrittore
}

export interface OpzioniGestore {
  readonly emetti: (e: EventoAudio) => void
  /** Iniettabile nei test: evita socket vere. */
  readonly apriPresa?: (host: string, porta: number) => Promise<Destinazione>
  readonly leggiFile?: (percorso: string) => Promise<Uint8Array>
}

export class GestoreAudio {
  private audio: ImpostazioniAudio | null = null
  private host = '127.0.0.1'
  private serviti: Servito[] = []
  private readonly suoni = new Map<string, Campionato>()
  private avviato = false

  private readonly emetti: (e: EventoAudio) => void
  private readonly apriPresa: (host: string, porta: number) => Promise<Destinazione>
  private readonly leggiFile: (percorso: string) => Promise<Uint8Array>

  constructor(opzioni: OpzioniGestore) {
    this.emetti = opzioni.emetti
    this.apriPresa = opzioni.apriPresa ?? ((h, p) => PresaTcp.apri(h, p))
    this.leggiFile = opzioni.leggiFile ?? ((p) => fs.readFile(p))
  }

  async esegui(c: ComandoAudio): Promise<void> {
    switch (c.tipo) {
      case 'configura': return this.configura(c.audio, c.flussi, c.host)
      case 'avvia': return this.avvia()
      case 'ferma': return this.ferma()
      case 'caricaSuono': return this.caricaSuono(c.suonoId, c.percorso)
      case 'scaricaSuono': {
        this.suoni.delete(c.suonoId)
        return
      }
      case 'suona': {
        const fonte = this.suoni.get(c.suonoId)
        // Un pulsante premuto per un Suono non ancora caricato non deve far
        // esplodere il thread audio: si ignora e si annota.
        if (!fonte) {
          this.diario('attenzione', `Suono "${c.suonoId}" non caricato: pressione ignorata`)
          return
        }
        for (const zonaId of c.zone) {
          const s = this.perZona(zonaId)
          if (!s) continue
          if (c.esclusivo) s.mixer.avviaEffettoEsclusivo(fonte, c.guadagno)
          else s.mixer.avviaEffetto(fonte, c.guadagno)
        }
        return
      }
      case 'sottofondo': {
        const s = this.perZona(c.zonaId)
        if (!s) return
        if (c.suonoId === null) {
          s.mixer.impostaSottofondo(null)
          return
        }
        const fonte = this.suoni.get(c.suonoId)
        if (!fonte) {
          this.diario('attenzione', `Sottofondo "${c.suonoId}" non caricato`)
          return
        }
        s.mixer.impostaSottofondo(fonte, c.guadagno)
        return
      }
      case 'volume': {
        this.perZona(c.zonaId)?.mixer.impostaVolume(c.volume)
        return
      }
      case 'stopZona': {
        this.perZona(c.zonaId)?.mixer.fermaEffetti()
        return
      }
      case 'stopTutto': {
        for (const s of this.serviti) s.mixer.fermaEffetti()
        return
      }
      default: {
        const mai: never = c
        throw new Error(`comando audio sconosciuto: ${JSON.stringify(mai)}`)
      }
    }
  }

  stato(): StatoFlusso[] {
    return this.serviti.map(({ flusso, mixer, scrittore }) => {
      const m = mixer.stato()
      const d = scrittore.diagnostica()
      return {
        id: flusso.id,
        zonaId: flusso.zonaId,
        volume: m.volume,
        effetti: m.effetti,
        sottofondoAttivo: m.sottofondoAttivo,
        scrittore: d.stato,
        ritardoMsAlSecondo: Math.round(d.ritardoMsAlSecondo),
        ritardoTotaleMs: d.ritardoTotaleMs,
        scartoMs: Math.round(d.scartoMs),
        cadute: d.cadute,
      }
    })
  }

  async chiudi(): Promise<void> {
    await this.ferma()
    this.suoni.clear()
  }

  // -------------------------------------------------------------- interni

  private perZona(zonaId: string): Servito | undefined {
    return this.serviti.find((s) => s.flusso.zonaId === zonaId)
  }

  private diario(livello: Livello, testo: string): void {
    this.emetti({ tipo: 'diario', livello, testo })
  }

  /**
   * Ricostruisce mixer e scrittori.
   *
   * Si ferma tutto e si riparte, invece di aggiornare in luogo: cambiare le
   * Zone comporta comunque un riavvio di snapserver (ADR 0005), quindi succede
   * solo in Setup, dove due secondi di silenzio non costano nulla. Aggiornare
   * in luogo aggiungerebbe casi limite per un guadagno che non serve a nessuno.
   */
  private async configura(
    audio: ImpostazioniAudio,
    flussi: readonly FlussoDaServire[],
    host: string,
  ): Promise<void> {
    const eraAvviato = this.avviato
    await this.ferma()

    this.audio = audio
    this.host = host
    this.serviti = flussi.map((flusso) => {
      const mixer = new MixerZona(audio, flusso.volume)
      return {
        flusso,
        mixer,
        scrittore: new Scrittore({
          impostazioni: audio,
          mixer,
          collega: () => this.apriPresa(host, flusso.porta),
          suDiagnostica: (m) => this.diario('attenzione', `${flusso.id}: ${m}`),
        }),
      }
    })

    if (eraAvviato) await this.avvia()
  }

  private async avvia(): Promise<void> {
    if (this.avviato) return
    if (!this.audio) throw new Error('gestore audio non configurato')
    this.avviato = true
    for (const s of this.serviti) s.scrittore.avvia()
    this.diario('info', `Flusso avviato su ${this.serviti.length} sorgenti`)
  }

  private async ferma(): Promise<void> {
    if (!this.avviato) return
    this.avviato = false
    await Promise.all(this.serviti.map((s) => s.scrittore.ferma()))
  }

  /**
   * Carica un Suono gia decodificato dalla cache.
   *
   * Legge il file **qui**, nel thread audio: e la ragione per cui il confine
   * non trasporta campioni. Un byte dispari verrebbe letto come mezzo campione,
   * quindi si tronca all'ultimo frame intero invece di leggere fuori posto.
   */
  private async caricaSuono(suonoId: string, percorso: string): Promise<void> {
    if (!this.audio) throw new Error('gestore audio non configurato')
    try {
      const dati = await this.leggiFile(percorso)
      const byteFrame = this.audio.canali * BYTE_PER_CAMPIONE
      const utili = dati.byteLength - (dati.byteLength % byteFrame)
      if (utili === 0) throw new Error('file vuoto')

      const copia = new Int16Array(utili / BYTE_PER_CAMPIONE)
      // Copia esplicita invece di una vista: `dati` puo essere un Buffer del
      // pool di Node, che verrebbe riusato sotto i piedi del mixer.
      new Uint8Array(copia.buffer).set(dati.subarray(0, utili))

      const c = campionato(suonoId, copia, this.audio.canali)
      this.suoni.set(suonoId, c)
      this.emetti({
        tipo: 'suonoCaricato',
        suonoId,
        durataMs: Math.round((c.durata / this.audio.frequenza) * 1000),
      })
    } catch (e) {
      this.emetti({ tipo: 'suonoFallito', suonoId, errore: (e as Error).message })
    }
  }
}
