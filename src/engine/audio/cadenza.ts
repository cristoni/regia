/**
 * La cadenza di scrittura del Flusso.
 *
 * Il mixer produce blocchi; questa classe decide QUANTI blocchi vanno prodotti
 * adesso. E il pezzo che decide se dopo sei ore siamo ancora in pari.
 *
 * Il modo sbagliato di farlo e `setInterval(scrivi, 20)`: setInterval non
 * garantisce 20 ms, garantisce "almeno 20 ms", e l'errore si accumula. Dopo
 * un'ora sono minuti di ritardo, e un flusso in ritardo va in underrun -- che e
 * esattamente il guasto del §2.2, i client che perdono la sincronia.
 *
 * Qui invece il conteggio si fa sempre contro l'orologio assoluto: quanti
 * blocchi AVREBBERO dovuto essere scritti da quando siamo partiti, meno quelli
 * gia scritti. L'errore non si accumula mai, per costruzione.
 *
 * Dopo una pausa lunga (il garbage collector, il portatile che si sospende, il
 * disco che si blocca) restano due strade, ed e una scelta di politica:
 *
 *   - RECUPERO: scrivere di colpo tutti i blocchi mancati. Il Flusso resta
 *     completo, ma arriva a raffica.
 *   - RIALLINEAMENTO: rinunciare al pezzo perso e ripartire da adesso. Nel
 *     Flusso resta un buco, ma la cadenza torna subito regolare.
 *
 * Si recupera fino a `recuperoMassimoMs` e oltre ci si riallinea. Il valore
 * giusto dipende da come snapserver legge davvero la sorgente TCP, che e una
 * delle misure ancora da fare: qui e una manopola apposta.
 */

export interface EsitoCadenza {
  /** Blocchi da produrre e scrivere adesso. */
  readonly blocchi: number
  /** Millisecondi di Flusso buttati via per riallineamento. 0 quasi sempre. */
  readonly buchiMs: number
}

export class Cadenza {
  private avviataA: number | null = null
  private scritti = 0
  private buchiTotaliMs = 0
  private riallineamenti = 0

  constructor(
    private readonly bloccoMs: number,
    /** Quanto Flusso teniamo avanti all'orologio, per assorbire le pause. */
    private readonly anticipoMs: number,
    /** Oltre questo ritardo si rinuncia a recuperare. */
    private readonly recuperoMassimoMs: number,
    /** Iniettabile: i test non devono aspettare il tempo vero. */
    private readonly adesso: () => number = () => performance.now(),
  ) {
    if (bloccoMs <= 0) throw new Error('bloccoMs deve essere positivo')
  }

  avvia(): void {
    this.avviataA = this.adesso()
    this.scritti = 0
    this.buchiTotaliMs = 0
    this.riallineamenti = 0
  }

  get avviata(): boolean {
    return this.avviataA !== null
  }

  /**
   * Quanti blocchi scrivere in questo istante, e quanto Flusso e stato perso.
   * Va chiamata subito prima di scrivere: aggiorna il conteggio.
   */
  dovuti(): EsitoCadenza {
    if (this.avviataA === null) throw new Error('cadenza non avviata')

    const trascorso = this.adesso() - this.avviataA
    // Due conti diversi, e tenerli separati e tutto il punto.
    //
    //   perOrologio -- quanto Flusso il tempo reale ha gia consumato. La
    //                  differenza con quel che abbiamo scritto e il RITARDO.
    //   conAnticipo -- quanto Flusso vogliamo avere davanti. La differenza e
    //                  lavoro da fare, ma NON e ritardo.
    //
    // Il tetto di recupero si applica solo al ritardo. Confonderli farebbe
    // scattare un riallineamento sul riempimento iniziale dell'anticipo, che e
    // il comportamento normale di ogni avvio.
    //
    // Il +1 c'e perche al tempo zero il primo blocco e gia dovuto: il Flusso
    // deve esistere prima che qualcuno lo ascolti.
    const perOrologio = Math.floor(trascorso / this.bloccoMs) + 1
    const conAnticipo = Math.floor((trascorso + this.anticipoMs) / this.bloccoMs) + 1

    let buchiMs = 0
    const ritardo = perOrologio - this.scritti
    const massimo = Math.max(1, Math.floor(this.recuperoMassimoMs / this.bloccoMs))
    if (ritardo > massimo) {
      const saltati = ritardo - massimo
      buchiMs = saltati * this.bloccoMs
      this.buchiTotaliMs += buchiMs
      this.riallineamenti++
      // Si finge di aver scritto anche i saltati: il conteggio torna in pari con
      // l'orologio e la cadenza riparte regolare al blocco successivo.
      this.scritti += saltati
    }

    const blocchi = Math.max(0, conAnticipo - this.scritti)
    this.scritti += blocchi
    return { blocchi, buchiMs }
  }

  /** Millisecondi da aspettare prima di avere di nuovo qualcosa da scrivere. */
  attesaMs(): number {
    if (this.avviataA === null) return this.bloccoMs
    const scadenza = this.scritti * this.bloccoMs - this.anticipoMs
    const attesa = scadenza - (this.adesso() - this.avviataA)
    // Mai negativo, e mai piu di un blocco: cosi il ciclo resta reattivo ai comandi.
    return Math.max(0, Math.min(this.bloccoMs, attesa))
  }

  diagnostica(): {
    blocchiScritti: number
    msProdotti: number
    buchiTotaliMs: number
    riallineamenti: number
    scartoMs: number
  } {
    const trascorso = this.avviataA === null ? 0 : this.adesso() - this.avviataA
    const prodotti = this.scritti * this.bloccoMs
    return {
      blocchiScritti: this.scritti,
      msProdotti: prodotti,
      buchiTotaliMs: this.buchiTotaliMs,
      riallineamenti: this.riallineamenti,
      // Positivo = siamo avanti all'orologio, che e come deve essere.
      scartoMs: prodotti - trascorso,
    }
  }
}
