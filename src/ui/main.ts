/**
 * Il guscio dell'interfaccia: navigazione, barra di stato, e le sette schermate.
 *
 * Le schermate si costruiscono tutte all'avvio e non si smontano mai: cambiare
 * scheda le nasconde, non le distrugge. Costa qualche kilobyte di DOM e fa
 * risparmiare la cosa che conta -- i `VideoDecoder` dietro le celle della
 * griglia, che ricreati costerebbero un secondo di nero per cella ogni volta
 * che si torna in Produzione.
 *
 * Ogni istantanea che arriva viene data **solo alla schermata visibile**: le
 * altre si aggiorneranno quando torneranno visibili, e nel frattempo dieci
 * aggiornamenti al secondo di sei schermate nascoste sarebbero lavoro buttato.
 * Produzione fa eccezione, e vale la pena dire perche: i tasti rapidi devono
 * funzionare da qualunque schermata, quindi ha bisogno di sapere sempre com'e
 * messo il mondo.
 */
import type { Comando, Stato } from '../engine/api/protocollo'
import { Collegamento, type RigaDiario } from './nucleo/collegamento'
import { classe, el, testo } from './nucleo/dom'
import type { Contesto, Schermata } from './nucleo/schermata'
import { salute } from './nucleo/viste'
import { Produzione } from './schermate/produzione'
import { Dispositivi } from './schermate/dispositivi'
import { Zone } from './schermate/zone'
import { Suoni } from './schermate/suoni'
import { Registrazioni } from './schermate/registrazioni'
import { Impostazioni } from './schermate/impostazioni'
import { Setup } from './schermate/setup'

/** Quante righe di diario tiene l'interfaccia, per l'esportazione. */
const RIGHE_DIARIO = 500

interface Voce {
  readonly chiave: string
  readonly etichetta: string
  readonly schermata: Schermata
  readonly pulsante: HTMLButtonElement
}

class App {
  private readonly collegamento = new Collegamento()
  private readonly radice: HTMLElement
  private readonly navigazione = el('nav', { class: 'navigazione' })
  private readonly schermo = el('main', { class: 'schermo' })
  private readonly barra = el('div', { class: 'barra' })
  private readonly pastiglia = el('span', { class: 'pastiglia spento', testo: '…' })
  private readonly messaggio = el('span', { class: 'messaggio' })
  private readonly misure = el('span', { class: 'misura' })
  private readonly brindisi = el('div', { class: 'brindisi' })
  private readonly voci: Voce[] = []
  private readonly righeDiario: RigaDiario[] = []
  private attiva: Voce | null = null
  private ultimo: Stato | null = null
  private produzione!: Produzione

  constructor(radice: HTMLElement) {
    this.radice = radice
    const ctx = this.contesto()

    this.produzione = new Produzione(ctx)
    const schermate: [string, string, Schermata][] = [
      ['produzione', 'Produzione', this.produzione],
      ['dispositivi', 'Dispositivi', new Dispositivi(ctx)],
      ['zone', 'Zone', new Zone(ctx)],
      ['suoni', 'Suoni', new Suoni(ctx)],
      ['registrazioni', 'Registrazioni', new Registrazioni(ctx)],
      ['impostazioni', 'Impostazioni', new Impostazioni(ctx)],
      ['setup', 'Setup guidato', new Setup(ctx)],
    ]

    this.navigazione.append(
      el('div', { class: 'marchio' }, 'Regia', el('small', { testo: 'in attesa del motore…' })),
    )

    for (const [chiave, etichetta, schermata] of schermate) {
      const pulsante = el('button', { type: 'button', testo: etichetta })
      pulsante.addEventListener('click', () => this.vai(chiave))
      this.navigazione.append(pulsante)
      this.schermo.append(schermata.elemento)
      this.voci.push({ chiave, etichetta, schermata, pulsante })
    }

    const stopTutto = el('button', {
      type: 'button',
      class: 'stop-tutto',
      testo: 'STOP TUTTO',
      title: 'Ferma tutti gli Effetti in tutte le Zone. Anche con Esc.',
    })
    stopTutto.addEventListener('click', () => this.manda({ tipo: 'stopTutto' }))
    this.navigazione.append(el('div', { class: 'riempi' }), stopTutto)

    this.barra.append(this.pastiglia, this.messaggio, this.misure)
    radice.className = 'app'
    radice.replaceChildren(this.navigazione, this.schermo, this.barra, this.brindisi)

    this.collegamento.ascoltaStato((s) => this.riceviStato(s))
    this.collegamento.ascoltaDiario((r) => this.riceviDiario(r))
    this.collegamento.ascoltaVideo((id, chiave, dati) =>
      this.produzione.fotogramma(id, chiave, dati),
    )
    this.collegamento.ascoltaFilo((collegato) => this.filo(collegato))

    this.vai('produzione')
    this.collegamento.avvia()
  }

  // -------------------------------------------------------------- interni

  private contesto(): Contesto {
    return {
      collegamento: this.collegamento,
      stato: () => {
        if (!this.ultimo) throw new Error('nessuna istantanea ancora')
        return this.ultimo
      },
      manda: (c) => this.manda(c),
      attendi: (c) => this.collegamento.manda(c),
      avvisa: (t, bene) => this.avvisa(t, bene),
      vai: (chiave) => this.vai(chiave),
      diario: () => this.righeDiario,
    }
  }

  /**
   * Manda un comando e, se il motore lo rifiuta, lo dice senza bloccare.
   *
   * Niente `alert`, niente finestre modali: durante l'Evento **nessuna finestra
   * bloccante** (§5.2). Un comando rifiutato e una riga che compare in basso a
   * destra e se ne va da sola; l'Operatore ripreme, non riavvia.
   */
  private manda(comando: Comando): void {
    this.collegamento.manda(comando).catch((e: unknown) => this.avvisa((e as Error).message))
  }

  private avvisa(testoAvviso: string, bene = false): void {
    const riga = el('div', { class: bene ? 'bene' : '', testo: testoAvviso })
    this.brindisi.append(riga)
    setTimeout(() => riga.remove(), bene ? 2500 : 6000)
    // Piu di quattro avvisi insieme sono illeggibili: si tengono gli ultimi.
    while (this.brindisi.childElementCount > 4) this.brindisi.firstElementChild?.remove()
  }

  private vai(chiave: string): void {
    const voce = this.voci.find((v) => v.chiave === chiave)
    if (!voce || voce === this.attiva) return

    this.attiva?.schermata.esci?.()
    for (const v of this.voci) {
      classe(v.schermata.elemento, 'attiva', v === voce)
      v.pulsante.setAttribute('aria-current', v === voce ? 'true' : 'false')
    }
    this.attiva = voce
    if (this.ultimo) voce.schermata.aggiorna(this.ultimo)
    voce.schermata.entra?.()
    this.aggiornaVideo()
  }

  private riceviStato(stato: Stato): void {
    this.ultimo = stato

    // Produzione si aggiorna anche da nascosta: i tasti rapidi valgono da
    // qualunque schermata, e per rispondere ha bisogno dell'istantanea.
    if (this.attiva?.schermata !== this.produzione) this.produzione.aggiorna(stato)
    this.attiva?.schermata.aggiorna(stato)

    const s = salute(stato)
    testo(this.pastiglia, etichettaServer(stato))
    this.pastiglia.className = `pastiglia ${
      stato.server === 'acceso' ? 'info' : stato.server === 'caduto' ? 'grave' : 'spento'
    }`
    testo(this.messaggio, s.testo)
    this.messaggio.style.color =
      s.livello === 'grave'
        ? 'var(--grave)'
        : s.livello === 'attenzione'
          ? 'var(--attenzione)'
          : 'var(--testo-quieto)'

    testo(
      this.misure,
      `latenza ${stato.latenzaAttesaMs} ms · ${stato.audio.bandaMbit} Mbit/s · ` +
        `${stato.registrazione.attive} REC · ${stato.registrazione.spazioLiberoGb.toFixed(1)} GB`,
    )

    const marchio = this.navigazione.querySelector('.marchio small')
    if (marchio) testo(marchio as HTMLElement, stato.progettoNome)

    this.aggiornaVideo()
  }

  /**
   * Ridice al motore quali Telecamere servono adesso.
   *
   * Il motore apre la connessione verso un telefono solo se qualcuno la
   * guarda: una schermata che non chiede video restituisce banda agli
   * Altoparlanti, e con sei Telecamere sono megabit, non dettagli.
   */
  private aggiornaVideo(): void {
    if (!this.ultimo) return
    this.collegamento.iscriviVideo(this.attiva?.schermata.telecamere?.(this.ultimo) ?? [])
  }

  private riceviDiario(riga: RigaDiario): void {
    this.righeDiario.push(riga)
    if (this.righeDiario.length > RIGHE_DIARIO) this.righeDiario.shift()
    // Solo cio che serve sapere subito diventa un avviso: il resto sta nel
    // diario, che si esporta dalle Impostazioni.
    if (riga.livello === 'grave') this.avvisa(riga.testo)
  }

  private filo(collegato: boolean): void {
    classe(this.barra, 'staccata', !collegato)
    if (collegato) return
    testo(this.pastiglia, 'scollegata')
    this.pastiglia.className = 'pastiglia grave'
    testo(
      this.messaggio,
      'Il motore non risponde. Regia continua a suonare: il Flusso vive nel thread audio, ' +
        'non in questa pagina. Mi ricollego da sola.',
    )
  }
}

function etichettaServer(stato: Stato): string {
  switch (stato.server) {
    case 'acceso':
      return `${stato.altoparlanti.filter((a) => a.collegato).length} collegati`
    case 'in avvio':
      return 'in avvio'
    case 'caduto':
      return 'server caduto'
    case 'non installato':
      return 'non installato'
    default:
      return 'server spento'
  }
}

const radice = document.getElementById('regia')
if (radice) new App(radice)
