/**
 * Il motore di mixaggio di una Zona.
 *
 * Questo e il componente che l'ADR 0001 descrive come il piu grosso del
 * progetto, ed esiste per una ragione sola: Snapcast non tollera un flusso che
 * si ferma. Quindi qui non esiste il concetto di "non sto suonando niente" --
 * esiste solo "sto suonando silenzio".
 *
 * La classe e volutamente PURA: non conosce socket, orologi, file. Le si chiede
 * il blocco successivo e lo produce. Chi lo scrive, e con che cadenza, e affare
 * di scrittore.ts. Questo la rende collaudabile senza aspettare tempo reale:
 * sessanta minuti di sottofondo sono 180.000 chiamate a `prossimoBlocco`, non
 * un'ora di attesa.
 *
 * Formato: PCM interleaved LRLR, signed 16 bit little endian (ADR 0007).
 */
import type { ImpostazioniAudio } from '../dominio/progetto.js'
import { campioniBlocco } from '../dominio/progetto.js'

/** Un Suono gia decodificato nel formato del progetto e tenuto in memoria. */
export interface Campionato {
  readonly suonoId: string
  /** Interleaved, gia nel numero di canali e nella frequenza del progetto. */
  readonly campioni: Int16Array
  /** Campioni per canale. */
  readonly durata: number
}

export function campionato(suonoId: string, campioni: Int16Array, canali: number): Campionato {
  return { suonoId, campioni, durata: Math.floor(campioni.length / canali) }
}

const MIN16 = -32768
const MAX16 = 32767

type Ruolo = 'sottofondo' | 'effetto'

/**
 * Una voce in esecuzione.
 *
 * Il guadagno non e una macchina a stati ma il prodotto di due inviluppi
 * calcolati dalla posizione:
 *
 *   apertura   = campioniSuonati / dissolvenza      (sale da 0 a 1)
 *   coda       = campioniRestanti / dissolvenza     (scende a 0 sul finale)
 *   arresto    = rampa verso 0 quando si chiede STOP
 *
 *   guadagno = min(apertura, coda) * arresto
 *
 * Cosi non esistono casi limite da trattare a parte. Un Effetto piu corto della
 * dissolvenza non viene azzerato prima di partire: apertura e coda si
 * incontrano e producono un inviluppo triangolare, che e esattamente giusto.
 */
class Voce {
  /** Posizione nella sorgente, in campioni per canale. Torna a 0 nei loop. */
  posizione = 0
  /** Campioni suonati da quando la voce e nata. Non torna indietro nei loop. */
  suonati = 0
  /** Inviluppo di arresto: 1 finche non si chiede STOP, poi scende a 0. */
  arresto = 1
  inArresto = false
  finita = false

  constructor(
    readonly istanza: number,
    readonly ruolo: Ruolo,
    readonly fonte: Campionato,
    readonly guadagno: number,
    readonly loop: boolean,
    readonly campioniDissolvenza: number,
  ) {}

  get passo(): number {
    return this.campioniDissolvenza > 0 ? 1 / this.campioniDissolvenza : 1
  }

  chiudi(): void {
    this.inArresto = true
  }
}

export interface EffettoInCorso {
  readonly suonoId: string
  readonly istanza: number
}

export interface StatoZona {
  readonly volume: number
  /**
   * Quali Effetti stanno suonando, non quanti: l'interfaccia deve illuminare il
   * pulsante *giusto* (§5.2), e con un semplice conteggio non potrebbe.
   */
  readonly effetti: readonly EffettoInCorso[]
  readonly effettiAttivi: number
  readonly sottofondoAttivo: boolean
}

export class MixerZona {
  private readonly canali: number
  private readonly campioniPerBlocco: number
  private readonly campioniDissolvenza: number
  /** Accumulatore a 32 bit: sommare piu voci in 16 bit farebbe wrap-around. */
  private readonly somma: Int32Array
  private voci: Voce[] = []
  private prossimaIstanza = 1
  private volume: number

  constructor(
    private readonly impostazioni: ImpostazioniAudio,
    volumeIniziale = 1,
  ) {
    this.canali = impostazioni.canali
    this.campioniPerBlocco = campioniBlocco(impostazioni)
    this.campioniDissolvenza = Math.max(
      1,
      Math.round((impostazioni.frequenza * impostazioni.dissolvenzaMs) / 1000),
    )
    this.somma = new Int32Array(this.campioniPerBlocco * this.canali)
    this.volume = volumeIniziale
  }

  // ------------------------------------------------------------- comandi

  /** Fa partire un Effetto. Restituisce l'istanza, con cui si puo fermarlo. */
  avviaEffetto(fonte: Campionato, guadagno = 1): number {
    const v = new Voce(
      this.prossimaIstanza++,
      'effetto',
      fonte,
      guadagno,
      false,
      this.campioniDissolvenza,
    )
    this.voci.push(v)
    return v.istanza
  }

  /**
   * Cambia il Sottofondo della Zona. Il precedente sfuma invece di sparire.
   * `null` toglie il Sottofondo.
   */
  impostaSottofondo(fonte: Campionato | null, guadagno = 1): void {
    for (const v of this.voci) if (v.ruolo === 'sottofondo') v.chiudi()
    if (!fonte) return
    this.voci.push(
      new Voce(this.prossimaIstanza++, 'sottofondo', fonte, guadagno, true, this.campioniDissolvenza),
    )
  }

  /** STOP di Zona: ferma gli Effetti, il Sottofondo continua (§3.5). */
  fermaEffetti(): void {
    this.chiudiVoci((v) => v.ruolo === 'effetto')
  }

  /** Ferma tutto, Sottofondo compreso. Il Flusso continua: diventa silenzio. */
  fermaTutto(): void {
    this.chiudiVoci(() => true)
  }

  fermaIstanza(istanza: number): void {
    this.chiudiVoci((v) => v.istanza === istanza)
  }

  private chiudiVoci(prova: (v: Voce) => boolean): void {
    let daPotare = false
    for (const v of this.voci) {
      if (!prova(v)) continue
      v.chiudi()
      // Una voce che non ha ancora prodotto un solo campione non ha niente da
      // sfumare: si chiude subito. Senza questo, con il mixer fermo -- che e la
      // situazione normale col server audio spento, durante il Setup -- ogni
      // pressione lascerebbe dietro una voce che nessuno verra mai a ripulire,
      // perche a ripulire e `prossimoBlocco`, che nessuno sta chiamando.
      if (v.suonati === 0) {
        v.finita = true
        daPotare = true
      }
    }
    if (daPotare) this.voci = this.voci.filter((v) => !v.finita)
  }

  /** Sostituisce gli Effetti in corso invece di sovrapporsi (§3.5, opzionale). */
  avviaEffettoEsclusivo(fonte: Campionato, guadagno = 1): number {
    this.fermaEffetti()
    return this.avviaEffetto(fonte, guadagno)
  }

  impostaVolume(v: number): void {
    this.volume = Math.max(0, Math.min(2, v))
  }

  stato(): StatoZona {
    const effetti: EffettoInCorso[] = []
    let sottofondo = false
    for (const v of this.voci) {
      // Una voce in arresto non e piu "in corso": sta sfumando, e l'Operatore
      // ha gia premuto STOP. Contarla farebbe restare acceso il pulsante.
      if (v.finita || v.inArresto) continue
      if (v.ruolo === 'effetto') effetti.push({ suonoId: v.fonte.suonoId, istanza: v.istanza })
      else sottofondo = true
    }
    return {
      volume: this.volume,
      effetti,
      effettiAttivi: effetti.length,
      sottofondoAttivo: sottofondo,
    }
  }

  // ------------------------------------------------------------- il mix

  /**
   * Riempie `uscita` con il blocco successivo. `uscita` va allocata una volta
   * sola da chi chiama e riusata: dentro il ciclo non si alloca mai niente.
   */
  prossimoBlocco(uscita: Int16Array): void {
    if (uscita.length !== this.campioniPerBlocco * this.canali) {
      throw new Error(
        `blocco di dimensione sbagliata: ${uscita.length}, attesi ${this.campioniPerBlocco * this.canali}`,
      )
    }
    this.somma.fill(0)

    for (const v of this.voci) {
      if (v.finita) continue
      this.mescolaVoce(v)
    }

    // Il volume di Zona si applica QUI e non via RPC: cosi e istantaneo e non
    // dipende dal fatto che snapserver risponda (ADR 0005).
    const vol = this.volume
    for (let i = 0; i < uscita.length; i++) {
      const x = Math.round(this.somma[i]! * vol)
      uscita[i] = x < MIN16 ? MIN16 : x > MAX16 ? MAX16 : x
    }

    if (this.voci.some((v) => v.finita)) this.voci = this.voci.filter((v) => !v.finita)
  }

  private mescolaVoce(v: Voce): void {
    const { campioni, durata } = v.fonte
    const canali = this.canali
    const dissolvenza = v.campioniDissolvenza
    const passo = v.passo
    let pos = v.posizione
    let suonati = v.suonati
    let arresto = v.arresto

    for (let n = 0; n < this.campioniPerBlocco; n++) {
      if (pos >= durata) {
        if (!v.loop) {
          v.finita = true
          break
        }
        pos = 0
      }

      if (v.inArresto) {
        arresto -= passo
        if (arresto <= 0) {
          v.finita = true
          break
        }
      }

      const apertura = suonati >= dissolvenza ? 1 : suonati / dissolvenza
      // Un Sottofondo in loop non ha coda: non finisce mai.
      const restanti = durata - pos
      const coda = v.loop || restanti >= dissolvenza ? 1 : restanti / dissolvenza
      const fattore = (apertura < coda ? apertura : coda) * arresto * v.guadagno

      const iSorgente = pos * canali
      const iUscita = n * canali
      for (let c = 0; c < canali; c++) {
        this.somma[iUscita + c]! += Math.round(campioni[iSorgente + c]! * fattore)
      }

      pos++
      suonati++
    }

    v.posizione = pos
    v.suonati = suonati
    v.arresto = arresto
  }
}
