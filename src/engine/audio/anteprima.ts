/**
 * L'anteprima di un Suono dalle casse del PC, non dagli Altoparlanti (§3.4).
 *
 * Serve in Setup, per riconoscere un file appena importato senza svegliare
 * tutta la casa -- e serve durante l'Evento per la stessa ragione, al
 * contrario: sentire com'e un Effetto prima di farlo partire nella stanza dove
 * ci sono i visitatori.
 *
 * Non passa dal thread audio: il thread audio parla solo con snapserver, e
 * mandare un Suono alle casse del PC da li vorrebbe dire aprire una seconda
 * uscita audio dentro il thread che non deve mai fermarsi. Si scrive invece un
 * WAV temporaneo dal PCM gia decodificato in cache e lo si da in pasto a un
 * lettore di sistema.
 *
 * **Il lettore cambia col sistema, il patto no: il processo che suona deve
 * bloccarsi fino all'ultimo campione.** E cio che rende `ferma()` possibile --
 * si uccide il processo e il suono si interrompe con lui. Un lettore che torna
 * subito e continua a suonare per conto suo porterebbe via l'audio e non ce lo
 * ridarebbe piu.
 *
 * Su Windows quel patto lo rispetta `System.Media.SoundPlayer` di .NET con
 * `PlaySync()`, che c'e su qualunque Windows 11 (con `Play()` il processo
 * uscirebbe subito). Altrove si cerca il primo dei lettori da riga di comando
 * che esiste davvero, una volta sola per tutta la vita del processo.
 *
 * Una anteprima alla volta: la seconda ferma la prima. E cio che ci si aspetta
 * premendo due pulsanti di seguito.
 *
 * **Il lettore che muore dopo essere partito si racconta, e non torna al
 * chiamante.** `suona()` risponde quando il suono e *cominciato*, non quando e
 * finito -- aspettare la fine vorrebbe dire tenere in piedi la richiesta per
 * tutta la durata del Suono -- quindi l'errore arriva dopo che si e gia
 * risposto `ok`. L'unica strada che resta e il Diario, come per ffmpeg nel
 * registratore: `suDiario` al costruttore.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { BYTE_PER_CAMPIONE, type ImpostazioniAudio } from '../dominio/progetto.js'

/** Un'intestazione WAV canonica davanti al PCM che abbiamo gia. */
export function intestazioneWav(byteDati: number, a: ImpostazioniAudio): Buffer {
  const bytePerSecondo = a.frequenza * a.canali * BYTE_PER_CAMPIONE
  const t = Buffer.alloc(44)
  t.write('RIFF', 0)
  t.writeUInt32LE(36 + byteDati, 4)
  t.write('WAVE', 8)
  t.write('fmt ', 12)
  t.writeUInt32LE(16, 16)
  t.writeUInt16LE(1, 20) // PCM
  t.writeUInt16LE(a.canali, 22)
  t.writeUInt32LE(a.frequenza, 24)
  t.writeUInt32LE(bytePerSecondo, 28)
  t.writeUInt16LE(a.canali * BYTE_PER_CAMPIONE, 32)
  t.writeUInt16LE(8 * BYTE_PER_CAMPIONE, 34)
  t.write('data', 36)
  t.writeUInt32LE(byteDati, 40)
  return t
}

/** Chi fa suonare il WAV, e con quali argomenti. */
export interface Lettore {
  readonly comando: string
  readonly argomenti: (wav: string) => string[]
}

/**
 * Il percorso viaggia come **argomento**, mai dentro una riga di comando.
 *
 * Niente shell in mezzo vuol dire niente apici da raddoppiare: un Suono che si
 * chiama `l'urlo.wav` suona, e un nome ostile non diventa un comando.
 */
function conPercorsoInCoda(comando: string, ...prima: readonly string[]): Lettore {
  return { comando, argomenti: (wav) => [...prima, wav] }
}

/**
 * I candidati su Linux, in ordine di probabilita di esserci.
 *
 * Sono stati scelti perche la loro documentazione li descrive come lettori che
 * suonano il file e poi escono -- cioe la forma di `PlaySync`, che e la sola
 * cosa che qui conta davvero. `pw-play` e il default da Ubuntu 22.10 in avanti,
 * `paplay` copre chi e rimasto a PulseAudio, `aplay` c'e anche su una macchina
 * senza server audio; `ffplay` viene per ultimo perche e **un binario diverso
 * da `ffmpeg`** e non sta nel nostro bundle -- `vendor/ffmpeg/` contiene solo
 * `ffmpeg`, quindi qui puo arrivare solo dal PATH.
 *
 * ⚠️ **Che blocchino davvero fino all'ultimo campione non e stato misurato:
 * nessuno dei quattro e mai stato eseguito** (fatti verificati, elenco di cio
 * che resta da provare su Linux). E l'ipotesi su cui poggia `ferma()`, ed e
 * l'ipotesi che si rompe per prima: un lettore che tornasse subito lasciando il
 * suono per conto suo renderebbe `ferma()` un pulsante che non ferma niente, e
 * lo si vedrebbe solo premendolo. Quando qualcuno li esegue, la riga da
 * scrivere nei fatti verificati e per ognuno «esce dopo l'ultimo campione».
 */
const LETTORI_UNIX: readonly Lettore[] = [
  conPercorsoInCoda('pw-play'),
  conPercorsoInCoda('paplay'),
  // `-q`: senza, aplay stampa una riga per ogni anteprima e sporca il log.
  conPercorsoInCoda('aplay', '-q'),
  // `-autoexit` non e un dettaglio: senza, ffplay resta aperto sull'ultimo
  // campione e il processo non finisce mai da solo. `-nodisp` toglie la
  // finestra che non ha niente da mostrare.
  conPercorsoInCoda('ffplay', '-nodisp', '-autoexit', '-loglevel', 'error'),
]

const LETTORE_WINDOWS: Lettore = {
  comando: 'powershell',
  argomenti: (wav) => [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$p = New-Object Media.SoundPlayer '${wav.replace(/'/g, "''")}'; $p.PlaySync()`,
  ],
}

/**
 * Un solo `sh` per tutti i candidati, invece di uno per candidato.
 *
 * E lo stesso motivo per cui la ricerca di snapserver in `sede.ts` e uno script
 * e non tre chiamate: cambia il nome del binario, non la domanda.
 */
const RICERCA_LETTORE = [
  `for c in ${LETTORI_UNIX.map((l) => l.comando).join(' ')}; do`,
  '  if command -v "$c" >/dev/null 2>&1; then echo "$c"; exit 0; fi',
  'done',
  'exit 1',
].join('\n')

/**
 * Un'anteprima che non suona e non lo dice e peggio di un errore.
 *
 * Il messaggio finisce in un avviso che passa da solo dopo sei secondi
 * (`main.ts`), quindi e corto e dice **cosa fare**. I nomi dei comandi sono
 * quelli che si sono appena cercati e valgono ovunque; quelli dei pacchetti
 * cambiano con la distribuzione, e sono dati come indicazione.
 */
const NESSUN_LETTORE =
  "Nessun lettore audio: per l'anteprima serve pw-play, paplay, aplay o ffplay, " +
  'e su questo sistema non c\'e nessuno dei quattro. Su Ubuntu li portano ' +
  'pipewire-bin, pulseaudio-utils, alsa-utils e ffmpeg.'

/**
 * Il lettore trovato, se e stato trovato.
 *
 * ⚠️ **Si ricorda solo il successo, mai l'assenza.** Il messaggio qui sopra
 * dice cosa installare, e chi lo installa ripreme il pulsante: ricordare il
 * `null` renderebbe quel messaggio falso appena qualcuno gli da retta, e
 * l'anteprima resterebbe muta fino al riavvio di Regia. Il prezzo e un `sh` in
 * piu solo sulla macchina che e gia rotta.
 */
let memoria: Lettore | undefined

/**
 * La scelta del lettore separata dal sistema che la informa: qui non si guarda
 * niente e non si esegue niente, si decide soltanto.
 *
 * `disponibile` e il nome che la ricerca ha trovato nel PATH, e su Windows non
 * la si fa nemmeno -- `Media.SoundPlayer` sta dentro .NET, non nel PATH.
 * Tenerla pura e cio che permette di collaudare il ramo Windows da Linux e
 * viceversa, senza far suonare niente.
 */
export function lettorePer(piattaforma: string, disponibile: string | null): Lettore | null {
  if (piattaforma === 'win32') return LETTORE_WINDOWS
  return LETTORI_UNIX.find((l) => l.comando === disponibile) ?? null
}

function lettore(): Lettore | null {
  if (memoria) return memoria
  if (process.platform === 'win32') return (memoria = LETTORE_WINDOWS)
  const r = spawnSync('sh', ['-c', RICERCA_LETTORE], { encoding: 'utf8', timeout: 10_000 })
  const trovato = lettorePer(process.platform, (r.stdout ?? '').trim() || null)
  if (trovato) memoria = trovato
  return trovato
}

/**
 * Come si racconta un'anteprima muta.
 *
 * `grave` e non `attenzione` apposta: `main.ts` fa diventare un avviso a
 * schermo solo il `grave`, e l'`attenzione` finisce nel diario delle
 * Impostazioni -- cioe in un'altra schermata, che chi ha appena premuto
 * "ascolta" non sta guardando. Lo stesso guasto preso un istante prima (nessun
 * lettore in giro) esce dal comando come errore e diventa un avviso: sarebbe
 * strano che preso un istante dopo diventasse silenzio.
 */
export type SuDiarioAnteprima = (livello: 'grave', testo: string) => void

/** L'anteprima che sta suonando adesso, e cio che serve per raccontarne la fine. */
interface InCorso {
  readonly processo: ChildProcess
  /** L'abbiamo ucciso noi: la morte che segue e voluta, non e un guasto. */
  ucciso: boolean
  /** Gia raccontata. `error` ed `exit` possono arrivare tutti e due. */
  conclusa: boolean
}

/**
 * Il lettore non e nemmeno partito: `spawn` ha fallito.
 *
 * ENOENT ed EACCES sono i due che si distinguono perche portano a due gesti
 * diversi -- installare qualcosa, o sistemare i permessi di qualcosa che c'e
 * gia -- e perche entrambi sono verosimili su Linux, dove il lettore e un
 * binario del sistema e non una libreria di .NET.
 */
function nonEPartito(l: Lettore, e: NodeJS.ErrnoException): string {
  if (e.code === 'ENOENT') {
    return (
      `Anteprima muta: "${l.comando}" non c'e piu. Reinstallalo e ripremi: al ` +
      'prossimo tentativo Regia cerca di nuovo un lettore.'
    )
  }
  if (e.code === 'EACCES') {
    return `Anteprima muta: "${l.comando}" c'e ma non si puo eseguire (permessi).`
  }
  return `Anteprima muta: "${l.comando}" non e partito: ${e.message}`
}

/** E partito ed e morto prima dell'ultimo campione. */
function finitaMale(l: Lettore, codice: number | null, segnale: NodeJS.Signals | null): string {
  if (codice === null) {
    return `Anteprima interrotta: "${l.comando}" e stato terminato da ${segnale ?? 'un segnale'}.`
  }
  return (
    `Anteprima muta: "${l.comando}" e uscito con ${codice} senza suonare. ` +
    "Guarda se su questo PC c'e un server audio in ascolto."
  )
}

export class AnteprimaSuoni {
  private inCorso: InCorso | null = null
  private temporaneo: string | null = null

  /**
   * `suDiario` e facoltativo perche l'anteprima si costruisce anche da sola nei
   * collaudi. Gli ascoltatori degli eventi invece si mettono sempre: e il
   * racconto a essere facoltativo, non la tenuta del motore.
   */
  constructor(private readonly suDiario?: SuDiarioAnteprima) {}

  /** `percorsoPcm` e il `.pcm` gia decodificato dalla libreria. */
  async suona(percorsoPcm: string, audio: ImpostazioniAudio): Promise<void> {
    await this.ferma()

    // Si cerca il lettore prima di scrivere il WAV: lasciare un file temporaneo
    // in giro per un errore che si poteva dare subito e sporcizia gratis.
    const l = lettore()
    if (!l) throw new Error(NESSUN_LETTORE)

    const pcm = await fs.readFile(percorsoPcm)
    const wav = path.join(os.tmpdir(), `regia-anteprima-${process.pid}.wav`)
    await fs.writeFile(wav, Buffer.concat([intestazioneWav(pcm.byteLength, audio), pcm]))
    this.temporaneo = wav

    const p = spawn(l.comando, l.argomenti(wav), { windowsHide: true, stdio: 'ignore' })
    const mia: InCorso = { processo: p, ucciso: false, conclusa: false }
    this.inCorso = mia

    // ⚠️ L'`exit` del processo di **prima** arriva dopo che questo e gia
    // partito: azzerare il campo allora vorrebbe dire perdere il manico
    // dell'anteprima in corso, e `ferma()` non fermerebbe piu niente. Il
    // racconto invece resta di chi e morto, anche se nel frattempo ne e partito
    // un altro: e la sua fine che si sta raccontando, non quella corrente.
    const concludi = (racconto: string | null): void => {
      if (mia.conclusa) return
      mia.conclusa = true
      if (this.inCorso === mia) {
        this.inCorso = null
        void this.pulisci()
      }
      if (racconto && !mia.ucciso) this.suDiario?.('grave', racconto)
    }

    // `command -v` ha detto che il lettore c'era; fra quel momento e adesso puo
    // essere sparito, e un evento `error` senza ascoltatore butta giu il motore.
    p.on('error', (e: NodeJS.ErrnoException) => {
      // Il lettore ricordato non e partito, quindi il ricordo e falso: si
      // scorda, per la stessa ragione per cui `memoria` ricorda solo i
      // successi. Chi rimedia ripreme il pulsante e la ricerca riparte.
      if (memoria === l) memoria = undefined
      concludi(nonEPartito(l, e))
    })
    p.on('exit', (codice, segnale) => {
      concludi(codice === 0 ? null : finitaMale(l, codice, segnale))
    })
  }

  async ferma(): Promise<void> {
    const corrente = this.inCorso
    this.inCorso = null
    if (corrente) {
      // Prima il flag, poi il colpo: `kill()` puo far arrivare l'`exit` subito,
      // e un'anteprima fermata apposta non e un guasto da raccontare.
      corrente.ucciso = true
      corrente.processo.kill()
    }
    await this.pulisci()
  }

  private async pulisci(): Promise<void> {
    const t = this.temporaneo
    this.temporaneo = null
    if (!t) return
    await fs.rm(t, { force: true }).catch(() => {})
  }
}
