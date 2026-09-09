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
 *     in pari con l'orologio, ma arriva a raffica.
 *   - RIALLINEAMENTO: rinunciare a recuperare e ripartire dal tempo di adesso.
 *     La cadenza torna subito regolare.
 *
 * Si recupera fino a `recuperoMassimoMs` e oltre ci si riallinea. Il valore
 * giusto dipende da come snapserver legge davvero la sorgente TCP, che e una
 * delle misure ancora da fare: qui e una manopola apposta.
 *
 * **Riallinearsi non fa buchi nell'audio, e per anni questo file ha detto il
 * contrario.** Si finge di aver scritto i blocchi saltati, ma il mixer non
 * avanza sopra di loro: non si perde un campione di cio che e stato prodotto.
 * Quel che si perde e il passo con il tempo reale -- la timeline scorre piu
 * lenta dell'orologio. Il danno e a valle e arriva dopo: i client tagliano
 * campioni per stare in pari (misurato: ~43 tagli al secondo, si sentono), e
 * la coda che si accumula prima di snapserver si somma alla latenza.
 *
 * Per questo il numero che esce di qui e un **ritardo**, non dei buchi, e si
 * guarda **a ritmo** (ms di ritardo per secondo) e non come totale che sale:
 * un totale che cresce non distingue «e successo mezz'ora fa» da «sta
 * succedendo adesso», ed e adesso che conta.
 */

/** Su quanto tempo si misura il ritmo del ritardo. Vedi `ritardoMsAlSecondo`. */
export const FINESTRA_RITARDO_MS = 30_000

export interface EsitoCadenza {
  /** Blocchi da produrre e scrivere adesso. */
  readonly blocchi: number
  /**
   * Millisecondi di tempo reale a cui si e rinunciato adesso, riallineandosi.
   * Non sono audio mancante: sono passo perso con l'orologio. 0 quasi sempre.
   */
  readonly ritardoMs: number
}

export class Cadenza {
  private avviataA: number | null = null
  private scritti = 0
  private ritardoTotaleMs = 0
  private riallineamenti = 0
  /**
   * Gli ultimi riallineamenti, per calcolare il ritmo su una finestra mobile.
   *
   * Sono pochi per costruzione -- uno ogni volta che si supera il tetto di
   * recupero -- e si potano a ogni lettura, quindi l'elenco resta corto anche
   * dopo sei ore.
   */
  private recenti: { quando: number; ms: number }[] = []

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
    this.ritardoTotaleMs = 0
    this.riallineamenti = 0
    this.recenti = []
  }

  get avviata(): boolean {
    return this.avviataA !== null
  }

  /**
   * Quanti blocchi scrivere in questo istante, e quanto passo si e perso.
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

    let ritardoMs = 0
    const ritardo = perOrologio - this.scritti
    const massimo = Math.max(1, Math.floor(this.recuperoMassimoMs / this.bloccoMs))
    if (ritardo > massimo) {
      const saltati = ritardo - massimo
      ritardoMs = saltati * this.bloccoMs
      this.ritardoTotaleMs += ritardoMs
      this.riallineamenti++
      this.recenti.push({ quando: this.adesso(), ms: ritardoMs })
      // Si finge di aver scritto anche i saltati: il conteggio torna in pari con
      // l'orologio e la cadenza riparte regolare al blocco successivo. Il mixer
      // pero non avanza sopra i saltati -- il Flusso non ha buchi, e indietro.
      this.scritti += saltati
    }

    const blocchi = Math.max(0, conAnticipo - this.scritti)
    this.scritti += blocchi
    return { blocchi, ritardoMs }
  }

  /**
   * Quanti millisecondi di ritardo si accumulano ogni secondo, adesso.
   *
   * E il numero che dice se le cose stanno andando male **in questo momento**,
   * e l'unico che si mostra all'Operatore. Zero e la condizione normale; sotto
   * carico misurato resta zero anche col thread principale bloccato per 28 s su
   * 40. Un valore stabilmente sopra zero significa che il Flusso non tiene il
   * tempo reale, e cio che si sente sono i client che tagliano per stare in pari.
   *
   * Il denominatore e la finestra vera trascorsa finche e piu corta della
   * finestra nominale: appena avviati, dividere per trenta secondi che non sono
   * ancora passati nasconderebbe un guasto proprio quando serve vederlo.
   */
  private ritmoRitardo(): number {
    if (this.avviataA === null) return 0
    const ora = this.adesso()
    const taglio = ora - FINESTRA_RITARDO_MS
    if (this.recenti.length > 0 && this.recenti[0]!.quando < taglio) {
      this.recenti = this.recenti.filter((r) => r.quando >= taglio)
    }
    if (this.recenti.length === 0) return 0
    const somma = this.recenti.reduce((n, r) => n + r.ms, 0)
    const finestra = Math.min(FINESTRA_RITARDO_MS, ora - this.avviataA)
    if (finestra <= 0) return 0
    return (somma * 1000) / finestra
  }

  /**
   * Millisecondi da aspettare prima di avere di nuovo qualcosa da scrivere.
   *
   * Il tetto NON e un blocco, ed e una lezione presa sul campo: su Windows la
   * risoluzione dei timer e 15,6 ms, quindi `setTimeout(20)` dorme davvero
   * ~31 ms. Svegliandosi a ogni blocco si perderebbero ~11 ms per giro -- e in
   * dodici secondi di misura questo ha prodotto 6,5 secondi di riallineamento e
   * uno scarto NEGATIVO, cioe un flusso perennemente in ritardo.
   *
   * Ci si sveglia invece ogni mezzo anticipo e si scrivono piu blocchi in una
   * volta: dormire 15 ms di troppo su 100 e assorbito da cio che resta
   * dell'anticipo. Il prezzo e che la pressione di un pulsante puo aspettare
   * fino a un risveglio prima di entrare nel mix.
   */
  attesaMs(): number {
    if (this.avviataA === null) return this.bloccoMs
    const scadenza = this.scritti * this.bloccoMs - this.anticipoMs
    const attesa = scadenza - (this.adesso() - this.avviataA)
    return Math.max(0, Math.min(this.tettoAttesaMs, attesa))
  }

  /** Quanto a lungo si puo dormire senza mangiarsi l'anticipo. */
  get tettoAttesaMs(): number {
    return Math.max(this.bloccoMs, Math.floor(this.anticipoMs / 2))
  }

  diagnostica(): {
    blocchiScritti: number
    msProdotti: number
    ritardoTotaleMs: number
    ritardoMsAlSecondo: number
    riallineamenti: number
    scartoMs: number
  } {
    const trascorso = this.avviataA === null ? 0 : this.adesso() - this.avviataA
    const prodotti = this.scritti * this.bloccoMs
    return {
      blocchiScritti: this.scritti,
      msProdotti: prodotti,
      ritardoTotaleMs: this.ritardoTotaleMs,
      ritardoMsAlSecondo: this.ritmoRitardo(),
      riallineamenti: this.riallineamenti,
      // Positivo = siamo avanti all'orologio, che e come deve essere.
      scartoMs: prodotti - trascorso,
    }
  }
}
