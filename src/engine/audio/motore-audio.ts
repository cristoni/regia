/**
 * La maniglia del thread audio, vista dal thread principale.
 *
 * Nasconde `worker_threads` al resto del motore: chi la usa vede metodi
 * sincroni che non possono fallire in modo interessante, perche un comando
 * audio perso durante l'Evento non deve mai propagarsi come eccezione fino
 * all'interfaccia. L'Operatore ripreme, non riavvia.
 */
import { Worker } from 'node:worker_threads'

import type { ImpostazioniAudio } from '../dominio/progetto.js'
import type { Livello } from '../api/protocollo.js'
import type { ComandoAudio, EventoAudio, FlussoDaServire, StatoFlusso } from './protocollo-audio.js'

export interface OpzioniMotoreAudio {
  readonly suDiario: (livello: Livello, testo: string) => void
}

/**
 * Il file del thread audio, accanto a questo.
 *
 * Si ricava dall'estensione di *questo* modulo: sotto `tsx` siamo un `.ts` e il
 * lavoratore pure; dopo `tsc` siamo un `.js` e il lavoratore pure. Una costante
 * scritta a mano funzionerebbe solo in uno dei due casi, e l'altro si
 * scoprirebbe al primo avvio dell'app impacchettata.
 */
const PERCORSO_LAVORATORE = new URL(
  import.meta.url.replace(/motore-audio\.(m?[tj]s)$/, 'lavoratore.$1'),
)

export class MotoreAudio {
  private worker: Worker | null = null
  private ultimoStato: readonly StatoFlusso[] = []
  private pronto = false
  private readonly attesaPronto: Promise<void>
  /** Caricamenti di Suoni in volo, in attesa della conferma dal thread audio. */
  private readonly inCaricamento = new Map<
    string,
    { ok: (durataMs: number) => void; ko: (e: Error) => void }
  >()

  constructor(private readonly opzioni: OpzioniMotoreAudio) {
    // NON si chiama `unref()` su questo worker, ed e deliberato. Un worker
    // scollegato dal ciclo di eventi non lo tiene vivo: se il thread
    // principale sta soltanto aspettando una risposta dal thread audio -- come
    // fa all'avvio -- Node considera il processo senza lavoro e lo chiude,
    // lasciando l'attesa appesa per sempre. E comunque giusto cosi: finche il
    // Flusso scorre, Regia e viva. Si spegne con `chiudi()`.
    const worker = new Worker(PERCORSO_LAVORATORE, { name: 'audio-regia' })
    this.worker = worker

    this.attesaPronto = new Promise<void>((ok) => {
      const suMessaggio = (e: EventoAudio) => {
        if (e.tipo === 'pronto') {
          this.pronto = true
          worker.off('message', suMessaggio)
          ok()
        }
      }
      worker.on('message', suMessaggio)
    })

    worker.on('message', (e: EventoAudio) => this.ricevi(e))
    worker.on('error', (e) => {
      this.opzioni.suDiario('grave', `il thread audio e morto: ${e.message}`)
      this.worker = null
      for (const [, a] of this.inCaricamento) a.ko(e)
      this.inCaricamento.clear()
    })
    worker.on('exit', (codice) => {
      if (codice !== 0) this.opzioni.suDiario('grave', `il thread audio e uscito con ${codice}`)
      this.worker = null
    })
  }

  /** Si risolve quando il thread audio ha risposto di essere in piedi. */
  aspettaPronto(): Promise<void> {
    return this.attesaPronto
  }

  get vivo(): boolean {
    return this.worker !== null && this.pronto
  }

  /** Lo stato piu recente ricevuto dal thread audio. Mai `await`. */
  stato(): readonly StatoFlusso[] {
    return this.ultimoStato
  }

  statoDi(zonaId: string): StatoFlusso | undefined {
    return this.ultimoStato.find((f) => f.zonaId === zonaId)
  }

  // ------------------------------------------------------------- comandi

  /**
   * @param host Dove aprire le socket delle sorgenti. **Non** `127.0.0.1`
   *   quando snapserver sta in WSL: gli inoltri su loopback sopravvivono al
   *   processo che ascoltava e accettano byte che nessuno leggera mai.
   */
  configura(host: string, audio: ImpostazioniAudio, flussi: readonly FlussoDaServire[]): void {
    this.manda({ tipo: 'configura', audio, flussi, host })
  }
  avvia(): void {
    this.manda({ tipo: 'avvia' })
  }
  fermaFlusso(): void {
    this.manda({ tipo: 'ferma' })
  }
  /**
   * Carica un Suono e **aspetta la conferma**.
   *
   * Aspettare toglie una corsa: senza, `suono.importa` tornerebbe prima che il
   * thread audio abbia i campioni, e un pulsante premuto subito dopo
   * risponderebbe "non ancora pronto". Sono millisecondi -- una lettura da
   * disco -- ma sono esattamente i millisecondi in cui l'Operatore prova il
   * Suono appena importato.
   */
  caricaSuono(suonoId: string, percorso: string): Promise<number> {
    const inCorso = this.inCaricamento.get(suonoId)
    if (inCorso) inCorso.ko(new Error('caricamento sostituito da uno nuovo'))

    return new Promise<number>((ok, ko) => {
      this.inCaricamento.set(suonoId, { ok, ko })
      const w = this.worker
      if (!w) {
        this.inCaricamento.delete(suonoId)
        ko(new Error('il thread audio non c\'e piu'))
        return
      }
      w.postMessage({ tipo: 'caricaSuono', suonoId, percorso } satisfies ComandoAudio)
    })
  }
  scaricaSuono(suonoId: string): void {
    this.inCaricamento.get(suonoId)?.ko(new Error('Suono eliminato'))
    this.inCaricamento.delete(suonoId)
    this.manda({ tipo: 'scaricaSuono', suonoId })
  }
  suona(zone: readonly string[], suonoId: string, guadagno: number, esclusivo: boolean): void {
    this.manda({ tipo: 'suona', zone, suonoId, guadagno, esclusivo })
  }
  sottofondo(zonaId: string, suonoId: string | null, guadagno: number): void {
    this.manda({ tipo: 'sottofondo', zonaId, suonoId, guadagno })
  }
  volume(zonaId: string, volume: number): void {
    this.manda({ tipo: 'volume', zonaId, volume })
  }
  stopZona(zonaId: string): void {
    this.manda({ tipo: 'stopZona', zonaId })
  }
  stopTutto(): void {
    this.manda({ tipo: 'stopTutto' })
  }

  async chiudi(): Promise<void> {
    const w = this.worker
    this.worker = null
    for (const [, a] of this.inCaricamento) a.ko(new Error('Regia si sta chiudendo'))
    this.inCaricamento.clear()
    if (!w) return
    w.postMessage({ tipo: 'ferma' } satisfies ComandoAudio)
    // Un attimo perche le socket si chiudano in modo ordinato prima di
    // staccare il thread: chiuderle bruscamente lascerebbe snapserver con una
    // connessione mezza aperta sulla porta su cui dovremo rientrare.
    await new Promise((r) => setTimeout(r, 150))
    await w.terminate()
  }

  // ------------------------------------------------------------- interni

  private manda(c: ComandoAudio): void {
    const w = this.worker
    if (!w) {
      this.opzioni.suDiario('grave', `comando audio "${c.tipo}" perso: il thread audio non c'e piu`)
      return
    }
    w.postMessage(c)
  }

  private ricevi(e: EventoAudio): void {
    switch (e.tipo) {
      case 'stato':
        this.ultimoStato = e.flussi
        break
      case 'diario':
        this.opzioni.suDiario(e.livello, e.testo)
        break
      case 'suonoCaricato': {
        const a = this.inCaricamento.get(e.suonoId)
        this.inCaricamento.delete(e.suonoId)
        a?.ok(e.durataMs)
        break
      }
      case 'suonoFallito': {
        const a = this.inCaricamento.get(e.suonoId)
        this.inCaricamento.delete(e.suonoId)
        a?.ko(new Error(e.errore))
        break
      }
      case 'pronto':
        break
    }
  }
}
