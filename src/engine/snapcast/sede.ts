/**
 * **La Sede**: la macchina, vera o virtuale, dove gira snapserver.
 *
 * Su Windows la Sede e una distro WSL, perche snapserver non gira nativo
 * (ADR 0002: `BUILD_SERVER` e definito solo `if(NOT WIN32)`). Su Linux la Sede
 * e il PC stesso: il sistema operativo *e* gia quello che a snapserver serve,
 * e tutto il giro di `wsl.exe` sparisce.
 *
 * Il resto del motore parla solo con questa interfaccia. Il supervisore non sa
 * -- e non deve sapere -- se il comando che manda finisce dentro una macchina
 * virtuale o dentro una `bash` a due centimetri da lui: sa che c'e una Sede,
 * che dentro c'e snapserver, e che si scrivono file e si eseguono comandi.
 *
 * ⚠️ **Due valori che sembrano lo stesso valore e non lo sono.** Prima di
 * questa interfaccia esisteva un solo `indirizzoDistro()`, e serviva a due
 * cose insieme: dire al thread audio dove aprire le socket delle sorgenti, e
 * dire al ponte dove inoltrare. Su Windows coincidono. Su Linux **divergono**:
 * l'indirizzo delle sorgenti e `127.0.0.1` -- che li e davvero giusto, gli
 * inoltri fantasma di WSL non esistono -- ma il ponte **non va aperto affatto**,
 * perche snapserver ascolta gia su `0.0.0.0` e i telefoni lo raggiungono da
 * soli. Passare `127.0.0.1` a `Ponte.apri()` lo farebbe rifiutare da
 * `diLoopback()` e scrivere nel Diario "i telefoni potrebbero non vedere il
 * server audio" -- una frase falsa, che manderebbe qualcuno a cercare un
 * guasto che non c'e. Da qui `indirizzoFlussi()` e `serveIlPonte`, separati.
 *
 * Le due forme stanno nello stesso file per una ragione meccanica: condividono
 * le costanti di ricerca di snapserver, e separarle in due moduli creerebbe un
 * ciclo di import fra il file che sceglie e il file che implementa.
 */
import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import type { ImpostazioniServer } from '../dominio/progetto.js'

/** L'esito grezzo di un comando dentro la Sede. */
export interface EsitoSede {
  readonly stato: number
  readonly uscita: string
  readonly errore: string
}

export interface OpzioniEsecuzione {
  readonly timeoutMs?: number
  readonly ingresso?: string
}

export interface SnapserverTrovato {
  /** Percorso **dentro la Sede**: su Windows e un percorso della distro. */
  readonly percorso: string
  /** Come `0.35.0`. Stringa vuota se il binario c'e ma non l'ha detta. */
  readonly versione: string
}

/** Perche la Sede non c'e, e cosa ci si puo fare. */
export interface MotivoIndisponibile {
  /** Gia buono per il Diario e per un messaggio d'errore. */
  readonly motivo: string
  /** Cosa deve fare l'Operatore, se c'e qualcosa che puo fare. */
  readonly rimedio: string | null
}

export interface Sede {
  /** `wsl` quando snapserver sta in una distro, `locale` quando sta qui. */
  readonly genere: 'wsl' | 'locale'
  /** Come nominarla in un messaggio all'Operatore. */
  readonly descrizione: string
  /**
   * Vero se i telefoni **non** raggiungono snapserver da soli e serve il ponte
   * di Regia (ADR 0010). Falso quando snapserver ascolta gia sulla LAN.
   */
  readonly serveIlPonte: boolean
  /** Cartella di lavoro dentro la Sede: `snapserver.conf`, `server.log`. */
  readonly cartellaLavoro: string
  /** Dove snapserver tiene il suo stato. Lo ignoriamo comunque (ADR 0005). */
  readonly datadir: string

  /**
   * `null` se la Sede c'e ed e utilizzabile; altrimenti perche no.
   *
   * Il **rimedio viaggia col motivo**, e non e un vezzo. Chi sa qual e il
   * rimedio e chi ha fatto la diagnosi: `SedeWsl` distingue "WSL non c'e" --
   * dove si rimedia con `wsl --install`, la virtualizzazione da BIOS e un
   * riavvio -- da "WSL c'e ma quella distro no", dove quella procedura non
   * serve a niente e va cambiata la distro nelle Impostazioni. Lasciando che
   * fosse l'interfaccia a indovinarlo dal testo del motivo, i due casi sono
   * finiti sotto lo stesso consiglio: quello sbagliato per il piu comune dei
   * due, cioe il primo avvio su un PC dove WSL c'era gia.
   */
  indisponibile(): Promise<MotivoIndisponibile | null>

  /** Snapserver dentro la Sede, o `null` se non c'e. */
  snapserver(): Promise<SnapserverTrovato | null>

  esegui(comando: string, opzioni?: OpzioniEsecuzione): Promise<EsitoSede>

  /**
   * Scrive un file dentro la Sede senza passare da un heredoc: qualunque cosa
   * ci sia dentro il contenuto -- apici, backtick, `$(`, accenti -- non viene
   * interpretata da nessuna shell.
   */
  scrivi(percorso: string, contenuto: string): Promise<EsitoSede>

  /**
   * L'indirizzo a cui il **thread audio** apre le tredici socket delle
   * sorgenti. Non e l'indirizzo del ponte: vedi la nota in cima al file.
   */
  indirizzoFlussi(): Promise<string | null>
}

// --------------------------------------------------------------- la scelta

/**
 * Quale Sede vale su questa macchina.
 *
 * Si guarda `process.platform` e basta: non c'e una impostazione da indovinare
 * e non c'e un caso misto. Su Windows snapserver **non puo** girare nativo, su
 * Linux **non serve** una macchina virtuale per farlo girare.
 *
 * macOS finisce nel ramo locale: snapserver ci compila (`BUILD_SERVER` e
 * escluso solo per WIN32), ma nessuno l'ha mai provato qui -- vale quel che
 * vale, e almeno non pretende un `wsl.exe` che li non esiste.
 */
export function sedeDi(server: ImpostazioniServer): Sede {
  return process.platform === 'win32' ? new SedeWsl(server.distro) : new SedeLocale()
}

// ------------------------------------------------------ versione minima

/**
 * Sotto la 0.33 il file di configurazione che generiamo **non e quello giusto**,
 * e non lo dice nessuno.
 *
 * In 0.33 la sezione `[tcp]` e diventata `[tcp-control]` e le impostazioni di
 * streaming TCP sono uscite da `[stream]`. Un snapserver piu vecchio legge il
 * nostro file, ignora in silenzio le sezioni che non conosce, parte, e ascolta
 * sulle porte sbagliate con i default suoi. Il sintomo si scopre a meta serata:
 * i telefoni non si collegano e il log del server non ha errori.
 *
 * Non e un caso di scuola: l'apt di Ubuntu 24.04 fornisce la **0.27.0** del
 * 2022 (ADR 0003). Su Linux e la versione che si becca chi fa `apt install
 * snapserver` senza sapere, ed e la prima cosa che andra storta a qualcuno.
 */
export const VERSIONE_MINIMA_SNAPSERVER = '0.33.0'

/** Vero se questa versione non capisce il file che sappiamo scrivere. */
export function versioneTroppoVecchia(versione: string | null | undefined): boolean {
  // Non saperlo non e sapere che e vecchia: si blocca solo su una prova.
  if (!versione) return false
  const pezzi = (n: string): number[] => n.split('.').map((x) => Number(x) || 0)
  const a = pezzi(versione)
  const b = pezzi(VERSIONE_MINIMA_SNAPSERVER)
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x < y
  }
  return false
}

/** Dove Regia si aspetta di trovare snapserver quando se lo porta dietro. */
export const PREFISSO_SNAPSERVER = '/opt/snapserver-0.35'
export const BINARIO_SNAPSERVER = `${PREFISSO_SNAPSERVER}/usr/bin/snapserver`

/**
 * Dove si cerca snapserver, in ordine, **dentro** la Sede.
 *
 * E uno script di shell e non tre chiamate perche vale identico nelle due
 * Sedi: cambia come si esegue `bash`, non cosa gli si chiede.
 *
 * L'ordine e deliberato: `REGIA_SNAPSERVER` per chi sa cosa sta facendo, poi
 * il prefisso fissato che `banco/prepara.ts` costruisce gia oggi (ed e gia un
 * percorso Linux), poi il PATH -- che e l'unico posto da cui puo saltare fuori
 * una 0.27 di distribuzione, ed e per questo che viene per ultimo.
 *
 * ⚠️ **Le righe che ci interessano sono marcate, e si leggono solo quelle.**
 * I comandi girano in una shell di *login* (`bash -lc`), che e l'unico modo di
 * avere il PATH che l'utente si aspetta; ma una shell di login sorgente
 * `/etc/profile` e `~/.profile`, e li dentro puo stampare qualunque cosa: un
 * saluto, un avviso di aggiornamenti, il banner di uno strumento che si
 * installa da se. Dentro la distro dedicata dell'ADR 0003 non stampa mai
 * niente e la cosa non si vedeva; su un PC Linux di qualcuno e la normalita.
 * Prendere "la prima riga" come percorso vorrebbe dire prendere quel saluto e
 * provare a eseguirlo.
 */
const MARCA = 'REGIA-SEDE'

const RICERCA_SNAPSERVER = [
  `for c in "$REGIA_SNAPSERVER" ${BINARIO_SNAPSERVER} "$(command -v snapserver 2>/dev/null)"; do`,
  '  if [ -n "$c" ] && [ -x "$c" ]; then',
  `    echo "${MARCA}-DOVE:$c"`,
  `    echo "${MARCA}-VERSIONE:$("$c" -v 2>&1 | head -1)"`,
  '    exit 0',
  '  fi',
  'done',
  'exit 1',
].join('\n')

/** Il valore di una riga marcata, o `null` se quella riga non c'e. */
function marcata(uscita: string, campo: string): string | null {
  const prefisso = `${MARCA}-${campo}:`
  for (const riga of uscita.split(/\r?\n/)) {
    const t = riga.trim()
    if (t.startsWith(prefisso)) return t.slice(prefisso.length).trim()
  }
  return null
}

/** Legge le righe marcate di `RICERCA_SNAPSERVER`, ignorando tutto il resto. */
export function leggiSnapserver(e: EsitoSede): SnapserverTrovato | null {
  if (e.stato !== 0) return null
  const percorso = marcata(e.uscita, 'DOVE')
  if (!percorso) return null
  const v = /v?(\d+\.\d+\.\d+)/.exec(marcata(e.uscita, 'VERSIONE') ?? '')
  // Il binario c'e ma non dice la versione: si riporta lo stesso. Il Setup
  // deve poter distinguere "manca" da "c'e ma e strano".
  return { percorso, versione: v ? v[1]! : '' }
}

// -------------------------------------------------------- la Sede locale

/**
 * Snapserver gira su questa macchina, senza intermediari. E il caso Linux.
 *
 * E piu semplice non per fortuna ma per costruzione: tutto cio che su Windows
 * costa un `wsl.exe` -- l'indirizzo che cambia, gli inoltri fantasma, l'UTF-16,
 * il gruppo di processi che muore -- qui non esiste proprio.
 *
 * Resta una differenza che conta e che non e cosmetica: **Regia gira come
 * l'utente che ha fatto login**, non come root dentro una distro dedicata.
 * Quindi niente `/var/lib/snapserver`, che un utente normale non puo scrivere,
 * e niente `/tmp/regia` nudo, che appartiene al primo che lo crea e che il
 * secondo utente della stessa macchina non potrebbe usare.
 */
export class SedeLocale implements Sede {
  readonly genere = 'locale' as const
  readonly descrizione = 'questo PC'
  /**
   * Snapserver ascolta gia su `0.0.0.0`: i telefoni lo raggiungono da soli, e
   * un ponte in mezzo aggiungerebbe una copia di ogni byte audio dentro il
   * nostro processo senza guadagnare niente.
   */
  readonly serveIlPonte = false
  readonly cartellaLavoro: string
  readonly datadir: string

  /**
   * I percorsi si compongono con `path.posix`, non con `path`, e non e
   * pedanteria: finiscono dentro un comando di shell POSIX, e su Windows
   * `path.join` produrrebbe delle barre rovesciate. Questa Sede su Windows non
   * si costruisce mai -- ma il codice che si legge deve dire cosa e vero, non
   * dipendere dal fatto che il caso sbagliato non capita.
   */
  constructor(cartellaLavoro = cartellaLavoroLocale()) {
    this.cartellaLavoro = cartellaLavoro
    this.datadir = path.posix.join(cartellaLavoro, 'dati')
  }

  async indisponibile(): Promise<MotivoIndisponibile | null> {
    // La Sede e la macchina stessa: c'e sempre. Cio che puo mancare e
    // snapserver, e lo dice `snapserver()`. Due domande, due risposte.
    return null
  }

  async snapserver(): Promise<SnapserverTrovato | null> {
    return leggiSnapserver(await this.esegui(RICERCA_SNAPSERVER, { timeoutMs: 15_000 }))
  }

  esegui(comando: string, opzioni: OpzioniEsecuzione = {}): Promise<EsitoSede> {
    return eseguiProcesso('bash', ['-lc', comando], opzioni)
  }

  async scrivi(percorso: string, contenuto: string): Promise<EsitoSede> {
    try {
      await fs.mkdir(path.posix.dirname(percorso), { recursive: true })
      await fs.writeFile(percorso, contenuto, 'utf8')
      return { stato: 0, uscita: '', errore: '' }
    } catch (e) {
      return { stato: -1, uscita: '', errore: (e as Error).message }
    }
  }

  /**
   * `127.0.0.1`, e qui e la risposta giusta e non un ripiego.
   *
   * Su Windows partire dal loopback e un errore misurato: gli inoltri che WSL
   * crea sopravvivono al processo che ascoltava, e `connect()` riesce verso il
   * nulla. Quel meccanismo qui non esiste -- non c'e nessun WSL a creare
   * inoltri -- e snapserver ascolta su `0.0.0.0`, che contiene il loopback.
   */
  async indirizzoFlussi(): Promise<string | null> {
    return '127.0.0.1'
  }
}

/**
 * `XDG_RUNTIME_DIR` quando c'e -- su un desktop Linux con systemd c'e sempre,
 * ed e per utente e ripulita al logout, cioe esattamente il posto previsto per
 * questa roba. Altrimenti una cartella nel temporaneo **legata all'utente**.
 */
function cartellaLavoroLocale(): string {
  const xdg = process.env['XDG_RUNTIME_DIR']
  if (xdg) return path.posix.join(xdg, 'regia')
  const chi = process.getuid?.() ?? process.env['USER'] ?? 'utente'
  return path.posix.join(os.tmpdir(), `regia-${chi}`)
}

// ----------------------------------------------------------- la Sede WSL

/**
 * Snapserver gira dentro una distro WSL. E il caso Windows, e ogni riga qui
 * dentro e costata.
 *
 *  - **`setsid` e obbligatorio.** Snapserver muore con `Received signal 1:
 *    Hangup` appena esce il `wsl.exe` che l'ha lanciato: WSL termina il gruppo
 *    di processi della sessione, e `nohup` da solo non basta. (Il `setsid` sta
 *    nel supervisore, dove si scrive il comando di avvio.)
 *  - **`wsl.exe` risponde in UTF-16LE** quando parla lui (elenco distro,
 *    errori), e in UTF-8 quando l'uscita viene da un comando dentro la distro.
 *    Si legge grezzo e si decide.
 */
export class SedeWsl implements Sede {
  readonly genere = 'wsl' as const
  readonly serveIlPonte = true
  /**
   * `/tmp/regia` dentro la distro. Li e senza rischi: la distro e dedicata a
   * Regia (ADR 0003) e i comandi girano come root.
   */
  readonly cartellaLavoro = '/tmp/regia'
  readonly datadir = '/tmp/regia/dati'

  constructor(private readonly distro: string) {}

  get descrizione(): string {
    return `la distro "${this.distro}"`
  }

  async indisponibile(): Promise<MotivoIndisponibile | null> {
    const installate = await distroInstallate()
    // WSL non c'e proprio: e l'unico caso in cui serve il giro lungo, ed e
    // anche l'unico in cui non si puo promettere che sia veloce.
    if (installate === null) {
      return {
        motivo: 'WSL non e installato: il server audio non puo partire (ADR 0002)',
        rimedio:
          'Apri PowerShell come amministratore, lancia "wsl --install", poi riavvia. ' +
          'Serve anche Virtual Machine Platform, e la virtualizzazione abilitata da BIOS.',
      }
    }
    // WSL c'e, manca solo quella distro: `wsl --install` qui non c'entra
    // niente, e mandarci l'Operatore vuol dire fargli riavviare il PC per un
    // guasto che si risolve con un menu a tendina.
    if (!installate.includes(this.distro)) {
      return {
        motivo:
          `la distro "${this.distro}" non c'e. ` +
          `Distro disponibili: ${installate.join(', ') || 'nessuna'}`,
        rimedio:
          installate.length > 0
            ? 'WSL c\'e: scegli una delle distro disponibili in Impostazioni, oppure installa questa.'
            : "WSL c'e ma non ha nessuna distro: installane una, per esempio con \"wsl --install -d Ubuntu\".",
      }
    }
    return null
  }

  async snapserver(): Promise<SnapserverTrovato | null> {
    if (await this.indisponibile()) return null
    return leggiSnapserver(await this.esegui(RICERCA_SNAPSERVER, { timeoutMs: 20_000 }))
  }

  /**
   * Un comando dentro la distro, senza bloccare il thread principale.
   *
   * Non blocca perche serve durante l'Evento: mezzo secondo di `spawnSync` qui
   * e mezzo secondo di interfaccia ferma. Il thread audio sta altrove, ma i
   * comandi passano comunque da questo.
   */
  esegui(comando: string, opzioni: OpzioniEsecuzione = {}): Promise<EsitoSede> {
    return eseguiProcesso(
      'wsl',
      ['-d', this.distro, '-u', 'root', '-e', 'bash', '-lc', comando],
      opzioni,
      decodificaWsl,
    )
  }

  /** Il contenuto arriva sullo standard input di `cat`: bash non lo tocca. */
  scrivi(percorso: string, contenuto: string): Promise<EsitoSede> {
    const cartella = percorso.slice(0, percorso.lastIndexOf('/')) || '/'
    return this.esegui(`mkdir -p '${cartella}' && cat > '${percorso}'`, { ingresso: contenuto })
  }

  /**
   * L'indirizzo IP della distro, visto da Windows.
   *
   * E l'indirizzo a cui bisogna parlare, e **non** `127.0.0.1`. In
   * `networkingMode=NAT` WSL mette in piedi un inoltro da `127.0.0.1:<porta>`
   * verso la distro per ogni porta in ascolto -- comodo, e pieno di fantasmi:
   * l'inoltro **sopravvive alla morte del processo** che ascoltava, quindi una
   * `connect()` su `127.0.0.1` riesce, i byte partono, e non li legge nessuno.
   * E indistinguibile da un server che accetta e non consuma. Parlando
   * direttamente alla distro quel tramite non esiste.
   *
   * Cambia a ogni riavvio della distro, quindi si rilegge invece di ricordarlo.
   */
  async indirizzoFlussi(): Promise<string | null> {
    const r = await this.esegui("hostname -I | awk '{print $1}'", { timeoutMs: 10_000 })
    if (r.stato !== 0) return null
    // Si cerca la riga che **e** un indirizzo, invece di pretendere che l'uscita
    // sia solo quella: anche qui il profilo di login puo aver stampato altro.
    for (const riga of r.uscita.split(/\r?\n/)) {
      const t = riga.trim()
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) return t
    }
    return null
  }
}

/**
 * `wsl.exe -l -q` e gli errori di `wsl.exe` stesso arrivano in UTF-16LE, senza
 * BOM affidabile. L'euristica che regge: se un byte su due e zero, e UTF-16.
 */
function decodificaWsl(b: Buffer): string {
  if (b.length >= 4 && b[1] === 0 && b[3] === 0) return b.toString('utf16le').replace(/\0/g, '')
  return b.toString('utf8').replace(/\0/g, '')
}

/** Le distro installate, o `null` se `wsl.exe` non c'e proprio. */
export async function distroInstallate(): Promise<string[] | null> {
  if (process.platform !== 'win32') return null
  const r = await eseguiProcesso('wsl', ['-l', '-q'], { timeoutMs: 15_000 }, decodificaWsl)
  if (r.stato !== 0) return null
  return r.uscita
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}

// ------------------------------------------------------------------ comune

/** Un processo, letto fino in fondo, con un timeout che non lascia zombie. */
export function eseguiProcesso(
  comando: string,
  argomenti: readonly string[],
  opzioni: OpzioniEsecuzione = {},
  decodifica: (b: Buffer) => string = (b) => b.toString('utf8').replace(/\0/g, ''),
): Promise<EsitoSede> {
  return new Promise((risolvi) => {
    const p = spawn(comando, [...argomenti], { windowsHide: true })
    const fuori: Buffer[] = []
    const err: Buffer[] = []
    let finito = false

    const chiudi = (esito: EsitoSede): void => {
      if (finito) return
      finito = true
      clearTimeout(scadenza)
      risolvi(esito)
    }

    const scadenza = setTimeout(() => {
      if (!finito) p.kill()
    }, opzioni.timeoutMs ?? 15_000)
    scadenza.unref?.()

    p.stdout.on('data', (d: Buffer) => fuori.push(d))
    p.stderr.on('data', (d: Buffer) => err.push(d))
    p.on('error', (e) => chiudi({ stato: -1, uscita: '', errore: e.message }))
    p.on('close', (stato) =>
      chiudi({
        stato: stato ?? -1,
        uscita: decodifica(Buffer.concat(fuori)).trim(),
        errore: decodifica(Buffer.concat(err)).trim(),
      }),
    )

    // Il processo puo essere gia morto quando si scrive: lo dira `close`, e un
    // EPIPE non gestito qui butterebbe giu il motore.
    p.stdin.on('error', () => {})
    if (opzioni.ingresso !== undefined) p.stdin.end(opzioni.ingresso)
    else p.stdin.end()
  })
}
