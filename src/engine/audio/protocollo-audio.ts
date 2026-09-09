/**
 * I messaggi fra il thread principale e il thread audio.
 *
 * Il confine e stretto di proposito: da qui passano comandi piccoli e
 * diagnostiche, **mai campioni**. I Suoni non attraversano il confine come dati
 * -- il thread audio li legge da solo dalla cache su disco. Cosi un Sottofondo
 * da tre minuti (31 MB di PCM) non viene ne copiato ne duplicato, e il thread
 * principale non se lo tiene in memoria per niente.
 */
import type { ImpostazioniAudio } from '../dominio/progetto.js'
import type { EffettoInCorso } from './mixer.js'
import type { StatoScrittore } from './scrittore.js'

/** Una Zona da servire, con la porta della sua sorgente TCP. */
export interface FlussoDaServire {
  readonly id: string
  /** `null` per il Flusso dei non assegnati, che ha comunque il suo mixer. */
  readonly zonaId: string | null
  readonly porta: number
  readonly volume: number
}

export type ComandoAudio =
  /** Ricrea mixer e scrittori. Si manda a ogni cambiamento di Zone. */
  | { readonly tipo: 'configura'; readonly audio: ImpostazioniAudio; readonly flussi: readonly FlussoDaServire[]; readonly host: string }
  | { readonly tipo: 'avvia' }
  | { readonly tipo: 'ferma' }
  /** Il percorso e quello del `.pcm` gia decodificato dalla libreria. */
  | { readonly tipo: 'caricaSuono'; readonly suonoId: string; readonly percorso: string }
  | { readonly tipo: 'scaricaSuono'; readonly suonoId: string }
  | { readonly tipo: 'suona'; readonly zone: readonly string[]; readonly suonoId: string; readonly guadagno: number; readonly esclusivo: boolean }
  | { readonly tipo: 'sottofondo'; readonly zonaId: string; readonly suonoId: string | null; readonly guadagno: number }
  | { readonly tipo: 'volume'; readonly zonaId: string; readonly volume: number }
  | { readonly tipo: 'stopZona'; readonly zonaId: string }
  | { readonly tipo: 'stopTutto' }

export interface StatoFlusso {
  readonly id: string
  readonly zonaId: string | null
  readonly volume: number
  readonly effetti: readonly EffettoInCorso[]
  readonly sottofondoAttivo: boolean
  readonly scrittore: StatoScrittore
  readonly buchiMs: number
  readonly scartoMs: number
  readonly cadute: number
}

export type EventoAudio =
  | { readonly tipo: 'pronto' }
  | { readonly tipo: 'suonoCaricato'; readonly suonoId: string; readonly durataMs: number }
  | { readonly tipo: 'suonoFallito'; readonly suonoId: string; readonly errore: string }
  | { readonly tipo: 'stato'; readonly flussi: readonly StatoFlusso[] }
  | { readonly tipo: 'diario'; readonly livello: 'info' | 'attenzione' | 'grave'; readonly testo: string }
