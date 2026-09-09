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
  private readonly suDiagnostica: (m: string) => void
  private readonly dormi: (ms: number) => Promise<void>

  constructor(o: OpzioniScrittore) {
    this.impostazioni = o.impostazioni
    this.mixer = o.mixer
    this.collega = o.collega
    this.attesaRiprovaMs = o.attesaRiprovaMs ?? 500
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

  async ferma(): Promise<void> {
    this.fermare = true
    await this.ciclo?.catch(() => {})
    this.ciclo = null
    await this.staccaDestinazione()
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
        this.suDiagnostica(`scrittura fallita: ${(e as Error).message}`)
        await this.segnalaCaduta()
        continue
      }
      await this.dormi(this.cadenza.attesaMs())
    }
  }

  private async riprovaCollegamento(): Promise<boolean> {
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
      this.destinazione = await this.collega()
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
        await d.attendiScarico()
      }
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
