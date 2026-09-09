/**
 * Il contratto fra il guscio dell'applicazione e le sue sette schermate.
 *
 * Volutamente minuscolo. Una schermata e un pezzo di DOM che esiste una volta
 * sola e che sa aggiornarsi da un'istantanea: non si smonta quando si cambia
 * scheda, si nasconde. E cio che permette alla griglia video di sopravvivere a
 * un giro nelle Impostazioni senza perdere i decodificatori -- e con loro un
 * secondo di nero per cella al ritorno.
 */
import type { Comando, Stato } from '../../engine/api/protocollo'
import type { Collegamento, RigaDiario } from './collegamento'

export interface Contesto {
  readonly collegamento: Collegamento
  /** L'ultima istantanea. Mai `null` dopo il primo aggiornamento. */
  stato(): Stato
  /**
   * Manda un comando senza aspettarlo. Se il motore lo rifiuta, il messaggio
   * compare in un avviso che passa da solo: durante l'Evento **niente finestre
   * bloccanti** (§5.2), e l'Operatore deve poter ripremere, non riavviare.
   */
  manda(comando: Comando): void
  /** Come `manda`, ma si puo aspettare l'esito. Rilancia se fallisce. */
  attendi(comando: Comando): Promise<void>
  avvisa(testo: string, bene?: boolean): void
  vai(schermata: string): void
  /** Le ultime righe di diario ricevute, dalla piu vecchia. */
  diario(): readonly RigaDiario[]
}

export interface Schermata {
  readonly elemento: HTMLElement
  aggiorna(stato: Stato): void
  /**
   * Le Telecamere di cui questa schermata vuole i fotogrammi, adesso.
   *
   * Il motore apre la connessione verso un telefono solo se qualcuno la
   * guarda: una schermata che non chiede niente restituisce banda agli
   * Altoparlanti, ed e cio che deve fare mentre e nascosta.
   */
  telecamere?(stato: Stato): string[]
  entra?(): void
  esci?(): void
}
