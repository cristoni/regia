/**
 * Lo scrittore: unisce il mixer alla sorgente TCP di snapserver.
 *
 * E il pezzo dove ogni vincolo trovato nella ricerca diventa codice, e dove
 * quasi tutti i modi di sbagliare non danno errore -- si sentono e basta, a
 * meta serata. In ordine di cattiveria:
 *
 * 1. **Una sola socket per porta, sempre.** In `mode=server` snapserver posta
 *    UN solo `async_accept` e non ne posta un altro finche la connessione
 *    corrente non va in errore. Il kernel pero completa lo handshake e parcheggia
 *    le altre nella coda di accettazione: **`connect()` che riesce non e prova
 *    che snapserver stia leggendo**. Una riconnessione ingenua produce una
 *    socket mezza aperta i cui byte verranno riprodotti minuti dopo.
 *
 * 2. **Ogni scrittura multipla di un frame.** Un frame stereo a 16 bit sono 4
 *    byte. Una scrittura disallineata inverte L e R per il resto della vita
 *    della connessione, e snapserver non ha modo di riallinearsi.
 *
 * 3. **Mai aspettare `drain` per regolare il ritmo.** Scrivere finche non arriva
 *    contropressione fa crescere la finestra TCP fino a secondi di audio in
 *    volo, senza un errore da nessuna parte: la latenza cresce e nessuno se ne
 *    accorge. Il ritmo lo detta `Cadenza` contro un orologio monotono; `drain`
 *    serve solo a non gonfiare la memoria del processo.
 *
 * 4. **Si scrive dal primo istante, anche il silenzio, anche sul Flusso dei non
 *    assegnati.** Vedi ADR 0005: senza scritture la lettura di snapserver resta
 *    pendente e si completa molto dopo con un riferimento temporale vecchio.
 */
import { byteFrame, type ImpostazioniAudio } from '../dominio/progetto.js'
import { Cadenza } from './cadenza.js'
import type { MixerZona } from './mixer.js'

/**
 * Dove finiscono i byte. Astratto di proposito: i test girano su una destinazione
 * finta, senza WSL, senza rete e senza tempo vero.
 */
export interface Destinazione {
  /** Restituisce falso se la coda e piena e conviene rallentare. */
  scrivi(dati: Uint8Array): boolean
  /** Si risolve quando la coda si e svuotata. */
  attendiScarico(): Promise<void>
  chiudi(): Promise<void>
  readonly aperta: boolean
}

export type StatoScrittore = 'fermo' | 'in collegamento' | 'attivo' | 'caduto'

export interface DiagnosticaScrittore {
  readonly stato: StatoScrittore
  readonly blocchiScritti: number
  readonly byteScritti: number
  /** Ritardo totale accumulato sul tempo reale dall'avvio. Per il banco. */
  readonly ritardoTotaleMs: number
  /** Ritardo che si accumula ogni secondo, adesso. E quello che si mostra. */
  readonly ritardoMsAlSecondo: number
  readonly riallineamenti: number
  readonly scartoMs: number
  readonly cadute: number
  readonly attesePerScarico: number
}

export interface OpzioniScrittore {
  readonly impostazioni: ImpostazioniAudio
  readonly mixer: MixerZona
  /** Apre una connessione nuova. Puo fallire: chi chiama riprova. */
  readonly collega: () => Promise<Destinazione>
  /** Attesa fra due tentativi di collegamento. */
  readonly attesaRiprovaMs?: number
  /**
   * Quanto si aspetta al massimo che la socket si scarichi.
   *
   * Non e prudenza: e la difesa contro la trappola dell'`async_accept`.
   * Snapserver in `mode=server` accetta **una sola** connessione per porta e
   * non ne posta un'altra finche quella non muore; il kernel pero completa lo
   * handshake delle successive e le parcheggia. Una socket parcheggiata sembra
   * viva, accetta byte finche il buffer non e pieno, e poi **non si scarica
   * mai**. Senza un tetto qui, quello scrittore resta fermo per sempre --
   * e con lui, aspettandolo, tutto il thread audio.
   */
  readonly attesaScaricoMs?: number
  readonly suDiagnostica?: (messaggio: string) => void
  readonly adesso?: () => number
  readonly dormi?: (ms: number) => Promise<void>
}

export class Scrittore {
  private stato: StatoScrittore = 'fermo'
  private destinazione: Destinazione | null = null
  private cadenza: Cadenza
  private ciclo: Promise<void> | null = null
  private fermare = false
  private byteScritti = 0
  private cadute = 0
  private attesePerScarico = 0
  /** Vero fra il primo fallimento di collegamento e il ritorno. */
  private fallimentoSegnalato = false
  private ritardoSegnalato = false

  /** Allocati una volta e riusati: nel ciclo di scrittura non si alloca mai. */
  private readonly blocco: Int16Array
  private readonly byte: Uint8Array

  private readonly impostazioni: ImpostazioniAudio
  private readonly mixer: MixerZona
  private readonly collega: () => Promise<Destinazione>
  private readonly attesaRiprovaMs: number
  private readonly attesaScaricoMs: number
  private readonly suDiagnostica: (m: string) => void
  private readonly dormi: (ms: number) => Promise<void>

  constructor(o: OpzioniScrittore) {
    this.impostazioni = o.impostazioni
    this.mixer = o.mixer
    this.collega = o.collega
    this.attesaRiprovaMs = o.attesaRiprovaMs ?? 500
    // Una connessione sana si scarica in millisecondi: qualunque valore sopra
    // il secondo e gia diagnostico. Si tiene comunque legato all'anticipo,
    // perche e quello a dire quanto audio puo essere in volo.
    this.attesaScaricoMs = o.attesaScaricoMs ?? Math.max(1000, o.impostazioni.anticipoMs * 2)
    this.suDiagnostica = o.suDiagnostica ?? (() => {})
    this.dormi = o.dormi ?? ((ms) => new Promise((r) => setTimeout(r, ms)))

    const campioni = Math.round((o.impostazioni.frequenza * o.impostazioni.bloccoMs) / 1000)
    this.blocco = new Int16Array(campioni * o.impostazioni.canali)
    // Vista sugli stessi byte: nessuna copia fra mixaggio e scrittura. Int16Array
    // e little endian su x86 e ARM, che e cio che snapserver si aspetta.
    this.byte = new Uint8Array(this.blocco.buffer)

    if (this.byte.length % byteFrame(o.impostazioni) !== 0) {
      throw new Error(
        `blocco di ${this.byte.length} byte non multiplo di un frame (${byteFrame(o.impostazioni)}): ` +
          'L e R si invertirebbero per sempre',
      )
    }

    this.cadenza = new Cadenza(
      o.impostazioni.bloccoMs,
      o.impostazioni.anticipoMs,
      // Oltre mezzo secondo di ritardo non si recupera: lo snapclient fa una
      // risincronizzazione dura sopra 500 ms di scarto, quindi recuperare di
      // piu peggiorerebbe invece di aiutare.
      500,
      o.adesso ?? (() => performance.now()),
    )
  }

  avvia(): void {
    if (this.ciclo) return
    this.fermare = false
    this.ciclo = this.esegui()
  }

  /**
   * Ferma il ciclo e chiude la connessione.
   *
   * L'ordine conta, e costa caro sbagliarlo: si stacca la destinazione **prima**
   * di aspettare il ciclo. Il ciclo puo essere fermo dentro `attendiScarico()`,
   * e quell'attesa finisce in due modi soli -- la socket si scarica, o la socket
   * si chiude. Su una socket parcheggiata da snapserver il primo non succede
   * mai, quindi aspettare il ciclo prima di chiuderla e aspettare per sempre:
   * e con `configura` che aspetta `ferma()`, si ferma l'intera coda del thread
   * audio, e da li in poi nessun Suono si carica piu.
   */
  async ferma(): Promise<void> {
    this.fermare = true
    // Prima: sblocca un ciclo fermo su `attendiScarico()`.
    await this.staccaDestinazione()
    await this.ciclo?.catch(() => {})
    // Poi di nuovo, e non e ridondante. Il ciclo puo essere stato sorpreso
    // dentro `riprovaCollegamento()`: quella finisce di collegarsi comunque --
    // la connessione era gia in volo -- e assegna una destinazione nuova prima
    // di accorgersi che deve uscire. Senza questa seconda passata quella socket
    // resta aperta e abbandonata, e snapserver se la tiene nella coda di
    // accettazione con dentro megabyte che nessuno leggera mai.
    await this.staccaDestinazione()
    this.ciclo = null
    this.stato = 'fermo'
  }

  diagnostica(): DiagnosticaScrittore {
    const c = this.cadenza.avviata
      ? this.cadenza.diagnostica()
      : {
          blocchiScritti: 0,
          msProdotti: 0,
          ritardoTotaleMs: 0,
          ritardoMsAlSecondo: 0,
          riallineamenti: 0,
          scartoMs: 0,
        }
    return {
      stato: this.stato,
      blocchiScritti: c.blocchiScritti,
      byteScritti: this.byteScritti,
      ritardoTotaleMs: c.ritardoTotaleMs,
      ritardoMsAlSecondo: c.ritardoMsAlSecondo,
      riallineamenti: c.riallineamenti,
      scartoMs: c.scartoMs,
      cadute: this.cadute,
      attesePerScarico: this.attesePerScarico,
    }
  }

  // -------------------------------------------------------------- il ciclo

  private async esegui(): Promise<void> {
    while (!this.fermare) {
      if (!this.destinazione?.aperta) {
        const collegato = await this.riprovaCollegamento()
        if (!collegato) continue
      }
      try {
        await this.scriviQuantoDovuto()
      } catch (e) {
        // Se stiamo fermando, l'errore siamo noi: `ferma()` ha appena staccato
        // la destinazione sotto il ciclo, apposta. Contarla come caduta
        // sporcherebbe la diagnostica di un guasto che non c'e stato.
        if (this.fermare) return
        this.suDiagnostica(`scrittura fallita: ${(e as Error).message}`)
        await this.segnalaCaduta()
        continue
      }
      await this.dormi(this.cadenza.attesaMs())
    }
  }

  private async riprovaCollegamento(): Promise<boolean> {
    // Ci si puo arrivare con la fermata gia chiesta: aprire adesso una
    // connessione significherebbe aprirne una che nessuno chiudera.
    if (this.fermare) return false

    // Una connessione che muore fra due giri del ciclo e una caduta esattamente
    // come una che esplode durante una scrittura: per chi guarda il pannello di
    // stato e lo stesso telefono che ha smesso di suonare. `segnalaCaduta` ha
    // gia contato la propria, e porta lo stato a 'caduto': non si conta due volte.
    if (this.stato === 'attivo') {
      this.cadute++
      this.suDiagnostica('connessione caduta')
    }
    this.stato = 'in collegamento'
    // Sempre: anche se crediamo che non ci sia niente da chiudere. E' l'unico
    // modo di essere certi di non lasciare due socket vive sulla stessa porta.
    await this.staccaDestinazione()
    try {
      const destinazione = await this.collega()
      // Fra la richiesta e la risposta puo essere arrivato un `ferma()`: la
      // connessione e comunque nata, e va chiusa qui, subito, non lasciata
      // assegnata a uno scrittore che sta uscendo.
      if (this.fermare) {
        await destinazione.chiudi().catch(() => {})
        return false
      }
      this.destinazione = destinazione
    } catch (e) {
      // Si segnala il primo fallimento e poi si tace fino al ritorno. Il caso
      // normale e "il server audio non e ancora acceso": riprovare due volte al
      // secondo e giusto, dirlo due volte al secondo riempirebbe il diario di
      // migliaia di righe identiche e nasconderebbe tutto il resto.
      if (!this.fallimentoSegnalato) {
        this.fallimentoSegnalato = true
        this.suDiagnostica(`collegamento fallito: ${(e as Error).message}`)
      }
      await this.dormi(this.attesaRiprovaMs)
      return false
    }
    if (this.fallimentoSegnalato) {
      this.fallimentoSegnalato = false
      this.suDiagnostica('collegamento ristabilito')
    }
    // Timeline azzerata: dopo una riconnessione i blocchi vecchi non hanno piu
    // senso, e ripartire dal conteggio precedente produrrebbe una scrittura a
    // raffica di tutto cio che e stato "perso" mentre eravamo scollegati.
    this.cadenza.avvia()
    // Anche il racconto del ritardo riparte: la finestra e vuota, e un episodio
    // che ricominciasse adesso e una notizia nuova.
    this.ritardoSegnalato = false
    this.stato = 'attivo'
    return true
  }

  private async scriviQuantoDovuto(): Promise<void> {
    const { blocchi, ritardoMs } = this.cadenza.dovuti()
    this.raccontaIlRitardo(ritardoMs)

    for (let i = 0; i < blocchi; i++) {
      if (this.fermare) return
      const d = this.destinazione
      if (!d?.aperta) throw new Error('destinazione chiusa a meta blocco')

      this.mixer.prossimoBlocco(this.blocco)
      const spazio = d.scrivi(this.byte)
      this.byteScritti += this.byte.length

      if (!spazio) {
        // NON e questo che detta il ritmo: il ritmo lo detta la cadenza. Qui si
        // aspetta soltanto per non far crescere la coda in memoria del processo.
        this.attesePerScarico++
        await this.attendiScaricoOScade(d)
      }
    }
  }

  /**
   * Il ritardo si dice una volta sola, e poi si tace finche non passa.
   *
   * Un guasto cronico -- l'orologio della distro storto, per dire -- fa scattare
   * un riallineamento **piu volte al secondo**, su ogni Flusso. Scrivendone una
   * riga ciascuno, il diario si riempie di righe identiche e ci si perde dentro
   * tutto il resto: dopo un minuto non c'e piu traccia di quel che e successo
   * prima, che e esattamente cio che si va a cercare quando qualcosa va storto.
   * E la stessa ragione per cui `fallimentoSegnalato` tace sui collegamenti.
   *
   * Il ritmo, che e il numero che conta, sta gia nell'istantanea dieci volte al
   * secondo: qui serve solo il fronte -- e cominciato, e finito.
   */
  private raccontaIlRitardo(ritardoMs: number): void {
    if (ritardoMs > 0) {
      if (this.ritardoSegnalato) return
      this.ritardoSegnalato = true
      // "Rimasto indietro", non "perso": il Flusso non ha buchi. Vedi `Cadenza`.
      this.suDiagnostica(
        `il Flusso non tiene il tempo reale (${ritardoMs} ms non recuperati): ` +
          'gli Altoparlanti compensano tagliando',
      )
      return
    }
    // Si torna a tacere solo quando la finestra si e svuotata davvero: fra un
    // riallineamento e il successivo passano molti giri con ritardo zero, e
    // fidarsi di quelli farebbe lampeggiare la riga invece di dirla una volta.
    if (this.ritardoSegnalato && this.cadenza.diagnostica().ritardoMsAlSecondo === 0) {
      this.ritardoSegnalato = false
      this.suDiagnostica('il Flusso ha ripreso il tempo reale')
    }
  }

  /**
   * Aspetta lo scarico, ma non per sempre.
   *
   * Una socket che non si scarica entro il tetto e quasi certamente parcheggiata
   * dal kernel in attesa di un `async_accept` che snapserver non postera finche
   * la connessione corrente non muore. L'unica uscita e farla morire: si lancia,
   * e il ciclo la tratta come una caduta qualsiasi e si ricollega -- e a quel
   * punto snapserver accetta noi.
   */
  private async attendiScaricoOScade(d: Destinazione): Promise<void> {
    // Timer vero, non `dormi`. `dormi` e l'attesa **della timeline audio**, ed e
    // il modo con cui i test fanno scorrere l'orologio finto: usarla qui
    // sposterebbe in avanti l'orologio del Flusso ogni volta che scatta la
    // contropressione, e la cadenza si troverebbe un secondo di audio da
    // recuperare che nessuno le ha chiesto. Questa scadenza parla di tempo
    // vero, quello in cui una socket sana si scarica in millisecondi.
    // ⚠️ **Questa scadenza non si `unref()`**, ed e la regola del thread audio:
    // un timer staccato dal ciclo di eventi non lo tiene vivo, e qui e l'unica
    // cosa che lo tiene vivo. Quando la socket e parcheggiata, `attendiScarico()`
    // e una promessa che non si risolvera mai e non trattiene niente: con la
    // scadenza staccata, per Node non resta piu niente da fare, e il ciclo di
    // eventi si svuota mentre lo scrittore sta ancora aspettando -- cioe
    // esattamente il caso che questa funzione esiste per risolvere.
    //
    // Su Windows non si vedeva: la risoluzione dei timer e 15,6 ms, e c'e quasi
    // sempre un altro timer in volo a tenere aperto il giro. Su Linux, dove i
    // timer sono precisi al millisecondo, il ciclo si svuota davvero -- ed e li
    // che e saltato fuori, con tre prove dello scrittore che finivano in
    // «Promise resolution is still pending but the event loop has already
    // resolved» invece di misurare cio che dovevano misurare.
    //
    // Tenerla attaccata non allunga la vita del processo: il `finally` qui sotto
    // la cancella sempre, e comunque scatta entro `attesaScaricoMs`.
    let scadenza: ReturnType<typeof setTimeout> | undefined
    const scaduta = new Promise<'scaduta'>((ok) => {
      scadenza = setTimeout(() => ok('scaduta'), this.attesaScaricoMs)
    })
    try {
      const esito = await Promise.race([d.attendiScarico().then(() => 'scaricata' as const), scaduta])
      if (esito === 'scaduta') {
        throw new Error(
          `la socket non si scarica da ${this.attesaScaricoMs} ms: probabilmente snapserver ` +
            'non la sta leggendo',
        )
      }
    } finally {
      clearTimeout(scadenza)
    }
  }

  private async segnalaCaduta(): Promise<void> {
    this.cadute++
    this.stato = 'caduto'
    await this.staccaDestinazione()
    await this.dormi(this.attesaRiprovaMs)
  }

  private async staccaDestinazione(): Promise<void> {
    const d = this.destinazione
    this.destinazione = null
    if (!d) return
    try {
      await d.chiudi()
    } catch {
      // Chiudere una socket gia morta non e un problema nostro.
    }
  }
}
