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

import type {
  ImpostazioniAudio,
  ImpostazioniRegistrazione,
  ImpostazioniServer,
} from '../dominio/progetto.js'

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
  /** Rilegge l'ambiente per il Setup guidato: WSL, ffmpeg, porte, indirizzi. */
  z.object({ tipo: z.literal('ambiente.controlla') }),

  // --- Progetto e impostazioni (Setup)
  z.object({ tipo: z.literal('progetto.rinomina'), nome: z.string().min(1).max(60) }),
  z.object({ tipo: z.literal('progetto.esporta'), percorso: z.string().min(1) }),
  z.object({ tipo: z.literal('progetto.importa'), percorso: z.string().min(1) }),

  /**
   * Ogni campo e opzionale: l'interfaccia manda solo cio che ha cambiato.
   * Cambiare qualunque di questi ricostruisce la configurazione di snapserver,
   * quindi durante l'Evento e vietato -- ma l'interfaccia lo scoraggia, non il
   * motore: un rifiuto qui costerebbe piu di un errore dell'Operatore.
   */
  z.object({
    tipo: z.literal('impostazioni.audio'),
    bufferMs: z.number().int().min(200).max(4000).optional(),
    codec: z.enum(['pcm', 'opus', 'flac', 'ogg']).optional(),
    bloccoMs: z.number().int().min(5).max(100).optional(),
    dissolvenzaMs: z.number().int().min(0).max(200).optional(),
    anticipoMs: z.number().int().min(0).max(1000).optional(),
    idleThresholdMs: z.number().int().min(10).max(10000).optional(),
    portaBaseFlussi: z.number().int().min(1024).max(65000).optional(),
  }),
  z.object({
    tipo: z.literal('impostazioni.server'),
    distro: z.string().min(1).optional(),
    portaControllo: z.number().int().min(1).max(65535).optional(),
    portaHttp: z.number().int().min(1).max(65535).optional(),
    portaFlussoClient: z.number().int().min(1).max(65535).optional(),
  }),
  z.object({
    tipo: z.literal('impostazioni.registrazione'),
    cartella: z.string().min(1).optional(),
    minutiSegmento: z.number().int().min(1).max(120).optional(),
    conAudio: z.boolean().optional(),
    avvisoSpazioGb: z.number().min(0).optional(),
    bloccoSpazioGb: z.number().min(0).optional(),
  }),
  /** Apre la cartella delle registrazioni nell'esplora risorse. */
  z.object({ tipo: z.literal('registrazione.apriCartella') }),
  /** Suono di prova su tutti gli Altoparlanti di una Zona (§3.8, passo 6). */
  z.object({ tipo: z.literal('zona.provaAudio'), ...conZona }),
  /** Scrive il diario tecnico su file, per l'assistenza (§3.10). */
  z.object({ tipo: z.literal('diario.esporta'), percorso: z.string().min(1) }),
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
  /**
   * Quanti millisecondi di ritardo sul tempo reale il Flusso accumula ogni
   * secondo, misurati sugli ultimi trenta secondi (`FINESTRA_RITARDO_MS`).
   *
   * **Non e audio mancante**, ed e la ragione per cui non si chiama piu
   * `buchiMs`: il mixer non salta niente, la timeline scorre piu lenta
   * dell'orologio. Il sintomo che si sente sono i client che tagliano campioni
   * per stare in pari, e la coda prima di snapserver che si somma alla latenza.
   *
   * Zero e la condizione normale, anche sotto carico: nel banco con il thread
   * principale bloccato per 28 s su 40 resta zero. Sopra la soglia
   * dell'interfaccia (`SOGLIA_RITARDO_MS_AL_SECONDO` in `ui/nucleo/viste.ts`)
   * si mostra all'Operatore, sotto non si mostra niente.
   */
  readonly ritardoMsAlSecondo: number
  /** `null` = tutta la libreria. La schermata Zone ha bisogno di distinguerlo. */
  readonly suoniAbilitati: readonly string[] | null
  /** Lo stream Snapcast che serve questa Zona, per la diagnostica. */
  readonly flusso: string
  /**
   * Come sta lo scrittore di questo Flusso (§3.10).
   *
   * `attivo` e l'unico stato in cui esce audio. Gli altri tre sono diagnostica
   * vera: `in collegamento` per minuti significa che il server non c'e o non
   * accetta, `caduto` che la socket e morta, `fermo` che il Flusso non e
   * nemmeno partito.
   */
  readonly scrittore: 'fermo' | 'in collegamento' | 'attivo' | 'caduto'
  /**
   * Di quanto il Flusso e avanti all'orologio, in millisecondi.
   *
   * Positivo e giusto: si scrive in anticipo apposta. Negativo significa che si
   * sta rimanendo indietro, ed e il sintomo che ha portato mixer e scrittori
   * nel thread audio.
   */
  readonly scartoMs: number
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
  readonly https: boolean
  readonly utente: string | null
  /** Non la password: solo se ce n'e una. Le password non escono dal motore (§6). */
  readonly conPassword: boolean
  /**
   * Cio che il telefono racconta di se in `/info.json`, gia tradotto.
   * `null` finche non lo si e sentito almeno una volta.
   */
  readonly dettagli: {
    readonly torcia: boolean
    readonly haFlash: boolean
    readonly risoluzione: string | null
    readonly fps: number | null
    readonly obiettivo: string | null
    readonly obiettiviDisponibili: readonly string[]
    readonly risoluzioniDisponibili: readonly string[]
  } | null
  /** Vero mentre la torcia lampeggia per Identifica. */
  readonly inIdentificazione: boolean
}

export interface StatoRegistrazione {
  readonly attive: number
  readonly spazioLiberoGb: number
  readonly sottoAvviso: boolean
  readonly bloccata: boolean
  readonly cartella: string
}

export interface SuonoVivo {
  readonly id: string
  readonly nome: string
  readonly colore: string
  readonly categoria: string | null
  readonly durataMs: number | null
  readonly tastoRapido: string | null
  readonly pronto: boolean
  readonly guadagno: number
}

/**
 * Cio che il Setup guidato ha bisogno di sapere della macchina.
 *
 * Non si ricontrolla dieci volte al secondo: e una fotografia, rifatta su
 * richiesta e all'avvio. Il campo `controllatoIl` dice quanto e vecchia --
 * mostrare "porte libere" da mezz'ora fa come se fosse adesso sarebbe peggio
 * che non mostrare niente.
 */
export interface AmbienteVivo {
  /**
   * Su cosa gira il **motore**, che non e detto sia il sistema di chi guarda:
   * `--rete` serve l'interfaccia vera via HTTP, e il tablet della Fase 3 e un
   * secondo client che puo essere qualunque cosa. L'interfaccia non puo
   * dedurre la piattaforma dal proprio ambiente: gliela dice il motore.
   */
  readonly piattaforma: 'windows' | 'linux' | 'altro'
  /**
   * La **Sede** del server audio: la distro WSL su Windows, il PC stesso su
   * Linux. `assente` vuol dire che non c'e da girarci dentro -- non che manchi
   * snapserver, che e la domanda dopo.
   */
  readonly sede: 'ok' | 'assente' | 'sconosciuta'
  /** Come nominarla: «la distro "Ubuntu"», «questo PC». */
  readonly sedeDescrizione: string
  /** Perche la Sede non va, in parole. `null` se va. */
  readonly sedeMotivo: string | null
  /**
   * Cosa puo farci l'Operatore, quando c'e qualcosa da fare.
   *
   * Lo decide il motore e non l'interfaccia, perche il rimedio dipende dalla
   * diagnosi e i due casi si somigliano da fuori: "WSL non c'e" si rimedia con
   * `wsl --install`, la virtualizzazione da BIOS e un riavvio; "WSL c'e ma non
   * quella distro" si rimedia con un menu a tendina in Impostazioni. Dare il
   * primo consiglio al secondo caso vuol dire far riavviare il PC per niente.
   */
  readonly sedeRimedio: string | null
  /** Il nome della distro WSL, o `null` dove non c'e nessuna distro. */
  readonly distro: string | null
  /** Versione trovata dentro la Sede, o `null` se snapserver non c'e. */
  readonly snapserver: string | null
  /**
   * Vero se quella versione e precedente alla 0.33, dove `[tcp]` e diventata
   * `[tcp-control]`: leggerebbe meta della nostra configurazione ignorandola
   * in silenzio. Succede con l'apt di Ubuntu, che si ferma alla 0.27.
   */
  readonly snapserverVecchio: boolean
  readonly ffmpeg: string | null
  readonly porteOccupate: readonly number[]
  readonly indirizzi: readonly {
    readonly interfaccia: string
    readonly ip: string
    readonly senzaFili: boolean
  }[]
  readonly controllatoIl: string | null
}

export interface Stato {
  readonly progettoNome: string
  readonly server: StatoServer
  readonly zone: readonly ZonaViva[]
  readonly altoparlanti: readonly AltoparlanteVivo[]
  readonly telecamere: readonly TelecameraViva[]
  readonly suoni: readonly SuonoVivo[]
  readonly registrazione: StatoRegistrazione
  readonly audio: { readonly bufferMs: number; readonly codec: string; readonly bandaMbit: number }
  /**
   * Le impostazioni per intero, per la schermata Impostazioni e per il Setup.
   * Sono una trentina di numeri che cambiano quasi mai: costano meno di un
   * meccanismo di richiesta e risposta per andarsele a prendere.
   */
  readonly impostazioni: {
    readonly audio: ImpostazioniAudio
    readonly server: ImpostazioniServer
    readonly registrazione: ImpostazioniRegistrazione
  }
  readonly ambiente: AmbienteVivo
  /** Latenza attesa fra pressione e suono: `bufferMs + anticipoMs` (§8.3). */
  readonly latenzaAttesaMs: number
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
 * Il telaio vero e in `telaio-video.ts`, perche lo importa anche l'interfaccia,
 * che gira in un browser e non ha ne Zod ne `Buffer`. Qui si ri-esporta perche
 * chi legge il protocollo se lo aspetta qui.
 */
export { MARCA_VIDEO, impacchettaVideo, spacchettaVideo } from './telaio-video.js'
