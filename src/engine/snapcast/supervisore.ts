/**
 * Il supervisore: tiene in piedi snapserver e lo tiene somigliante al progetto.
 *
 * Mette insieme quattro cose che da sole non servirebbero a niente: il processo
 * dentro la distro WSL, il ponte di rete che lo rende raggiungibile dai
 * telefoni, la connessione JSON-RPC, e il riconciliatore -- che e una funzione
 * pura e ha bisogno di qualcuno che gli porti lo stato osservato e applichi le
 * azioni.
 *
 * Il principio e sempre quello dell'ADR 0005: **il file di progetto e la
 * verita, Snapcast e una proiezione**. Qui non si prende nessuna decisione di
 * dominio; si osserva com'e messo il server, si chiede al riconciliatore cosa
 * fare, e lo si fa. Quando qualcuno cambia una Zona a mano da Snapdroid, la
 * passata successiva la rimette dov'e giusto, e va bene cosi.
 *
 * La passata periodica non e una rete di sicurezza generica: e la protezione
 * prevista dall'ADR 0006. Identifica mette in muto gli altri client del gruppo,
 * e se qualcosa muore a meta sequenza un telefono resterebbe muto per tutta la
 * serata. Ri-affermare i volumi dal progetto ogni pochi secondi lo riporta a
 * posto da solo.
 */
import { EventEmitter } from 'node:events'

import type { Progetto } from '../dominio/progetto.js'
import { latenzaAttesaMs } from '../dominio/progetto.js'
import type { StatoServer } from '../api/protocollo.js'
import { Ponte } from '../rete/ponte.js'
import {
  BINARIO_SNAPSERVER,
  CARTELLA_DISTRO,
  distroInstallate,
  eseguiNellaDistroAsync,
  indirizzoDistro,
  scriviNellaDistro,
} from './distro.js'
import { generaConfigurazione } from './configurazione.js'
import { ClientRpc, OPZIONI_RPC } from './rpc.js'
import { pianifica, type Azione, type StatoOsservato } from './riconciliatore.js'

/** Cio che il motore vuole sapere di un client, oltre a quel che c'e nel progetto. */
export interface ClientVivo {
  readonly collegato: boolean
  readonly indirizzo: string | null
  readonly nome: string
}

export interface OpzioniSupervisore {
  /** Letto ogni volta, mai copiato: il progetto cambia sotto i piedi. */
  readonly progetto: () => Progetto
  readonly suDiario: (livello: 'info' | 'attenzione' | 'grave', testo: string) => void
  /** Un client mai visto prima: il motore decide se aggiungerlo al progetto. */
  readonly suClientNuovo: (clientId: string, nome: string) => void
  /**
   * Fa suonare il segnale di Identifica nel Flusso indicato, e dice quanti
   * millisecondi passeranno prima che sia finito di suonare sui telefoni.
   */
  readonly suonaIdentifica: (chiaveFlusso: string) => number
  /**
   * L'indirizzo della distro e cambiato (o si e saputo per la prima volta).
   *
   * Serve al thread audio: gli scrittori devono aprire le socket verso la
   * distro, non verso `127.0.0.1`, dove gli inoltri di WSL sopravvivono al
   * processo che ascoltava e accettano byte che nessuno leggera.
   */
  readonly suIndirizzoDistro: (ip: string) => void
  /** Ogni quanto si ri-afferma il progetto sul server. */
  readonly cadenzaRiconciliazioneMs?: number
}

/** Millisecondi fra un tentativo di riconnessione RPC e il successivo. */
const RIPROVA_RPC_MS = 2000
/**
 * Quanto si aspetta prima di riprovare ad avviare un server che non e partito.
 * Piu lungo della riprova sulla connessione: qui si rilancia un processo in una
 * distro, e rifarlo ogni due secondi non fa che allungare la coda.
 */
const RIPROVA_AVVIO_MS = 8000

export class SupervisoreSnapcast extends EventEmitter {
  private situazione: StatoServer = 'spento'
  private readonly rpc = new ClientRpc()
  private readonly ponte: Ponte
  private osservato: StatoOsservato = { gruppi: [], clienti: [], streamIds: [] }
  private readonly vivi = new Map<string, ClientVivo>()
  private battito: NodeJS.Timeout | null = null
  private riprova: NodeJS.Timeout | null = null
  private riconciliazioneInCorso = false
  /** Le Zone sono cambiate: il riavvio e annunciato ma non ancora avvenuto. */
  private riconfigurazioneInArrivo = false
  /** Una sola Identifica alla volta (ADR 0006). */
  private identificazione: string | null = null
  private fermatoDaNoi = false
  private chiuso = false
  private ipDistro: string | null = null

  constructor(private readonly opzioni: OpzioniSupervisore) {
    super()
    this.ponte = new Ponte((livello, testo) => opzioni.suDiario(livello, testo))

    // Non si dichiara "acceso" qui: una connessione aperta non e ancora una
    // prova. Lo stato lo decide `collegaEVerifica`, dopo che il server ha
    // davvero risposto a una domanda.
    this.rpc.on('caduto', (e: Error) => {
      if (this.chiuso) return
      // Se l'abbiamo fermato noi non e una caduta: e cio che volevamo.
      this.situazione = this.fermatoDaNoi ? 'spento' : 'caduto'
      if (!this.fermatoDaNoi) {
        this.opzioni.suDiario('attenzione', `Server audio non raggiungibile: ${e.message}`)
        this.programmaRiprova()
      }
    })
    // Ogni notifica del server e un motivo per riguardare: un client che si
    // collega, un gruppo che cambia, un nome riscritto da Snapdroid.
    this.rpc.on('notifica', (metodo: string) => {
      if (metodo === '__illeggibile__') return
      void this.riconcilia(`notifica ${metodo}`)
    })
  }

  // -------------------------------------------------------------- lettura

  stato(): StatoServer {
    return this.situazione
  }

  clienti(): ReadonlyMap<string, ClientVivo> {
    return this.vivi
  }

  inIdentificazione(): ReadonlySet<string> {
    return this.identificazione === null ? new Set() : new Set([this.identificazione])
  }

  statoPonte() {
    return this.ponte.stato()
  }

  // -------------------------------------------------------- ciclo di vita

  /**
   * Si aggancia a un server gia acceso, senza avviarne uno.
   *
   * Succede piu spesso di quanto sembri: snapserver e staccato con `setsid`
   * apposta per sopravvivere alla chiusura di Regia, quindi riaprendo l'app
   * il piu delle volte e ancora li. Riavviarlo sarebbe due secondi di silenzio
   * gratuiti.
   */
  async adotta(): Promise<boolean> {
    try {
      await this.collegaEVerifica()
      this.avviaBattito()
      await this.apriPonte()
      return true
    } catch {
      // Non si tocca `situazione`: qui si sta solo guardando se c'era gia
      // qualcosa, e nel frattempo un `avvia()` potrebbe averla gia decisa.
      await this.rpc.chiudi().catch(() => {})
      return false
    }
  }

  async avvia(): Promise<void> {
    if (this.situazione === 'acceso' && this.rpc.collegato) return
    const p = this.opzioni.progetto()
    this.fermatoDaNoi = false
    this.situazione = 'in avvio'

    const distro = p.server.distro
    const installate = distroInstallate()
    if (installate === null) {
      this.situazione = 'non installato'
      throw new Error('WSL non e installato: il server audio non puo partire (ADR 0002)')
    }
    if (!installate.includes(distro)) {
      this.situazione = 'non installato'
      throw new Error(
        `la distro "${distro}" non c'e. Distro disponibili: ${installate.join(', ') || 'nessuna'}`,
      )
    }

    const conf = generaConfigurazione(p)
    const scritto = scriviNellaDistro(distro, `${CARTELLA_DISTRO}/snapserver.conf`, conf.testo)
    if (scritto.stato !== 0) {
      this.situazione = 'caduto'
      throw new Error(`non riesco a scrivere la configurazione nella distro: ${scritto.errore}`)
    }

    // `pkill -x`, sul nome esatto: `pkill -f <percorso>` ucciderebbe anche la
    // shell che lo esegue, perche il percorso compare nella sua riga di comando,
    // e tutto cio che viene dopo non succederebbe, in silenzio.
    await eseguiNellaDistroAsync(distro, 'pkill -x snapserver || true')

    // Tre cose in queste sei righe, e ognuna e costata.
    //
    // 1. `setsid` e obbligatorio: senza, snapserver riceve SIGHUP e muore
    //    appena esce il `wsl.exe` che l'ha lanciato. `nohup` da solo non basta,
    //    WSL termina l'intero gruppo di processi della sessione.
    // 2. `mkdir` sta su una **riga sua**. Scritto come `mkdir -p X && setsid
    //    ... &`, il `&` ha precedenza piu bassa di `&&` e manda in background
    //    *tutta* la catena, `mkdir` compreso: la shell esce subito dopo e non
    //    succede niente, riportando successo. Sintomo: nessun errore, nessun
    //    log, nessun server.
    // 3. Si **verifica**. Un `echo avviato` dice solo che la shell e arrivata
    //    in fondo. `pgrep` dice che snapserver c'e, e se non c'e si porta
    //    indietro il suo log invece di lasciare all'Operatore un "non risponde".
    const avvio = await eseguiNellaDistroAsync(
      distro,
      [
        `mkdir -p ${CARTELLA_DISTRO}`,
        `setsid ${BINARIO_SNAPSERVER} -c ${CARTELLA_DISTRO}/snapserver.conf ` +
          `> ${CARTELLA_DISTRO}/server.log 2>&1 < /dev/null &`,
        'disown',
        'sleep 1',
        'if pgrep -x snapserver > /dev/null; then echo avviato; else',
        `  echo "non partito"; tail -20 ${CARTELLA_DISTRO}/server.log 2>&1; exit 1`,
        'fi',
      ].join('\n'),
      { timeoutMs: 25_000 },
    )
    if (avvio.stato !== 0 || !avvio.uscita.includes('avviato')) {
      this.situazione = 'caduto'
      throw new Error(
        `snapserver non e partito: ${avvio.uscita || avvio.errore || 'nessun dettaglio'}`,
      )
    }

    await this.aspettaControllo(15_000)
    this.avviaBattito()
    await this.apriPonte()
    this.opzioni.suDiario(
      'info',
      `Server audio acceso: ${conf.flussi.length} Flussi, buffer ${p.audio.bufferMs} ms, ` +
        `latenza attesa ${latenzaAttesaMs(p.audio)} ms.`,
    )
  }

  async ferma(): Promise<void> {
    this.fermatoDaNoi = true
    this.fermaBattito()
    await this.rpc.chiudi()
    await this.ponte.chiudi()
    const distro = this.opzioni.progetto().server.distro
    await eseguiNellaDistroAsync(distro, 'pkill -x snapserver || true')
    this.situazione = 'spento'
    this.vivi.clear()
    this.osservato = { gruppi: [], clienti: [], streamIds: [] }
    this.opzioni.suDiario('info', 'Server audio spento.')
  }

  async riavvia(): Promise<void> {
    await this.ferma()
    await this.avvia()
  }

  /**
   * Le Zone sono cambiate: la configurazione di snapserver non e piu quella
   * giusta (ADR 0005, il nome della Zona *e* l'identificativo dello stream).
   * Si riavvia solo se era acceso -- e in Setup due secondi di silenzio non
   * costano niente, che e esattamente perche le Zone si creano in Setup.
   */
  /**
   * Le Zone sono cambiate e fra poco arriva un `riconfigura()`.
   *
   * Serve solo a far stare zitta la riconciliazione nel frattempo: il progetto
   * e gia quello nuovo, il server acceso e ancora quello vecchio, e ogni
   * notifica che arriva in mezzo produrrebbe un errore su cui non c'e niente
   * da fare.
   */
  annunciaRiconfigurazione(): void {
    this.riconfigurazioneInArrivo = true
  }

  async riconfigura(): Promise<void> {
    this.riconfigurazioneInArrivo = false
    if (this.situazione !== 'acceso') return
    this.opzioni.suDiario('info', 'Le Zone sono cambiate: riavvio il server audio.')
    try {
      await this.riavvia()
    } catch (e) {
      // Qui non c'e nessun Operatore che ha premuto qualcosa: la
      // riconfigurazione parte da sola dopo un cambio di Zone, e se
      // l'eccezione uscisse di qui non la leggerebbe nessuno. Il server
      // resterebbe spento per sempre, con le sorgenti che riprovano a
      // scrivere dentro il vuoto e il Diario che si riempie di errori che
      // non dicono la causa.
      this.opzioni.suDiario('grave', `Il server audio non e ripartito: ${(e as Error).message}`)
      this.programmaRiavvio()
    }
  }

  async chiudi(): Promise<void> {
    this.chiuso = true
    this.fermaBattito()
    if (this.riprova) clearTimeout(this.riprova)
    this.riprova = null
    await this.rpc.chiudi()
    await this.ponte.chiudi()
  }

  // ------------------------------------------------------------- comandi

  /**
   * Identifica: si zittiscono gli altri, non si sposta il client.
   *
   * Cambiare gruppo significa cambiare stream, e cambiare stream significa che
   * il client si ri-sincronizza da capo -- che e esattamente il punto in cui i
   * client Snapcast si perdono e smettono di suonare (§2.2). Identifica si usa
   * decine di volte per Setup: sarebbe ripetere di continuo la manovra che
   * rompe l'audio. Vedi ADR 0006.
   */
  async identifica(clientId: string): Promise<void> {
    if (!this.rpc.collegato) throw new Error('il server audio non e collegato')
    if (this.identificazione) {
      throw new Error('c\'e gia una Identifica in corso: aspetta che finisca')
    }
    const gruppo = this.osservato.gruppi.find((g) => g.clientIds.includes(clientId))
    if (!gruppo) throw new Error('il server non conosce questo Altoparlante')

    const altri = gruppo.clientIds.filter((id) => id !== clientId)
    const prima = new Map<string, { percentuale: number; muto: boolean }>()
    for (const id of altri) {
      const c = this.osservato.clienti.find((x) => x.id === id)
      if (c) prima.set(id, { percentuale: c.volumePercentuale, muto: c.muto })
    }

    this.identificazione = clientId
    const p = this.opzioni.progetto()
    const alt = p.altoparlanti.find((a) => a.id === clientId)
    const chiave = chiaveFlussoDi(alt?.zonaId ?? null)

    try {
      for (const [id, v] of prima) await this.rpc.volumeClient(id, v.percentuale, true)
      const durataMs = this.opzioni.suonaIdentifica(chiave)
      this.opzioni.suDiario('info', `Identifica su "${alt?.nome ?? clientId}".`)
      await attendi(durataMs + latenzaAttesaMs(p.audio) + 300)
    } finally {
      // Il ripristino sta nel `finally` perche il caso che conta e quello in cui
      // qualcosa e andato storto a meta. Se anche questo fallisce, la passata
      // periodica di riconciliazione rimette i volumi dal progetto.
      for (const [id, v] of prima) {
        try {
          await this.rpc.volumeClient(id, v.percentuale, v.muto)
        } catch {
          /* ci pensa la riconciliazione */
        }
      }
      this.identificazione = null
    }
  }

  async rinominaClient(clientId: string, nome: string): Promise<void> {
    if (this.rpc.collegato) await this.rpc.nomeClient(clientId, nome)
  }

  async dimenticaClient(clientId: string): Promise<void> {
    this.vivi.delete(clientId)
    if (this.rpc.collegato) await this.rpc.dimenticaClient(clientId)
  }

  /** Forza una passata completa, ora (§3.10, "ricollega tutto"). */
  async ricollega(): Promise<void> {
    if (!this.rpc.collegato) {
      await this.collegaEVerifica()
      return
    }
    await this.riconcilia('richiesta dall Operatore')
  }

  // ------------------------------------------------------------- interni

  private portePonte(): number[] {
    const s = this.opzioni.progetto().server
    // Snapdroid apre **prima** la 1705 (controllo) e cinque secondi dopo la
    // 1704: se il ponte non copre entrambe, il telefono non arriva nemmeno a
    // chiedere il flusso.
    return [s.portaFlussoClient, s.portaControllo, s.portaHttp]
  }

  /**
   * Apre il ponte verso l'IP **della distro**, non verso il loopback.
   *
   * `0.0.0.0` contiene `127.0.0.1`: un ponte che inoltrasse li si collegherebbe
   * a se stesso, e il giro a vuoto che ne esce accetta connessioni all'istante
   * senza rispondere mai -- indistinguibile da un server acceso, per chi guarda
   * solo `connect()`. Se l'indirizzo della distro non si riesce a leggere, il
   * ponte non si apre: meglio dei telefoni che non si collegano che dei
   * telefoni collegati a niente.
   */
  private async apriPonte(): Promise<void> {
    const ip = await this.aggiornaIndirizzoDistro()
    if (!ip) {
      this.opzioni.suDiario(
        'attenzione',
        "Non riesco a leggere l'indirizzo della distro: il ponte di rete resta chiuso, " +
          'e i telefoni potrebbero non vedere il server audio.',
      )
      return
    }
    await this.ponte.apri(this.portePonte(), ip)
  }

  /**
   * Rilegge l'indirizzo della distro e lo comunica se e cambiato.
   *
   * Cambia a ogni riavvio della distro, e non e un dettaglio cosmetico: e
   * l'indirizzo a cui il thread audio apre le tredici socket delle sorgenti.
   */
  async aggiornaIndirizzoDistro(): Promise<string | null> {
    const ip = await indirizzoDistro(this.opzioni.progetto().server.distro)
    if (ip && ip !== this.ipDistro) {
      this.ipDistro = ip
      this.opzioni.suIndirizzoDistro(ip)
    }
    return ip
  }

  get indirizzo(): string | null {
    return this.ipDistro
  }

  /**
   * Si collega **e chiede qualcosa**.
   *
   * Una `connect()` che riesce non prova che dall'altra parte ci sia
   * snapserver: puo esserci un inoltro di WSL rimasto in piedi, un portproxy
   * verso il nulla, o -- il caso che e successo davvero -- un nostro ponte che
   * gira a vuoto. L'unica prova e una risposta: `Server.GetStatus` con dentro
   * gli stream che ci aspettiamo.
   */
  private async collegaEVerifica(): Promise<void> {
    await this.rpc.collega()
    this.osservato = await this.rpc.stato()
    this.aggiornaVivi()
    this.situazione = 'acceso'
    this.opzioni.suDiario(
      'info',
      `Collegato al server audio: ${this.osservato.streamIds.length} Flussi, ` +
        `${this.osservato.clienti.length} client conosciuti.`,
    )
    void this.riconcilia('appena collegati')
  }

  private avviaBattito(): void {
    this.fermaBattito()
    const cadenza = this.opzioni.cadenzaRiconciliazioneMs ?? 5000
    this.battito = setInterval(() => void this.riconcilia('passata periodica'), cadenza)
    this.battito.unref?.()
  }

  private fermaBattito(): void {
    if (this.battito) clearInterval(this.battito)
    this.battito = null
  }

  private programmaRiprova(): void {
    if (this.riprova || this.chiuso) return
    this.riprova = setTimeout(() => {
      this.riprova = null
      this.collegaEVerifica().catch(async () => {
        await this.rpc.chiudi().catch(() => {})
        this.programmaRiprova()
      })
    }, RIPROVA_RPC_MS)
    this.riprova.unref?.()
  }

  /**
   * Riprova ad **avviare** il server, non solo a ricollegarsi.
   *
   * `programmaRiprova` serve al caso in cui il server c'e e la connessione e
   * caduta. Qui il server non c'e proprio: riprovare a collegarsi non lo
   * farebbe nascere. Succede quando un avvio fallisce per una ragione che puo
   * sparire da sola -- la distro che sta ancora partendo, un `pkill` di un
   * momento prima che non ha ancora liberato la porta -- e nessuno se ne
   * accorgerebbe, perche a chiedere il riavvio e stato un cambio di Zone e non
   * una persona.
   */
  private programmaRiavvio(): void {
    if (this.riprova || this.chiuso) return
    this.riprova = setTimeout(() => {
      this.riprova = null
      this.avvia().catch((e: Error) => {
        this.opzioni.suDiario('attenzione', `Riavvio non riuscito: ${e.message}. Riprovo.`)
        this.programmaRiavvio()
      })
    }, RIPROVA_AVVIO_MS)
    this.riprova.unref?.()
  }

  private async aspettaControllo(entroMs: number): Promise<void> {
    const scadenza = Date.now() + entroMs
    let ultimo: Error | null = null
    while (Date.now() < scadenza) {
      try {
        await this.collegaEVerifica()
        return
      } catch (e) {
        ultimo = e as Error
        // Una connessione aperta su qualcosa che non risponde va chiusa, o al
        // giro dopo `collega()` la considera buona e non riprova nemmeno.
        await this.rpc.chiudi().catch(() => {})
        await attendi(300)
      }
    }
    this.situazione = 'caduto'
    throw new Error(
      `snapserver non risponde sulla porta di controllo entro ${entroMs} ms` +
        (ultimo ? `: ${ultimo.message}` : ''),
    )
  }

  /**
   * Una passata di riconciliazione contro il server vero.
   *
   * Si ripete finche il piano non e vuoto, perche togliere un client da un
   * gruppo gliene crea uno nuovo con un id che si scopre solo dopo: una passata
   * sola a volte non basta.
   */
  private async riconcilia(perche: string): Promise<void> {
    if (!this.rpc.collegato || this.riconciliazioneInCorso) return
    // Durante Identifica i volumi sul server sono deliberatamente diversi da
    // quelli del progetto: riconciliare adesso riaccenderebbe subito i telefoni
    // che stiamo zittendo, cioe annullerebbe l'Identifica.
    if (this.identificazione) return
    // Le Zone sono cambiate e il riavvio non e ancora partito (e in attesa che
    // l'Operatore finisca di scrivere il nome). Il progetto vuole gia uno
    // stream che il server acceso non ha: riconciliare adesso vuol dire
    // chiedere di spostare un gruppo su uno stream inesistente e scrivere
    // "Riconciliazione fallita: Stream not found" nel Diario, per una cosa che
    // si sistema da sola fra un secondo. Si aspetta il server nuovo.
    if (this.riconfigurazioneInArrivo) return

    this.riconciliazioneInCorso = true
    try {
      for (let passata = 0; passata < 6; passata++) {
        this.osservato = await this.rpc.stato()
        this.aggiornaVivi()
        const azioni = pianifica(this.opzioni.progetto(), this.osservato)
        if (azioni.length === 0) return
        if (passata === 0) {
          this.emit('riconciliato', azioni.length, perche)
        }
        for (const a of azioni) await this.esegui(a)
      }
      this.opzioni.suDiario(
        'attenzione',
        'La riconciliazione con il server audio non converge: qualcosa lo sta cambiando sotto.',
      )
    } catch (e) {
      this.opzioni.suDiario('attenzione', `Riconciliazione fallita: ${(e as Error).message}`)
    } finally {
      this.riconciliazioneInCorso = false
    }
  }

  private async esegui(a: Azione): Promise<void> {
    switch (a.tipo) {
      case 'gruppoClient':
        await this.rpc.gruppoClient(a.gruppoId, a.clientIds)
        break
      case 'gruppoStream':
        await this.rpc.gruppoStream(a.gruppoId, a.streamId)
        break
      case 'nomeClient':
        await this.rpc.nomeClient(a.clientId, a.nome)
        break
      case 'volumeClient':
        await this.rpc.volumeClient(a.clientId, a.percentuale, a.muto)
        break
      case 'latenzaClient':
        // Il server tronca al `buffer` dello stream: si accetta cio che dice lui.
        await this.rpc.latenzaClient(a.clientId, a.latenzaMs)
        break
    }
  }

  private aggiornaVivi(): void {
    const conosciuti = new Set(this.opzioni.progetto().altoparlanti.map((a) => a.id))
    for (const c of this.osservato.clienti) {
      const prima = this.vivi.get(c.id)
      this.vivi.set(c.id, {
        collegato: c.connesso,
        indirizzo: c.indirizzo ?? null,
        nome: c.nome,
      })
      if (!conosciuti.has(c.id)) {
        this.opzioni.suClientNuovo(c.id, c.nome || 'Altoparlante')
      } else if (prima && prima.collegato !== c.connesso) {
        this.opzioni.suDiario(
          c.connesso ? 'info' : 'attenzione',
          `Altoparlante "${c.nome || c.id}" ${c.connesso ? 'tornato in linea' : 'sparito'}.`,
        )
      }
    }
    // Un client che il server non elenca piu e stato dimenticato dal server:
    // resta nel progetto (potrebbe tornare), ma non e piu "vivo".
    const visti = new Set(this.osservato.clienti.map((c) => c.id))
    for (const id of [...this.vivi.keys()]) if (!visti.has(id)) this.vivi.delete(id)
  }
}

/**
 * La chiave con cui il thread audio indirizza il Flusso di una Zona.
 *
 * Per i non assegnati non c'e una Zona, ma il Flusso c'e lo stesso e ha un
 * mixer vivo come gli altri -- senza, la `async_read` di snapserver su quella
 * socket resta pendente e si completa minuti dopo con un riferimento temporale
 * vecchio, risincronizzando insieme tutti i telefoni non ancora assegnati.
 * Serve quindi un nome per indirizzarlo, e non puo essere `null`.
 */
export const FLUSSO_NON_ASSEGNATI = '@non-assegnati'

export function chiaveFlussoDi(zonaId: string | null): string {
  return zonaId ?? FLUSSO_NON_ASSEGNATI
}

function attendi(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
