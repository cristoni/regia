/**
 * Produzione: la schermata dell'Evento.
 *
 * Tutto cio che serve mentre i visitatori sono dentro sta qui, e niente di cio
 * che sta qui apre una finestra bloccante (§5.2). Sopra le anteprime video,
 * sotto un riquadro per Zona con i pulsanti dei Suoni, il volume e lo STOP.
 *
 * La striscia in mezzo e la selezione delle Zone, e serve a due cose che il
 * §3.5 chiede insieme: il "botto finale" a casa intera, e i tasti rapidi.
 * Perche esista una selezione esplicita invece di un "suona ovunque": un tasto
 * premuto per sbaglio che fa urlare tutte le stanze insieme e il tipo di errore
 * che si nota solo dopo. Con la selezione, cosa succedera e scritto sullo
 * schermo prima di premere.
 */
import type { Stato, SuonoVivo, ZonaViva } from '../../engine/api/protocollo'
import { Elenco, attributo, classe, el, testo, valore, type Voce } from '../nucleo/dom'
import type { Contesto, Schermata } from '../nucleo/schermata'
import { effettiDellaZona, inCorso, passoDelFlusso, scorciatoie } from '../nucleo/viste'
import { GrigliaVideo } from '../video/griglia'

/**
 * L'altezza delle anteprime video, in vh dell'altezza della finestra.
 *
 * Il 40vh del CSS e un punto di partenza, non la misura giusta per ogni
 * serata: con una Telecamera sola merita piu schermo lei, con dodici Zone
 * servono i riquadri. La maniglia sposta il confine, e i limiti esistono
 * perche nessuna delle due sezioni deve poter sparire del tutto.
 */
const ALTEZZA_VIDEO = { minima: 15, massima: 75, predefinita: 40 }
const CHIAVE_ALTEZZA_VIDEO = 'regia.produzione.altezza-video-vh'

function limita(vh: number): number {
  return Math.min(ALTEZZA_VIDEO.massima, Math.max(ALTEZZA_VIDEO.minima, vh))
}

function altezzaVideoSalvata(): number {
  // localStorage puo mancare o rifiutarsi (navigazione privata sul tablet,
  // dati di sito bloccati): senza memoria si parte dal predefinito, non si cade.
  try {
    const grezzo = localStorage.getItem(CHIAVE_ALTEZZA_VIDEO)
    if (grezzo !== null) {
      const vh = Number(grezzo)
      if (Number.isFinite(vh)) return limita(vh)
    }
  } catch {
    /* niente memoria: va bene lo stesso */
  }
  return ALTEZZA_VIDEO.predefinita
}

export class Produzione implements Schermata {
  readonly elemento = el('section', { class: 'produzione' })
  private readonly griglia: GrigliaVideo
  private readonly maniglia: HTMLElement
  private readonly strisciaZone = el('div', { class: 'fila' })
  private readonly comune = el('div', { class: 'effetti' })
  private readonly rigaComune: HTMLElement
  private readonly zoneGriglia = el('div', { class: 'zone-griglia' })
  private readonly elencoZone: Elenco<ZonaViva>
  private readonly elencoComune: Elenco<SuonoVivo>
  private readonly gettoni: Elenco<ZonaViva>
  private readonly vuoto = el('div', {
    class: 'vuoto',
    testo: 'Nessuna Zona. Creane una nella schermata Zone, o dal Setup guidato.',
  })

  /** Le Zone su cui agiscono i tasti rapidi e la libreria comune. */
  private selezionate = new Set<string>()
  private esclusivo = false
  private ultimo: Stato | null = null
  private altezzaVideo = altezzaVideoSalvata()

  constructor(private readonly ctx: Contesto) {
    this.griglia = new GrigliaVideo(
      (t) => ctx.avvisa(t),
      (c) => ctx.manda(c),
    )
    this.maniglia = this.creaManiglia()

    const esclusivo = el('input', { type: 'checkbox' }) as HTMLInputElement
    esclusivo.addEventListener('change', () => (this.esclusivo = esclusivo.checked))

    this.rigaComune = el(
      'div',
      { class: 'striscia' },
      el('span', { class: 'etichetta', testo: 'Suona nelle selezionate' }),
      this.comune,
    )

    const tutte = el('button', { class: 'gettone', type: 'button', testo: 'Tutte' })
    tutte.addEventListener('click', () => {
      this.selezionate = new Set((this.ultimo?.zone ?? []).map((z) => z.id))
      this.rinfresca()
    })
    const nessuna = el('button', { class: 'gettone', type: 'button', testo: 'Nessuna' })
    nessuna.addEventListener('click', () => {
      this.selezionate.clear()
      this.rinfresca()
    })

    this.elemento.append(
      this.griglia.elemento,
      this.maniglia,
      el(
        'div',
        { class: 'striscia' },
        el('span', { class: 'etichetta', testo: 'Zone selezionate' }),
        this.strisciaZone,
        tutte,
        nessuna,
        el(
          'label',
          { class: 'interruttore', title: 'Interrompe gli Effetti in corso invece di sovrapporsi' },
          esclusivo,
          'esclusivo',
        ),
      ),
      this.rigaComune,
      this.vuoto,
      this.zoneGriglia,
    )

    this.gettoni = new Elenco(this.strisciaZone, (z) => z.id, (z) => this.creaGettone(z))
    this.elencoZone = new Elenco(this.zoneGriglia, (z) => z.id, (z) => this.creaZona(z))
    this.elencoComune = new Elenco(this.comune, (s) => s.id, (s) => this.creaComune(s))

    this.applicaAltezzaVideo()
    document.addEventListener('keydown', (e) => this.tasto(e))
  }

  aggiorna(stato: Stato): void {
    this.ultimo = stato
    // Una Zona eliminata non deve restare selezionata: il "botto finale"
    // manderebbe un comando verso una Zona che non c'e piu.
    const esistenti = new Set(stato.zone.map((z) => z.id))
    for (const id of [...this.selezionate]) if (!esistenti.has(id)) this.selezionate.delete(id)

    this.griglia.aggiorna(stato)
    this.griglia.elemento.hidden = stato.telecamere.length === 0
    // Senza anteprime non c'e niente da ridimensionare: la maniglia segue.
    this.maniglia.hidden = stato.telecamere.length === 0
    this.vuoto.hidden = stato.zone.length > 0
    this.gettoni.sincronizza(stato.zone)
    this.elencoZone.sincronizza(stato.zone)
    this.rigaComune.hidden = this.selezionate.size === 0
    this.elencoComune.sincronizza(this.selezionate.size === 0 ? [] : stato.suoni)
  }

  telecamere(): string[] {
    return this.griglia.telecamere()
  }

  fotogramma(id: string, chiave: boolean, dati: Uint8Array): void {
    this.griglia.fotogramma(id, chiave, dati)
  }

  // -------------------------------------------------------------- interni

  private rinfresca(): void {
    if (this.ultimo) this.aggiorna(this.ultimo)
  }

  /**
   * La maniglia fra anteprime e Zone: trascinandola si sposta il confine.
   *
   * Pointer Events con cattura, non mousedown/mousemove sul documento: la
   * cattura tiene il trascinamento anche quando il puntatore esce
   * dall'elemento, e funziona uguale con il dito sul tablet della Fase 3.
   */
  private creaManiglia(): HTMLElement {
    const m = el('div', {
      class: 'maniglia-video',
      role: 'separator',
      'aria-orientation': 'horizontal',
      'aria-label': 'Confine fra anteprime video e Zone',
      'aria-valuemin': String(ALTEZZA_VIDEO.minima),
      'aria-valuemax': String(ALTEZZA_VIDEO.massima),
      tabindex: '0',
      title:
        'Trascina per dividere lo spazio fra anteprime e Zone. ' +
        'Doppio clic per tornare alla misura di partenza.',
    })

    // Il trascinamento vive di questo stato, non della cattura: la cattura e
    // un rinforzo (tiene i `pointermove` anche fuori dall'elemento), ma se
    // fallisce -- un puntatore gia sparito, o sintetico nei collaudi -- il
    // confine deve muoversi lo stesso.
    let puntatore: number | null = null
    let partenzaY = 0
    let partenzaAltezza = ALTEZZA_VIDEO.predefinita

    m.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      // Senza, il trascinamento seleziona il testo di mezza schermata.
      e.preventDefault()
      puntatore = e.pointerId
      partenzaY = e.clientY
      partenzaAltezza = this.altezzaVideo
      classe(m, 'presa', true)
      try {
        m.setPointerCapture(e.pointerId)
      } catch {
        /* niente cattura: il trascinamento regge finche il puntatore resta qui */
      }
    })
    m.addEventListener('pointermove', (e) => {
      if (e.pointerId !== puntatore) return
      const delta = ((e.clientY - partenzaY) / window.innerHeight) * 100
      this.altezzaVideo = limita(partenzaAltezza + delta)
      this.applicaAltezzaVideo()
    })
    const fine = (e: PointerEvent): void => {
      if (e.pointerId !== puntatore) return
      puntatore = null
      classe(m, 'presa', false)
      if (m.hasPointerCapture(e.pointerId)) m.releasePointerCapture(e.pointerId)
      this.salvaAltezzaVideo()
    }
    m.addEventListener('pointerup', fine)
    m.addEventListener('pointercancel', fine)

    m.addEventListener('dblclick', () => {
      this.altezzaVideo = ALTEZZA_VIDEO.predefinita
      this.applicaAltezzaVideo()
      this.salvaAltezzaVideo()
    })

    // E un `separator` col fuoco: da tastiera deve valere quanto il mouse.
    // Enter riporta al predefinito (il doppio clic della tastiera: col passo
    // di 2 dai limiti dispari il 40 non si raggiunge mai a frecce), Home ed
    // End vanno ai limiti, come nel pattern del window splitter.
    m.addEventListener('keydown', (e) => {
      const nuova =
        e.key === 'ArrowUp'
          ? limita(this.altezzaVideo - 2)
          : e.key === 'ArrowDown'
            ? limita(this.altezzaVideo + 2)
            : e.key === 'Home'
              ? ALTEZZA_VIDEO.minima
              : e.key === 'End'
                ? ALTEZZA_VIDEO.massima
                : e.key === 'Enter'
                  ? ALTEZZA_VIDEO.predefinita
                  : null
      if (nuova === null) return
      e.preventDefault()
      // Ferma anche la risalita: i tasti rapidi ascoltano sul documento e una
      // freccia puo essere la scorciatoia di un Suono -- ridimensionare non
      // deve far suonare niente. Gli altri tasti (Escape compreso) passano.
      e.stopPropagation()
      this.altezzaVideo = nuova
      this.applicaAltezzaVideo()
      this.salvaAltezzaVideo()
    })

    return m
  }

  private applicaAltezzaVideo(): void {
    this.elemento.style.setProperty('--altezza-video', `${this.altezzaVideo}vh`)
    attributo(this.maniglia, 'aria-valuenow', String(Math.round(this.altezzaVideo)))
  }

  private salvaAltezzaVideo(): void {
    try {
      localStorage.setItem(CHIAVE_ALTEZZA_VIDEO, String(Math.round(this.altezzaVideo)))
    } catch {
      /* senza memoria la scelta vale solo per stasera */
    }
  }

  private creaGettone(iniziale: ZonaViva): Voce<ZonaViva> {
    const b = el('button', { class: 'gettone', type: 'button' })
    b.addEventListener('click', () => {
      if (this.selezionate.has(iniziale.id)) this.selezionate.delete(iniziale.id)
      else this.selezionate.add(iniziale.id)
      this.rinfresca()
    })
    return {
      elemento: b,
      aggiorna: (z) => {
        testo(b, z.nome)
        attributo(b, 'aria-pressed', this.selezionate.has(z.id) ? 'true' : 'false')
      },
    }
  }

  /** Un pulsante della libreria comune: suona nelle Zone selezionate. */
  private creaComune(iniziale: SuonoVivo): Voce<SuonoVivo> {
    const b = el('button', { class: 'effetto', type: 'button' })
    b.addEventListener('click', () => this.suona(iniziale.id))
    return {
      elemento: b,
      aggiorna: (s) => {
        testo(b, s.nome)
        b.style.setProperty('--colore-suono', s.colore)
        b.disabled = !s.pronto
        attributo(b, 'title', s.pronto ? s.nome : `${s.nome} — non ancora pronto`)
      },
    }
  }

  private creaZona(iniziale: ZonaViva): Voce<ZonaViva> {
    const nome = el('span', { class: 'nome' })
    const conteggi = el('span', { class: 'conteggi' })
    const sottofondo = el('div', { class: 'sottofondo' })
    const effetti = el('div', { class: 'effetti' })
    const cursore = el('input', {
      type: 'range', min: '0', max: '200', step: '1',
      title: 'Volume della Zona',
    }) as HTMLInputElement
    const percento = el('span', { class: 'conteggi' })
    const stop = el('button', { class: 'stop', type: 'button', testo: 'STOP' })

    const scheda = el(
      'div',
      { class: 'zona' },
      el('header', {}, nome, conteggi),
      sottofondo,
      effetti,
      el('div', { class: 'comandi-zona' }, cursore, percento, stop),
    )

    cursore.addEventListener('input', () => {
      const v = Number(cursore.value) / 100
      testo(percento, `${cursore.value}%`)
      this.ctx.manda({ tipo: 'zona.volume', zonaId: iniziale.id, volume: v })
    })
    stop.addEventListener('click', () =>
      this.ctx.manda({ tipo: 'zona.stop', zonaId: iniziale.id }),
    )

    const elencoEffetti = new Elenco<SuonoVivo>(
      effetti,
      (s) => s.id,
      (s) => this.creaEffetto(iniziale.id, s),
    )
    const vuoti = el('div', { class: 'sottofondo assente', testo: 'Nessun Effetto abilitato' })

    return {
      elemento: scheda,
      aggiorna: (z) => {
        const stato = this.ultimo
        scheda.style.setProperty('--colore-zona', z.colore)
        classe(scheda, 'selezionata', this.selezionate.has(z.id))
        testo(nome, z.nome)
        // Lo stato dello scrittore compare solo quando **non** e attivo: in
        // condizioni normali e rumore, e quando non lo e vuol dire che da questa
        // Zona non esce audio, che e la cosa piu importante nella scheda.
        const passo = passoDelFlusso(z)
        testo(
          conteggi,
          `${z.altoparlantiCollegati}/${z.altoparlantiTotali} audio · ` +
            `${z.telecamereCollegate}/${z.telecamereTotali} video` +
            (z.scrittore === 'attivo' ? '' : `  ·  Flusso ${z.scrittore}`) +
            // Il passo compare solo quando non tiene: un "100%" sempre acceso
            // sarebbe rumore identico a quello che aveva "0 ms persi".
            (passo === null ? '' : `  ·  Flusso al ${passo}%`),
        )
        classe(scheda, 'muta', z.scrittore !== 'attivo')

        const suonoSottofondo = stato?.suoni.find((s) => s.id === z.sottofondoId)
        testo(
          sottofondo,
          suonoSottofondo ? `Sottofondo: ${suonoSottofondo.nome}` : 'Nessun Sottofondo',
        )
        classe(sottofondo, 'assente', !suonoSottofondo)

        valore(cursore, String(Math.round(z.volume * 100)))
        testo(percento, `${Math.round(z.volume * 100)}%`)

        const ammessi = stato ? effettiDellaZona(stato, z) : []
        elencoEffetti.sincronizza(ammessi)
        if (ammessi.length === 0 && !effetti.contains(vuoti)) effetti.append(vuoti)
        else if (ammessi.length > 0) vuoti.remove()
      },
    }
  }

  private creaEffetto(zonaId: string, iniziale: SuonoVivo): Voce<SuonoVivo> {
    const etichetta = el('span', {})
    const tasto = el('span', { class: 'tasto' })
    const b = el('button', { class: 'effetto', type: 'button' }, etichetta, tasto)

    // Nessuna conferma: e un'azione di riproduzione (§5.2). Il feedback e il
    // pulsante che si illumina, non una finestra.
    b.addEventListener('click', () =>
      this.ctx.manda({
        tipo: 'zona.suona',
        zone: [zonaId],
        suonoId: iniziale.id,
        esclusivo: this.esclusivo,
      }),
    )

    return {
      elemento: b,
      aggiorna: (s) => {
        testo(etichetta, s.nome)
        testo(tasto, s.tastoRapido ?? '')
        b.style.setProperty('--colore-suono', s.colore)
        b.disabled = !s.pronto
        const zona = this.ultimo?.zone.find((z) => z.id === zonaId)
        classe(b, 'acceso', zona ? inCorso(zona, s.id) : false)
      },
    }
  }

  /** Suona nelle Zone selezionate. E il "botto finale" del §3.5. */
  private suona(suonoId: string): void {
    if (this.selezionate.size === 0) {
      this.ctx.avvisa('Seleziona almeno una Zona.')
      return
    }
    this.ctx.manda({
      tipo: 'zona.suona',
      zone: [...this.selezionate],
      suonoId,
      esclusivo: this.esclusivo,
    })
  }

  /**
   * I tasti rapidi (§5.2). Valgono da qualunque schermata: durante l'Evento
   * l'Operatore puo essere finito nelle Impostazioni, e il tasto deve
   * funzionare lo stesso.
   */
  private tasto(e: KeyboardEvent): void {
    const dove = e.target as HTMLElement | null
    if (dove && /^(INPUT|SELECT|TEXTAREA)$/.test(dove.tagName)) return
    if (e.ctrlKey || e.altKey || e.metaKey) return

    if (e.key === 'Escape') {
      e.preventDefault()
      this.ctx.manda({ tipo: 'stopTutto' })
      return
    }
    const stato = this.ultimo
    if (!stato) return

    const suonoId = scorciatoie(stato).perTasto.get(e.key.toUpperCase())
    if (!suonoId) return
    e.preventDefault()
    this.suona(suonoId)
  }
}
