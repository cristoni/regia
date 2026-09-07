/**
 * Il contratto fra il motore e chiunque lo comandi.
 *
 * "Chiunque" e importante: non c'e nulla qui dentro che parli di Electron. Il
 * motore serve questa interfaccia su WebSocket locale, e i client sono la
 * finestra di Regia, il tablet della Fase 3, e -- non ultimo -- gli script di
 * collaudo. Le 50 pressioni consecutive del §8.3 sono un ciclo `for` che manda
 * `zona.suona`, non un dito su un pulsante (ADR 0008).
 *
 * Lo stato viaggia come istantanea completa, non come differenze. Con 12 Zone e
 * una ventina di dispositivi sono pochi kilobyte: mandarli dieci volte al
 * secondo costa meno che tenere sincronizzate delle differenze, e soprattutto
 * non puo desincronizzarsi -- il che conta, visto che i client possono essere
 * piu di uno e collegarsi a meta serata.
 */
import { z } from 'zod'

// ------------------------------------------------------------- Comandi

const conZona = { zonaId: z.string() }
const conSuono = { suonoId: z.string() }

export const zComando = z.discriminatedUnion('tipo', [
  // --- Zone (Setup)
  z.object({ tipo: z.literal('zona.crea'), nome: z.string().min(1), colore: z.string() }),
  z.object({ tipo: z.literal('zona.rinomina'), ...conZona, nome: z.string().min(1) }),
  z.object({ tipo: z.literal('zona.colore'), ...conZona, colore: z.string() }),
  z.object({ tipo: z.literal('zona.duplica'), ...conZona }),
  z.object({ tipo: z.literal('zona.elimina'), ...conZona }),
  z.object({ tipo: z.literal('zona.riordina'), ordine: z.array(z.string()) }),
  z.object({ tipo: z.literal('zona.sottofondo'), ...conZona, suonoId: z.string().nullable() }),
  z.object({ tipo: z.literal('zona.suoniAbilitati'), ...conZona, suoni: z.array(z.string()).nullable() }),

  // --- Riproduzione (Evento). Nessuna di queste chiede conferma (§5.2).
  z.object({
    tipo: z.literal('zona.suona'),
    /** Piu di una Zona per il "botto finale" a casa intera (§3.5). */
    zone: z.array(z.string()).min(1),
    ...conSuono,
    /** Se vero interrompe gli Effetti in corso invece di sovrapporsi. */
    esclusivo: z.boolean().default(false),
  }),
  z.object({ tipo: z.literal('zona.volume'), ...conZona, volume: z.number().min(0).max(2) }),
  z.object({ tipo: z.literal('zona.stop'), ...conZona }),
  z.object({ tipo: z.literal('stopTutto') }),

  // --- Altoparlanti
  z.object({ tipo: z.literal('altoparlante.assegna'), clientId: z.string(), zonaId: z.string().nullable() }),
  z.object({ tipo: z.literal('altoparlante.rinomina'), clientId: z.string(), nome: z.string().min(1) }),
  z.object({ tipo: z.literal('altoparlante.volume'), clientId: z.string(), volume: z.number().min(0).max(2) }),
  z.object({ tipo: z.literal('altoparlante.muto'), clientId: z.string(), muto: z.boolean() }),
  z.object({ tipo: z.literal('altoparlante.latenza'), clientId: z.string(), latenzaMs: z.number().int() }),
  z.object({ tipo: z.literal('altoparlante.identifica'), clientId: z.string() }),
  z.object({ tipo: z.literal('altoparlante.dimentica'), clientId: z.string() }),

  // --- Telecamere
  z.object({
    tipo: z.literal('telecamera.aggiungi'),
    host: z.string(), porta: z.number().int().default(4444), https: z.boolean().default(false),
    utente: z.string().nullable().default(null), password: z.string().nullable().default(null),
  }),
  z.object({ tipo: z.literal('telecamera.rinomina'), telecameraId: z.string(), nome: z.string().min(1) }),
  z.object({ tipo: z.literal('telecamera.assegna'), telecameraId: z.string(), zonaId: z.string().nullable() }),
  z.object({ tipo: z.literal('telecamera.identifica'), telecameraId: z.string() }),
  z.object({ tipo: z.literal('telecamera.rimuovi'), telecameraId: z.string() }),
  z.object({
    tipo: z.literal('telecamera.controlla'),
    telecameraId: z.string(),
    /** Passati come parametri all'app del telefono, cosi com'e (§3.3). */
    parametri: z.record(z.string(), z.string()),
  }),
  z.object({ tipo: z.literal('telecamera.scansiona'), sottorete: z.string().nullable().default(null) }),

  // --- Suoni
  z.object({ tipo: z.literal('suono.importa'), percorsi: z.array(z.string()).min(1) }),
  z.object({ tipo: z.literal('suono.elimina'), ...conSuono }),
  z.object({
    tipo: z.literal('suono.aggiorna'), ...conSuono,
    nome: z.string().optional(), colore: z.string().optional(),
    categoria: z.string().nullable().optional(), guadagno: z.number().min(0).max(2).optional(),
    tastoRapido: z.string().nullable().optional(),
  }),
  z.object({ tipo: z.literal('suono.riordina'), ordine: z.array(z.string()) }),
  /** Anteprima dalle cuffie del PC, non dagli Altoparlanti (§3.4). */
  z.object({ tipo: z.literal('suono.anteprima'), ...conSuono }),

  // --- Registrazione
  z.object({
    tipo: z.literal('registrazione.avvia'),
    ambito: z.discriminatedUnion('su', [
      z.object({ su: z.literal('telecamera'), telecameraId: z.string() }),
      z.object({ su: z.literal('zona'), zonaId: z.string() }),
      z.object({ su: z.literal('tutto') }),
    ]),
  }),
  z.object({
    tipo: z.literal('registrazione.ferma'),
    ambito: z.discriminatedUnion('su', [
      z.object({ su: z.literal('telecamera'), telecameraId: z.string() }),
      z.object({ su: z.literal('zona'), zonaId: z.string() }),
      z.object({ su: z.literal('tutto') }),
    ]),
  }),

  // --- Server e manutenzione
  z.object({ tipo: z.literal('server.avvia') }),
  z.object({ tipo: z.literal('server.ferma') }),
  z.object({ tipo: z.literal('server.riavvia') }),
  /** Forza la riconciliazione completa: client audio e Telecamere (§3.10). */
  z.object({ tipo: z.literal('ricollegaTutto') }),
  z.object({ tipo: z.literal('impostazioni.audio'), bufferMs: z.number().int().optional(), codec: z.string().optional() }),
])
export type Comando = z.infer<typeof zComando>

/**
 * Tutto cio che un client puo mandare al motore.
 *
 * L'iscrizione ai video e separata dai comandi perche non e un'azione sul
 * dominio ma una preferenza di questa connessione: la finestra di Regia vuole
 * tutte e sei le anteprime, il tablet della Fase 3 su Wi-Fi ne vuole una sola.
 * Il motore contatta comunque il telefono una volta sola (ADR 0004): qui si
 * decide solo a chi ridistribuire.
 */
export const zMessaggioClient = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('comando'), id: z.string().min(1), comando: zComando }),
  z.object({ tipo: z.literal('video.iscrivi'), telecamere: z.array(z.string()) }),
])
export type MessaggioClient = z.infer<typeof zMessaggioClient>

// --------------------------------------------------------------- Stato
//
// Tipi puri, non schemi: lo stato lo produciamo noi e lo validiamo con il
// compilatore. Gli schemi Zod servono per cio che arriva da fuori.

export type StatoServer = 'spento' | 'in avvio' | 'acceso' | 'caduto' | 'non installato'

export interface ZonaViva {
  readonly id: string
  readonly nome: string
  readonly colore: string
  readonly volume: number
  readonly sottofondoId: string | null
  readonly effettiInCorso: readonly { readonly suonoId: string; readonly istanza: number }[]
  readonly altoparlantiCollegati: number
  readonly altoparlantiTotali: number
  readonly telecamereCollegate: number
  readonly telecamereTotali: number
  /** Millisecondi di Flusso persi per riallineamento. Sopra zero e un sintomo. */
  readonly buchiMs: number
}

export interface AltoparlanteVivo {
  readonly id: string
  readonly nome: string
  readonly zonaId: string | null
  readonly collegato: boolean
  readonly volume: number
  readonly muto: boolean
  readonly latenzaMs: number
  readonly indirizzo: string | null
  readonly vistoIl: string
  readonly inIdentificazione: boolean
}

export interface TelecameraViva {
  readonly id: string
  readonly nome: string
  readonly zonaId: string | null
  readonly host: string
  readonly porta: number
  readonly raggiungibile: boolean
  readonly batteria: number | null
  readonly segnale: number | null
  readonly inRegistrazione: boolean
  readonly fpsAnteprima: number | null
  readonly vistoIl: string | null
}

export interface StatoRegistrazione {
  readonly attive: number
  readonly spazioLiberoGb: number
  readonly sottoAvviso: boolean
  readonly bloccata: boolean
  readonly cartella: string
}

export interface Stato {
  readonly progettoNome: string
  readonly server: StatoServer
  readonly zone: readonly ZonaViva[]
  readonly altoparlanti: readonly AltoparlanteVivo[]
  readonly telecamere: readonly TelecameraViva[]
  readonly suoni: readonly {
    readonly id: string; readonly nome: string; readonly colore: string
    readonly categoria: string | null; readonly durataMs: number | null
    readonly tastoRapido: string | null; readonly pronto: boolean
  }[]
  readonly registrazione: StatoRegistrazione
  readonly audio: { readonly bufferMs: number; readonly codec: string; readonly bandaMbit: number }
  /** Avvisi persistenti da mostrare nella barra di stato (§3.10). */
  readonly avvisi: readonly { readonly livello: 'info' | 'attenzione' | 'grave'; readonly testo: string }[]
}

// -------------------------------------------------------------- Eventi

export type Evento =
  | { readonly tipo: 'stato'; readonly stato: Stato }
  | { readonly tipo: 'esito'; readonly id: string; readonly ok: true }
  | { readonly tipo: 'esito'; readonly id: string; readonly ok: false; readonly errore: string }
  /** Riga di diario leggibile dall'Operatore (§3.10). */
  | { readonly tipo: 'diario'; readonly quando: string; readonly livello: 'info' | 'attenzione' | 'grave'; readonly testo: string }
  /** Un fotogramma sta per arrivare sul canale binario. */
  | { readonly tipo: 'video.inizio'; readonly telecameraId: string; readonly larghezza: number; readonly altezza: number }
  | { readonly tipo: 'video.fine'; readonly telecameraId: string; readonly motivo: string }

/**
 * I fotogrammi video non passano da JSON. Viaggiano come messaggi binari con
 * un'intestazione minima davanti, per non pagare la codifica base64 su 6 flussi.
 *
 *   byte 0        1 = chunk video
 *   byte 1        1 = fotogramma chiave (IDR), 0 = differenziale
 *   byte 2-3      lunghezza dell'identificativo di Telecamera, big endian
 *   byte 4..      identificativo in UTF-8
 *   poi           H.264 Annex-B grezzo, cosi com'e arrivato dal telefono
 */
export const MARCA_VIDEO = 1

export function impacchettaVideo(telecameraId: string, chiave: boolean, dati: Uint8Array): Buffer {
  const id = Buffer.from(telecameraId, 'utf8')
  const testa = Buffer.allocUnsafe(4 + id.length)
  testa.writeUInt8(MARCA_VIDEO, 0)
  testa.writeUInt8(chiave ? 1 : 0, 1)
  testa.writeUInt16BE(id.length, 2)
  id.copy(testa, 4)
  return Buffer.concat([testa, dati], testa.length + dati.length)
}

export function spacchettaVideo(
  b: Uint8Array,
): { telecameraId: string; chiave: boolean; dati: Uint8Array } | null {
  if (b.length < 4 || b[0] !== MARCA_VIDEO) return null
  const lunghezza = (b[2]! << 8) | b[3]!
  if (b.length < 4 + lunghezza) return null
  return {
    telecameraId: Buffer.from(b.subarray(4, 4 + lunghezza)).toString('utf8'),
    chiave: b[1] === 1,
    dati: b.subarray(4 + lunghezza),
  }
}
