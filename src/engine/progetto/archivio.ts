/**
 * Persistenza del file di progetto.
 *
 * Il §3.9 chiede salvataggio automatico a ogni modifica e il §6 chiede che un
 * crash non faccia perdere la configurazione. Insieme, quelle due righe
 * escludono la scrittura in place: si scrive un file temporaneo, lo si forza su
 * disco, e lo si rinomina sopra l'originale. La rinomina e atomica sia su NTFS
 * sia su POSIX, quindi in ogni istante esiste un file di progetto integro.
 *
 * In piu si tiene una copia `.bak` fatta PRIMA di ogni scrittura: cosi anche se
 * il processo muore nel mezzo, o se il file valido contiene dati che il
 * caricamento rifiuta, c'e sempre qualcosa da cui ripartire.
 */
import { createHash } from 'node:crypto'
import { constants as fsc } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { zProgetto, violazioni, type Progetto } from '../dominio/progetto.js'

export type EsitoCaricamento =
  | { stato: 'caricato'; progetto: Progetto; daBackup: boolean; avvisi: string[] }
  | { stato: 'assente' }
  | { stato: 'illeggibile'; motivo: string }

/** Quanto si aspetta dopo l'ultima modifica prima di scrivere davvero. */
const ATTESA_MS = 250
/** Non si sta mai piu di cosi senza scrivere, anche se le modifiche continuano. */
const ATTESA_MASSIMA_MS = 2000

export class ArchivioProgetto {
  readonly percorso: string
  private readonly percorsoBackup: string
  private readonly percorsoTemporaneo: string

  private inAttesa: Progetto | null = null
  private timer: NodeJS.Timeout | null = null
  private primoRinvio = 0
  private scritturaInCorso: Promise<void> = Promise.resolve()
  /** Impronta dell'ultimo contenuto scritto: evita riscritture identiche. */
  private ultimaImpronta = ''

  constructor(
    percorso: string,
    private readonly suErrore: (e: Error) => void = () => {},
    /** Iniettabile nei test, cosi non servono orologi veri. */
    private readonly adesso: () => number = () => performance.now(),
  ) {
    this.percorso = path.resolve(percorso)
    this.percorsoBackup = this.percorso + '.bak'
    this.percorsoTemporaneo = this.percorso + '.tmp'
  }

  // ------------------------------------------------------------ lettura

  async carica(): Promise<EsitoCaricamento> {
    const principale = await this.leggiEValida(this.percorso)
    if (principale.ok) {
      return {
        stato: 'caricato',
        progetto: principale.progetto,
        daBackup: false,
        avvisi: principale.avvisi,
      }
    }

    const esisteva = await this.esiste(this.percorso)
    const backup = await this.leggiEValida(this.percorsoBackup)
    if (backup.ok) {
      return {
        stato: 'caricato',
        progetto: backup.progetto,
        daBackup: true,
        avvisi: [
          esisteva
            ? `Il file di progetto era illeggibile (${principale.motivo}); ripreso dalla copia di sicurezza.`
            : 'Il file di progetto mancava; ripreso dalla copia di sicurezza.',
          ...backup.avvisi,
        ],
      }
    }

    if (!esisteva && !(await this.esiste(this.percorsoBackup))) return { stato: 'assente' }
    return { stato: 'illeggibile', motivo: principale.motivo }
  }

  private async leggiEValida(
    percorso: string,
  ): Promise<{ ok: true; progetto: Progetto; avvisi: string[] } | { ok: false; motivo: string }> {
    let testo: string
    try {
      testo = await fs.readFile(percorso, 'utf8')
    } catch (e) {
      return { ok: false, motivo: `non leggibile: ${(e as Error).message}` }
    }

    let grezzo: unknown
    try {
      grezzo = JSON.parse(testo)
    } catch (e) {
      return { ok: false, motivo: `JSON non valido: ${(e as Error).message}` }
    }

    const esito = zProgetto.safeParse(grezzo)
    if (!esito.success) {
      const primi = esito.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || '(radice)'}: ${i.message}`)
        .join('; ')
      return { ok: false, motivo: `struttura non valida: ${primi}` }
    }

    // Le violazioni di invariante NON impediscono il caricamento: un riferimento
    // a una Zona sparita e recuperabile, e rifiutare tutto il progetto a meta
    // serata sarebbe molto peggio del problema che segnala.
    const avvisi = violazioni(esito.data).map((v) => `${v.dove}: ${v.problema}`)
    return { ok: true, progetto: esito.data, avvisi }
  }

  private async esiste(p: string): Promise<boolean> {
    try {
      await fs.access(p, fsc.F_OK)
      return true
    } catch {
      return false
    }
  }

  // ---------------------------------------------------------- scrittura

  /**
   * Registra una modifica. Non scrive subito: raggruppa le modifiche ravvicinate
   * (trascinare un cursore del volume ne produce decine al secondo) ma non
   * aspetta mai piu di ATTESA_MASSIMA_MS.
   */
  programmaSalvataggio(progetto: Progetto): void {
    this.inAttesa = progetto
    const ora = this.adesso()
    if (this.timer === null) this.primoRinvio = ora

    if (this.timer) clearTimeout(this.timer)
    const scaduto = ora - this.primoRinvio >= ATTESA_MASSIMA_MS
    this.timer = setTimeout(() => void this.scarica(), scaduto ? 0 : ATTESA_MS)
    // Un salvataggio in sospeso non deve tenere vivo il processo.
    this.timer.unref?.()
  }

  /** Scrive subito tutto quello che e in sospeso e aspetta che sia su disco. */
  async scarica(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const progetto = this.inAttesa
    this.inAttesa = null
    if (!progetto) return this.scritturaInCorso

    // Le scritture si accodano: mai due rinomine sullo stesso file insieme.
    this.scritturaInCorso = this.scritturaInCorso
      .then(() => this.salvaOra(progetto))
      .catch((e) => this.suErrore(e as Error))
    return this.scritturaInCorso
  }

  /** Scrittura atomica vera e propria. Usala nei test; in esercizio passa da `scarica`. */
  async salvaOra(progetto: Progetto): Promise<void> {
    const testo = JSON.stringify(progetto, null, 2) + '\n'
    const impronta = createHash('sha1').update(testo).digest('hex')
    if (impronta === this.ultimaImpronta) return

    await fs.mkdir(path.dirname(this.percorso), { recursive: true })

    // La copia di sicurezza si fa PRIMA di toccare qualunque cosa: se moriamo
    // adesso, il file di progetto e ancora quello di prima ed e valido.
    try {
      await fs.copyFile(this.percorso, this.percorsoBackup)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }

    const f = await fs.open(this.percorsoTemporaneo, 'w')
    try {
      await f.writeFile(testo, 'utf8')
      // Senza questo, la rinomina puo diventare visibile prima dei dati e un
      // taglio di corrente lascia un file di lunghezza giusta e contenuto vuoto.
      await f.sync()
    } finally {
      await f.close()
    }

    // Atomica: MoveFileEx con REPLACE_EXISTING su Windows, rename(2) altrove.
    await fs.rename(this.percorsoTemporaneo, this.percorso)
    this.ultimaImpronta = impronta
  }

  /** Da chiamare alla chiusura: garantisce che l'ultima modifica sia su disco. */
  async chiudi(): Promise<void> {
    await this.scarica()
    await this.scritturaInCorso
  }
}
