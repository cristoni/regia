/**
 * Il ponte TCP che rende snapserver raggiungibile dai telefoni.
 *
 * Serve per una ragione misurata, non per prudenza. In `networkingMode=NAT` --
 * cioe la configurazione di un Windows di fabbrica, e da oggi anche di questa
 * macchina, visto che `mirrored` si e rotto -- **WSL inoltra le porte in ascolto
 * solo su `127.0.0.1`**: `netstat` mostra `127.0.0.1:1704 LISTENING` e
 * `192.168.1.4:1704` irraggiungibile. Windows arriva a snapserver, il telefono no.
 *
 * `netsh interface portproxy` risolverebbe, ma vuole l'amministratore. Questo
 * ponte in spazio utente **non lo vuole**, ed e bastato a far collegare un
 * Pixel 10 vero e a fargli suonare il Flusso. Vedi ADR 0010.
 *
 * Si accende **solo se serve**: se la porta e gia raggiungibile dall'esterno --
 * `mirrored` funzionante, oppure un portproxy gia messo a mano -- il `listen`
 * su `0.0.0.0` fallisce con `EADDRINUSE`, e quella e la risposta. Non c'e una
 * impostazione da indovinare: la rete dice da sola in che modo e configurata.
 *
 * ⚠️ **La destinazione e l'IP della distro, mai `127.0.0.1`.** Sembra
 * equivalente e non lo e: `0.0.0.0` **contiene** `127.0.0.1`, quindi un ponte
 * che inoltra al proprio indirizzo di ascolto si collega a se stesso. Il giro
 * a vuoto che ne esce accetta connessioni all'istante e non risponde mai,
 * cioe si comporta esattamente come un server acceso per chiunque guardi solo
 * l'esito di `connect()`. E costato un pomeriggio: il supervisore adottava il
 * proprio ponte, si dichiarava acceso, e non avviava mai snapserver.
 *
 * Costo: snapserver vede tutti i client all'indirizzo del ponte (`127.0.0.1`)
 * invece che al loro. Il riconciliatore non ne soffre -- abbina per client id,
 * non per indirizzo -- ma `AltoparlanteVivo.indirizzo` diventa inutilizzabile
 * finche si passa di qui, e l'interfaccia deve dirlo invece di mostrare un
 * indirizzo falso.
 */
import { connect, createServer, type Server, type Socket } from 'node:net'

export interface PortaPonte {
  readonly porta: number
  readonly attivo: boolean
  /** Perche non e attivo. `null` se lo e. */
  readonly motivo: string | null
}

/**
 * Un indirizzo di loopback e la fine del ponte, non un caso limite: inoltrarci
 * dentro significa richiamare il proprio `listen` su `0.0.0.0`.
 */
export function diLoopback(indirizzo: string): boolean {
  return indirizzo === 'localhost' || indirizzo === '::1' || /^127\./.test(indirizzo)
}

export class Ponte {
  private readonly servitori = new Map<number, Server>()
  private readonly esiti = new Map<number, PortaPonte>()
  /** Tutte le connessioni in piedi, per poterle chiudere davvero. */
  private readonly aperte = new Set<Socket>()
  /** Stiamo smontando il ponte: le chiusure che ne seguono le abbiamo volute noi. */
  private smontando = false
  private destinazione = ''

  constructor(private readonly suDiario: (livello: 'info' | 'attenzione', testo: string) => void) {}

  stato(): PortaPonte[] {
    return [...this.esiti.values()].sort((a, b) => a.porta - b.porta)
  }

  get attivoSuQualcosa(): boolean {
    return [...this.esiti.values()].some((e) => e.attivo)
  }

  /**
   * @param destinazione IP a cui inoltrare. **Non puo essere di loopback**:
   *   sarebbe il proprio indirizzo di ascolto, e il ponte parlerebbe con se
   *   stesso. Chi chiama deve passare l'IP della distro.
   */
  async apri(porte: readonly number[], destinazione: string): Promise<void> {
    await this.chiudi()
    if (diLoopback(destinazione)) {
      this.suDiario(
        'attenzione',
        `Ponte non aperto: "${destinazione}" e un indirizzo di loopback, e il ponte ` +
          'si collegherebbe a se stesso invece che al server audio.',
      )
      return
    }
    this.smontando = false
    this.destinazione = destinazione
    for (const porta of porte) this.esiti.set(porta, await this.apriUna(porta))

    const attive = this.stato().filter((e) => e.attivo)
    if (attive.length > 0) {
      this.suDiario(
        'info',
        `Ponte di rete attivo sulle porte ${attive.map((a) => a.porta).join(', ')} ` +
          `verso ${destinazione}: i telefoni raggiungono il server audio attraverso il PC.`,
      )
    }
  }

  async chiudi(): Promise<void> {
    this.smontando = true
    for (const s of this.aperte) s.destroy()
    this.aperte.clear()
    const servitori = [...this.servitori.values()]
    this.servitori.clear()
    this.esiti.clear()
    await Promise.all(servitori.map((s) => new Promise<void>((ok) => s.close(() => ok()))))
  }

  // -------------------------------------------------------------- interni

  private apriUna(porta: number): Promise<PortaPonte> {
    return new Promise((risolvi) => {
      const s = createServer((dentro) => this.inoltra(dentro, porta))

      s.once('error', (e: NodeJS.ErrnoException) => {
        // `EADDRINUSE` qui non e un guasto: e la prova che qualcun altro --
        // WSL in rete rispecchiata, o un portproxy -- gia serve quella porta
        // sull'indirizzo di rete. Il ponte non serve, e non si insiste.
        risolvi({
          porta,
          attivo: false,
          motivo:
            e.code === 'EADDRINUSE'
              ? 'gia raggiungibile senza ponte'
              : `non apribile: ${e.message}`,
        })
      })

      s.once('listening', () => {
        this.servitori.set(porta, s)
        risolvi({ porta, attivo: true, motivo: null })
      })

      s.listen(porta, '0.0.0.0')
    })
  }

  private inoltra(dentro: Socket, porta: number): void {
    const fuori = connect({ host: this.destinazione, port: porta })
    this.aperte.add(dentro)
    this.aperte.add(fuori)

    // Nagle spegnerebbe la latenza del canale di controllo, e sul flusso audio
    // accumulerebbe blocchi per farne pacchetti pieni: esattamente cio che non
    // si vuole su un percorso che deve restare puntuale.
    dentro.setNoDelay(true)
    fuori.setNoDelay(true)

    // Chi ha chiuso per primo, e da quanto non passavano byte.
    //
    // Non e strumentazione di lusso: un telefono che si ricollega ogni pochi
    // secondi lo si vede da fuori come "si scollega", e le due spiegazioni
    // possibili chiedono rimedi opposti. Se il telefono manda FIN **mentre**
    // il server gli stava mandando audio, ha rinunciato lui (Wi-Fi suo, o la
    // sua CPU); se invece l'ultimo byte in discesa e vecchio di secondi, e
    // questo ponte che e rimasto fermo -- e sta sul thread principale, insieme
    // al video e alle istantanee. Senza questa riga si tira a indovinare.
    const nato = performance.now()
    // `null` fino al primo byte, e non `nato`: una connessione morta a tre
    // secondi senza aver ricevuto niente direbbe "ultimo byte giu tre secondi
    // fa", cioe esattamente cio che direbbe un ponte fermo per tre secondi in
    // mezzo al flusso. Sono i due casi che questa misura deve distinguere.
    let ultimoGiu: number | null = null // ultimo byte server -> telefono
    let ultimoSu: number | null = null // ultimo byte telefono -> server
    let causa: string | null = null
    const primo = (c: string) => {
      causa ??= c
    }

    dentro.on('data', () => {
      ultimoSu = performance.now()
    })
    fuori.on('data', () => {
      ultimoGiu = performance.now()
    })
    dentro.on('end', () => primo('chiusa dal telefono'))
    fuori.on('end', () => primo('chiusa dal server audio'))

    let riferito = false
    const chiudi = (e?: Error) => {
      if (e) primo(`errore: ${e.message}`)
      if (!riferito && !this.smontando) {
        riferito = true
        const ora = performance.now()
        this.riferisci(porta, causa ?? 'chiusa senza dirlo', {
          durataMs: ora - nato,
          fermoGiuMs: ultimoGiu === null ? null : ora - ultimoGiu,
          fermoSuMs: ultimoSu === null ? null : ora - ultimoSu,
          giuByte: dentro.bytesWritten,
          suByte: fuori.bytesWritten,
        })
      }
      this.aperte.delete(dentro)
      this.aperte.delete(fuori)
      dentro.destroy()
      fuori.destroy()
    }
    dentro.on('error', chiudi)
    fuori.on('error', chiudi)
    dentro.on('close', () => chiudi())
    fuori.on('close', () => chiudi())

    dentro.pipe(fuori)
    fuori.pipe(dentro)
  }

  /**
   * Una riga per connessione chiusa, e un avviso se e durata poco.
   *
   * Poco vuol dire meno di mezzo minuto: le connessioni di Snapdroid che
   * durano una vita sono la normalita, e una che muore in tre secondi mentre
   * scendevano centinaia di kilobyte e' il sintomo che si sta cercando.
   */
  private riferisci(
    porta: number,
    causa: string,
    m: {
      durataMs: number
      fermoGiuMs: number | null
      fermoSuMs: number | null
      giuByte: number
      suByte: number
    },
  ): void {
    const kB = (b: number) => `${Math.round(b / 1024)} kB`
    const s = (ms: number | null) => (ms === null ? 'mai' : `${(ms / 1000).toFixed(1)} s fa`)
    const breve = m.durataMs < 30_000 && m.giuByte > 0
    this.suDiario(
      breve ? 'attenzione' : 'info',
      `Ponte ${porta}: ${causa} dopo ${(m.durataMs / 1000).toFixed(1)} s ` +
        `(giu ${kB(m.giuByte)}, su ${kB(m.suByte)}; ` +
        `ultimo byte giu ${s(m.fermoGiuMs)}, su ${s(m.fermoSuMs)}).`,
    )
  }
}
