/**
 * Genera `snapserver.conf` dal file di progetto.
 *
 * Ogni riga qui dentro ha una fonte in `docs/fatti-verificati.md`. Non e un file
 * di configurazione scritto a intuito: quasi ogni valore contraddice un default
 * di snapserver, e cambiarlo senza leggere la ragione rompe qualcosa che non da
 * errore -- si sente e basta, a meta serata.
 */
import {
  zoneOrdinate,
  type ImpostazioniAudio,
  type ImpostazioniServer,
  type Progetto,
} from '../dominio/progetto.js'

/** Il Flusso dei dispositivi che Regia vede ma che non sono ancora in una Zona. */
export const ID_NON_ASSEGNATI = 'Non assegnati'

export interface FlussoConfigurato {
  /** Identificativo dello stream lato Snapcast. Coincide col nome mostrato. */
  readonly id: string
  /** `null` per il Flusso dei non assegnati. */
  readonly zonaId: string | null
  readonly porta: number
}

export interface Configurazione {
  readonly testo: string
  readonly flussi: readonly FlussoConfigurato[]
  /** Tutte le porte che devono essere libere perche il server parta. */
  readonly porte: readonly number[]
}

export interface OpzioniConfigurazione {
  /**
   * Indirizzo su cui il server ascolta. Deve essere un IP NUMERICO: l'host di
   * una sorgente tcp:// finisce in boost `make_address()`, che lancia sui nomi.
   */
  readonly indirizzo: string
  /** Dove snapserver tiene il suo stato. Lo ignoriamo comunque (ADR 0005). */
  readonly datadir: string
}

export const OPZIONI_CONFIGURAZIONE: OpzioniConfigurazione = {
  indirizzo: '0.0.0.0',
  datadir: '/var/lib/snapserver',
}

/**
 * Rende un nome di Zona utilizzabile come identificativo di stream.
 *
 * Il nome viaggia dentro una query string e torna indietro nel JSON-RPC come
 * identificativo dello stream: deve sopravvivere al giro. Si tengono lettere
 * accentate e spazi (chi prepara i telefoni deve leggere "Salotto grande" in
 * Snapdroid, non "salotto_grande"), e si tolgono solo i caratteri che
 * romperebbero la query o il file .conf.
 */
export function nomeFlusso(nome: string): string {
  const pulito = nome
    .replace(/[&=?#\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
  return pulito || 'Zona'
}

/**
 * Due Zone possono chiamarsi uguale; due stream no, perche il nome *e*
 * l'identificativo. Si distingue la seconda invece di rifiutare la Zona: il
 * nome duplicato e una svista dell'Operatore in Setup, non un errore fatale.
 */
function rendiUnici(nomi: readonly string[]): string[] {
  const visti = new Map<string, number>()
  return nomi.map((n) => {
    const chiave = n.toLowerCase()
    const quante = visti.get(chiave) ?? 0
    visti.set(chiave, quante + 1)
    return quante === 0 ? n : `${n} (${quante + 1})`
  })
}

function sorgente(f: FlussoConfigurato, o: OpzioniConfigurazione, a: ImpostazioniAudio): string {
  const q = new URLSearchParams({
    name: f.id,
    mode: 'server',
    sampleformat: `${a.frequenza}:16:${a.canali}`,
    codec: a.codec,
    chunk_ms: String(a.bloccoMs),
    // Di default vale 100 ms, e il controllo di stato scatta a
    // idle_threshold + chunk_ms = 120 ms: e da li che nasce il lampeggio
    // idle <-> playing che nei test faceva smettere di suonare i client.
    idle_threshold: String(a.idleThresholdMs),
  })
  return `source = tcp://${o.indirizzo}:${f.porta}?${q.toString()}`
}

export function flussiDi(p: Progetto): FlussoConfigurato[] {
  const zone = zoneOrdinate(p)
  const nomi = rendiUnici([...zone.map((z) => nomeFlusso(z.nome)), ID_NON_ASSEGNATI])

  const flussi: FlussoConfigurato[] = zone.map((z, i) => ({
    id: nomi[i]!,
    zonaId: z.id,
    porta: p.audio.portaBaseFlussi + i,
  }))

  // Il tredicesimo. Non e un dettaglio contabile: senza un mixer che ci scrive
  // dentro, la lettura di snapserver su quella socket resta pendente, e quando
  // Identifica finalmente ci scrive si completa con un riferimento temporale
  // vecchio di minuti -- risincronizzando tutti i telefoni non ancora
  // assegnati insieme. Vedi ADR 0005, correzione.
  flussi.push({
    id: nomi[zone.length]!,
    zonaId: null,
    porta: p.audio.portaBaseFlussi + zone.length,
  })
  return flussi
}

export function generaConfigurazione(
  p: Progetto,
  opzioni: OpzioniConfigurazione = OPZIONI_CONFIGURAZIONE,
): Configurazione {
  const a: ImpostazioniAudio = p.audio
  const s: ImpostazioniServer = p.server
  const flussi = flussiDi(p)

  const righe: string[] = [
    '# Generato da Regia. Le modifiche a mano vengono sovrascritte al prossimo',
    '# cambiamento di Zona. Le ragioni dei valori stanno in docs/fatti-verificati.md.',
    '',
    '[server]',
    // ADR 0002: avahi non e compilato su Windows e da WSL in rete rispecchiata il
    // multicast verso la LAN non e affidabile. Tenerlo acceso produrrebbe solo
    // errori nel log di una distro che non ha avahi-daemon.
    'mdns_enabled = false',
    `datadir = ${opzioni.datadir}`,
    '',
    '[http]',
    'enabled = true',
    `port = ${s.portaHttp}`,
    `bind_to_address = ${opzioni.indirizzo}`,
    // Niente Snapweb: il §2.2 del documento di progetto ha verificato che ogni
    // scheda del browser con Play attivo diventa un client audio, e le schede
    // dimenticate producono audio doppio.
    'doc_root = ',
    '',
    '[tcp-control]',
    'enabled = true',
    `port = ${s.portaControllo}`,
    `bind_to_address = ${opzioni.indirizzo}`,
    '',
    '[tcp-streaming]',
    'enabled = true',
    `port = ${s.portaFlussoClient}`,
    `bind_to_address = ${opzioni.indirizzo}`,
    '',
    '[stream]',
    // I default di snapserver 0.35 sono flac / 48000:16:2 / chunk 20 / buffer
    // 1000: tutti e quattro diversi da quello che serve qui. Si scrivono
    // esplicitamente anche quando coincidono, perche il default puo cambiare.
    `sampleformat = ${a.frequenza}:16:${a.canali}`,
    `codec = ${a.codec}`,
    `chunk_ms = ${a.bloccoMs}`,
    // Unico posto dove si puo mettere: e globale, non esiste per sorgente.
    `buffer = ${a.bufferMs}`,
    // OBBLIGATORIO, e non e un'ottimizzazione. Di default snapserver smette di
    // mandare audio a un client in muto; ma "Identifica" mette in muto tutti
    // gli altri client del gruppo (ADR 0006), e al riaccenderli si
    // risincronizzerebbero -- cioe il guasto del §2.2, dieci volte per Setup.
    'send_to_muted = true',
    '',
    ...flussi.map((f) => sorgente(f, opzioni, a)),
    '',
    '[streaming_client]',
    'initial_volume = 100',
    '',
    '[logging]',
    'filter = *:info',
    '',
  ]

  return {
    testo: righe.join('\n'),
    flussi,
    porte: [s.portaHttp, s.portaControllo, s.portaFlussoClient, ...flussi.map((f) => f.porta)],
  }
}
