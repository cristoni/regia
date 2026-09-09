/**
 * Registrazioni: i file, la cartella, le impostazioni (§5.1.5).
 *
 * L'elenco dei file **non** viaggia nell'istantanea dello stato: sono
 * centinaia di righe che cambiano una volta ogni dieci minuti, e l'istantanea
 * viaggia dieci volte al secondo. Si va a prenderlo quando si apre questa
 * schermata, e basta.
 *
 * Il REC per Zona e globale sta qui accanto a quello per Telecamera perche
 * durante l'Evento nessuno vuole premere sei pulsanti: "registra tutto" e un
 * pulsante solo, e un guasto su una Telecamera non ferma le altre.
 */
import type { Stato } from '../../engine/api/protocollo'
import { Elenco, el, testo, valore, type Voce } from '../nucleo/dom'
import type { Contesto, Schermata } from '../nucleo/schermata'
import { byte, quandoCompleto } from '../nucleo/viste'

interface FileRegistrato {
  readonly nome: string
  readonly byte: number
  readonly quando: string
}

export class Registrazioni implements Schermata {
  readonly elemento = el('section', {})
  private readonly corpo = el('tbody', {})
  private readonly elenco: Elenco<FileRegistrato>
  private readonly vuoto = el('div', { class: 'vuoto', testo: 'Nessuna registrazione.' })
  private readonly spazio = el('div', { class: 'avviso info' })
  private readonly riepilogo = el('span', { class: 'conteggi' })
  private readonly cartella = el('input', { type: 'text' }) as HTMLInputElement
  private readonly segmento = el('input', { type: 'number', min: '1', max: '120' }) as HTMLInputElement
  private readonly avviso = el('input', { type: 'number', min: '0', step: '1' }) as HTMLInputElement
  private readonly blocco = el('input', { type: 'number', min: '0', step: '1' }) as HTMLInputElement
  private readonly conAudio = el('input', { type: 'checkbox' }) as HTMLInputElement
  private aggiornamento: number | undefined
  private ultimo: Stato | null = null

  constructor(private readonly ctx: Contesto) {
    const tuttoOn = el('button', { class: 'pulsante principale', type: 'button', testo: 'Registra tutto' })
    tuttoOn.addEventListener('click', () =>
      this.ctx.manda({ tipo: 'registrazione.avvia', ambito: { su: 'tutto' } }),
    )
    const tuttoOff = el('button', { class: 'pulsante pericolo', type: 'button', testo: 'Ferma tutto' })
    tuttoOff.addEventListener('click', () =>
      this.ctx.manda({ tipo: 'registrazione.ferma', ambito: { su: 'tutto' } }),
    )
    const apri = el('button', { class: 'pulsante', type: 'button', testo: 'Apri la cartella' })
    apri.addEventListener('click', () => this.ctx.manda({ tipo: 'registrazione.apriCartella' }))
    const rileggi = el('button', { class: 'pulsante', type: 'button', testo: 'Rileggi l\'elenco' })
    rileggi.addEventListener('click', () => void this.leggiElenco())

    this.cartella.addEventListener('change', () =>
      this.ctx.manda({ tipo: 'impostazioni.registrazione', cartella: this.cartella.value.trim() }),
    )
    this.segmento.addEventListener('change', () =>
      this.ctx.manda({
        tipo: 'impostazioni.registrazione',
        minutiSegmento: Number(this.segmento.value) || 10,
      }),
    )
    this.avviso.addEventListener('change', () =>
      this.ctx.manda({
        tipo: 'impostazioni.registrazione',
        avvisoSpazioGb: Number(this.avviso.value) || 0,
      }),
    )
    this.blocco.addEventListener('change', () =>
      this.ctx.manda({
        tipo: 'impostazioni.registrazione',
        bloccoSpazioGb: Number(this.blocco.value) || 0,
      }),
    )
    this.conAudio.addEventListener('change', () =>
      this.ctx.manda({ tipo: 'impostazioni.registrazione', conAudio: this.conAudio.checked }),
    )

    this.elemento.append(
      el(
        'div',
        { class: 'intestazione' },
        el(
          'div',
          {},
          el('h1', { testo: 'Registrazioni' }),
          el('p', {
            class: 'sottotitolo',
            testo:
              'I file si scrivono sul PC senza ricodificare, sdoppiando il flusso video gia ' +
              'aperto: il telefono non viene mai contattato una seconda volta.',
          }),
        ),
        el('div', { class: 'fila' }, tuttoOn, tuttoOff, apri, rileggi),
      ),
      this.spazio,
      el(
        'div',
        { class: 'scheda' },
        el('h3', { testo: 'Impostazioni' }),
        el(
          'div',
          { class: 'griglia-campi' },
          el('label', { class: 'campo' }, 'Cartella', this.cartella),
          el('label', { class: 'campo' }, 'Minuti per file', this.segmento),
          el('label', { class: 'campo' }, 'Avviso sotto (GB)', this.avviso),
          el('label', { class: 'campo' }, 'Blocco sotto (GB)', this.blocco),
          el(
            'label',
            {
              class: 'campo interruttore',
              title:
                'Apre /audio sul telefono: e una connessione in piu, e vale solo per le ' +
                'registrazioni che cominciano da adesso.',
            },
            this.conAudio,
            "Registra anche l'audio del telefono",
          ),
        ),
        el('p', {
          class: 'nota',
          testo:
            'I file si suddividono da soli: un crash costa al massimo un segmento. Se un telefono ' +
            'perde il Wi-Fi il file si chiude bene e resta leggibile, e la registrazione riprende ' +
            "da sola su un file nuovo quando torna. Il video non viene mai ricodificato; l'audio " +
            'si, in AAC, e se il telefono smette di mandarlo la traccia prosegue in silenzio ' +
            'invece di fermare la ripresa.',
        }),
      ),
      el('div', { class: 'intestazione' }, el('h2', { testo: 'File' }), this.riepilogo),
      el(
        'table',
        { class: 'elenco' },
        el(
          'thead',
          {},
          el('tr', {}, el('th', { testo: 'File' }), el('th', { testo: 'Quando' }), el('th', { testo: 'Dimensione' })),
        ),
        this.corpo,
      ),
      this.vuoto,
    )

    this.elenco = new Elenco(
      this.corpo,
      (f) => f.nome,
      () => this.riga(),
    )
  }

  aggiorna(stato: Stato): void {
    this.ultimo = stato
    const r = stato.impostazioni.registrazione
    valore(this.cartella, r.cartella)
    valore(this.segmento, String(r.minutiSegmento))
    valore(this.avviso, String(r.avvisoSpazioGb))
    valore(this.blocco, String(r.bloccoSpazioGb))
    this.conAudio.checked = r.conAudio

    const s = stato.registrazione
    this.spazio.className = s.bloccata
      ? 'avviso grave'
      : s.sottoAvviso
        ? 'avviso'
        : 'avviso info'
    testo(
      this.spazio,
      `${s.attive} registrazioni in corso · ${s.spazioLiberoGb.toFixed(1)} GB liberi` +
        (s.bloccata
          ? ' — la registrazione e bloccata.'
          : s.sottoAvviso
            ? ' — sotto la soglia di avviso.'
            : '.'),
    )
  }

  entra(): void {
    void this.leggiElenco()
    // Mentre si guarda questa schermata l'elenco si rinfresca da solo: durante
    // l'Evento un file nuovo compare ogni dieci minuti, e vederlo comparire
    // e la prova che la registrazione sta davvero scrivendo.
    this.aggiornamento = window.setInterval(() => void this.leggiElenco(), 15_000)
  }

  esci(): void {
    window.clearInterval(this.aggiornamento)
    this.aggiornamento = undefined
  }

  // -------------------------------------------------------------- interni

  private async leggiElenco(): Promise<void> {
    try {
      const risposta = await fetch('/api/registrazioni')
      const file = (await risposta.json()) as FileRegistrato[]
      this.elenco.sincronizza(file)
      this.vuoto.hidden = file.length > 0
      const totale = file.reduce((somma, f) => somma + f.byte, 0)
      testo(this.riepilogo, `${file.length} file · ${byte(totale)}`)
    } catch (e) {
      this.ctx.avvisa(`Non riesco a leggere l'elenco: ${(e as Error).message}`)
    }
    void this.ultimo
  }

  private riga(): Voce<FileRegistrato> {
    const nome = el('td', {})
    const quando = el('td', {})
    const dimensione = el('td', {})
    return {
      elemento: el('tr', {}, nome, quando, dimensione),
      aggiorna: (f) => {
        testo(nome, f.nome)
        testo(quando, quandoCompleto(f.quando))
        testo(dimensione, byte(f.byte))
      },
    }
  }
}
