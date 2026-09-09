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
  readonly buchiMs: number
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
      : { blocchiScritti: 0, msProdotti: 0, buchiTotaliMs: 0, riallineamenti: 0, scartoMs: 0 }
    return {
      stato: this.stato,
      blocchiScritti: c.blocchiScritti,
      byteScritti: this.byteScritti,
      buchiMs: c.buchiTotaliMs,
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
    this.stato = 'attivo'
    return true
  }

  private async scriviQuantoDovuto(): Promise<void> {
    const { blocchi, buchiMs } = this.cadenza.dovuti()
    if (buchiMs > 0) this.suDiagnostica(`riallineamento: persi ${buchiMs} ms di Flusso`)

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
    let scadenza: ReturnType<typeof setTimeout> | undefined
    const scaduta = new Promise<'scaduta'>((ok) => {
      scadenza = setTimeout(() => ok('scaduta'), this.attesaScaricoMs)
      scadenza.unref?.()
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
