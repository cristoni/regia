/**
 * Impostazioni: server audio, formato, cartelle, progetto, diario (§5.1.6).
 *
 * Quasi ogni numero di questa schermata contraddice un default di snapserver, e
 * quasi ogni numero e stato scelto misurando. Per questo accanto ai campi non
 * c'e un'etichetta ma una frase: chi cambia `buffer` deve sapere che sta
 * cambiando la latenza fra il pulsante e il suono, e chi cambia
 * `idle_threshold` deve sapere che con il default i client smettevano di
 * suonare.
 *
 * La latenza attesa e mostrata grande e in cima. E `buffer + anticipo`, non
 * `buffer`: l'audio fermo nella coda della socket ritarda il proprio timestamp,
 * quindi l'anticipo di scrittura **si somma**. E il numero contro cui va letto
 * il criterio §8.3.
 */
import type { Stato } from '../../engine/api/protocollo'
import { el, testo, valore } from '../nucleo/dom'
import { ora } from '../nucleo/viste'
import { areaFile, caricaFile } from '../nucleo/comuni'
import type { Contesto, Schermata } from '../nucleo/schermata'

export class Impostazioni implements Schermata {
  readonly elemento = el('section', {})
  private readonly latenza = el('div', { class: 'avviso info' })
  private readonly banda = el('p', { class: 'nota' })
  private readonly campi = new Map<string, HTMLInputElement | HTMLSelectElement>()
  private readonly statoServer = el('span', { class: 'pastiglia spento' })
  /**
   * Il campo della distro esiste sempre e si vede solo su Windows.
   *
   * Si nasconde il controllo, non si cancella il dato: `progetto.server.distro`
   * resta scritto e il file continua ad aprirsi da tutte e due le parti. Un
   * progetto preparato in casa su Windows e portato sul PC Linux della serata
   * non deve perdere per strada il nome della distro a cui tornera domani.
   */
  private readonly campoDistro = el('label', { class: 'campo' })
  private readonly ponte = el('p', { class: 'nota' })
  /**
   * Cosa non c'e dentro il progetto esportato: dipende dal sistema, come la
   * nota gemella in Dispositivi. Su Windows le password ci sono e restano
   * fuori dal file perche sono cifrate con DPAPI; fuori da Windows non ce n'e
   * nessuna da tenere fuori, perche non ne viene salvata nessuna.
   */
  private readonly notaEsportazione = el('p', { class: 'nota' })
  private readonly righe = el('div', { class: 'diario' })
  private quanteRighe = -1

  constructor(private readonly ctx: Contesto) {
    this.elemento.append(
      el('h1', { testo: 'Impostazioni' }),
      el('p', {
        class: 'sottotitolo',
        testo:
          'Cambiare qualunque cosa in questa pagina riscrive la configurazione del server audio ' +
          'e lo riavvia. Si fa in Setup, mai durante l\'Evento.',
      }),
      this.latenza,
      this.schedaServer(),
      this.schedaAudio(),
      this.schedaProgetto(),
      this.schedaDiario(),
    )
  }

  aggiorna(stato: Stato): void {
    const a = stato.impostazioni.audio
    const s = stato.impostazioni.server

    testo(
      this.latenza,
      `Latenza attesa dal pulsante al suono: ${stato.latenzaAttesaMs} ms ` +
        `(buffer ${a.bufferMs} + anticipo ${a.anticipoMs}).`,
    )
    testo(
      this.banda,
      `Banda continua stimata: ${stato.audio.bandaMbit} Mbit/s verso ${stato.altoparlanti.length} ` +
        'Altoparlanti, anche a casa vuota. Il collo di bottiglia e la rete, non la CPU: ' +
        'serve il 5 GHz e il PC via cavo.',
    )

    // Il diario si ridisegna solo quando ci sono righe nuove: dieci volte al
    // secondo sarebbe lavoro buttato, e farebbe saltare lo scorrimento a chi
    // sta leggendo indietro.
    const quante = this.ctx.diario().length
    if (quante !== this.quanteRighe) {
      this.quanteRighe = quante
      this.disegnaDiario()
    }

    testo(this.statoServer, stato.server)
    this.statoServer.className = `pastiglia ${
      stato.server === 'acceso' ? 'info' : stato.server === 'caduto' ? 'grave' : 'spento'
    }`

    this.imposta('distro', s.distro)
    this.imposta('portaControllo', String(s.portaControllo))
    this.imposta('portaHttp', String(s.portaHttp))
    this.imposta('portaFlussoClient', String(s.portaFlussoClient))

    this.imposta('bufferMs', String(a.bufferMs))
    this.imposta('anticipoMs', String(a.anticipoMs))
    this.imposta('codec', a.codec)
    this.imposta('bloccoMs', String(a.bloccoMs))
    this.imposta('dissolvenzaMs', String(a.dissolvenzaMs))
    this.imposta('idleThresholdMs', String(a.idleThresholdMs))
    this.imposta('portaBaseFlussi', String(a.portaBaseFlussi))
    this.imposta('nomeProgetto', stato.progettoNome)

    // La Sede e una distro solo su Windows: altrove il campo non ha niente da
    // dire e sparisce. Si nasconde il controllo, non il valore -- `imposta`
    // qui sopra continua a scriverlo, e il progetto se lo porta dietro.
    const suWindows = stato.ambiente.piattaforma === 'windows'
    this.campoDistro.hidden = !suWindows

    const indirizzi = stato.ambiente.indirizzi
    testo(
      this.ponte,
      indirizzi.length === 0
        ? 'Nessun indirizzo di rete trovato.'
        : 'Nei telefoni, in Snapdroid, va scritto uno di questi indirizzi: ' +
          indirizzi.map((i) => `${i.ip} (${i.interfaccia})`).join(', ') +
          '. ' +
          (suWindows
            ? 'Snapserver ascolta dentro la distro: Regia apre da sola un ponte di rete ' +
              'quando quelle porte non escono gia sulla LAN da sole (ADR 0010).'
            : 'Snapserver gira qui e ascolta gia su 0.0.0.0: i telefoni lo raggiungono ' +
              'da soli, e nessun ponte si mette in mezzo.'),
    )

    // Fuori da Windows non c'e niente da promettere: `dpapiDisponibile()` dice
    // subito di no e la password non viene mai scritta sul disco (§6: cifrate o
    // non salvate). Dire "non e nel file esportato" sarebbe vero e fuorviante,
    // perche farebbe credere che da qualche parte sia salvata.
    testo(
      this.notaEsportazione,
      suWindows
        ? 'Il progetto esportato non contiene le password delle Telecamere: sono cifrate con ' +
            'DPAPI, legate a questo utente su questo PC, e altrove sarebbero comunque illeggibili.'
        : 'Il progetto esportato non contiene password di Telecamere perche qui non ne viene ' +
            'salvata nessuna: DPAPI e di Windows, e senza di lei la password resta in memoria ' +
            'finche Regia e aperta e poi va riscritta.',
    )
  }

  entra(): void {
    this.disegnaDiario()
  }

  // -------------------------------------------------------------- interni

  /**
   * Il diario leggibile dall'Operatore (§3.10).
   *
   * Non e il log tecnico: sono gli eventi principali, in italiano, nell'ordine
   * in cui sono successi. Serve alle undici di sera per rispondere alla
   * domanda "cos'e successo alla cucina venti minuti fa", e serve al mattino
   * dopo per capire perche una registrazione si e interrotta.
   */
  private schedaDiario(): HTMLElement {
    return el(
      'div',
      { class: 'scheda' },
      el('h3', { testo: 'Diario' }),
      this.righe,
      el('p', {
        class: 'nota',
        testo: 'Le ultime righe. "Esporta il diario" qui sopra le salva tutte su un file.',
      }),
    )
  }

  private disegnaDiario(): void {
    const righe = this.ctx.diario()
    this.righe.replaceChildren(
      ...righe
        .slice(-200)
        .map((r) =>
          el('div', { class: r.livello }, el('time', { testo: ora(r.quando) }), r.testo),
        ),
    )
    // In fondo: la riga che interessa e sempre l'ultima.
    this.righe.scrollTop = this.righe.scrollHeight
  }

  private imposta(nome: string, v: string): void {
    const c = this.campi.get(nome)
    if (c) valore(c, v)
  }

  private numero(
    nome: string,
    etichetta: string,
    nota: string,
    suCambio: (v: number) => void,
    attributi: Record<string, string> = {},
  ): HTMLElement {
    const i = el('input', { type: 'number', ...attributi }) as HTMLInputElement
    i.addEventListener('change', () => suCambio(Number(i.value)))
    this.campi.set(nome, i)
    return el(
      'label',
      { class: 'campo' },
      etichetta,
      i,
      el('span', { class: 'nota', testo: nota }),
    )
  }

  private schedaServer(): HTMLElement {
    const distro = el('input', { type: 'text' }) as HTMLInputElement
    distro.addEventListener('change', () =>
      this.ctx.manda({ tipo: 'impostazioni.server', distro: distro.value.trim() }),
    )
    this.campi.set('distro', distro)

    const avvia = el('button', { class: 'pulsante principale', type: 'button', testo: 'Avvia' })
    avvia.addEventListener('click', () => this.ctx.manda({ tipo: 'server.avvia' }))
    const ferma = el('button', { class: 'pulsante pericolo', type: 'button', testo: 'Ferma' })
    ferma.addEventListener('click', () => this.ctx.manda({ tipo: 'server.ferma' }))
    const riavvia = el('button', { class: 'pulsante', type: 'button', testo: 'Riavvia' })
    riavvia.addEventListener('click', () => this.ctx.manda({ tipo: 'server.riavvia' }))
    const ricollega = el('button', { class: 'pulsante', type: 'button', testo: 'Ricollega tutto' })
    ricollega.addEventListener('click', () => this.ctx.manda({ tipo: 'ricollegaTutto' }))

    this.campoDistro.append(
      'Distro WSL',
      distro,
      el('span', {
        class: 'nota',
        testo: 'Snapserver non gira nativo su Windows: la compilazione del server e ' +
          'esclusa a monte per WIN32, quindi la Sede e una distro.',
      }),
    )

    return el(
      'div',
      { class: 'scheda' },
      el(
        'div',
        { class: 'intestazione' },
        el('h3', {}, 'Server audio ', this.statoServer),
        el('div', { class: 'fila' }, avvia, riavvia, ferma, ricollega),
      ),
      el(
        'div',
        { class: 'griglia-campi' },
        this.campoDistro,
        this.numero('portaControllo', 'Porta di controllo', 'JSON-RPC. Snapdroid la apre per prima.', (v) =>
          this.ctx.manda({ tipo: 'impostazioni.server', portaControllo: v }),
        ),
        this.numero('portaFlussoClient', 'Porta del flusso', 'Da qui i telefoni prendono l\'audio.', (v) =>
          this.ctx.manda({ tipo: 'impostazioni.server', portaFlussoClient: v }),
        ),
        this.numero('portaHttp', 'Porta HTTP', 'Snapweb e disattivato: ogni scheda aperta ' +
          'diventerebbe un client audio in piu.', (v) =>
          this.ctx.manda({ tipo: 'impostazioni.server', portaHttp: v }),
        ),
      ),
      this.ponte,
    )
  }

  private schedaAudio(): HTMLElement {
    const codec = el('select', {}) as HTMLSelectElement
    codec.replaceChildren(
      ...(['pcm', 'opus', 'flac', 'ogg'] as const).map((c) =>
        el('option', { value: c, testo: c }),
      ),
    )
    codec.addEventListener('change', () =>
      this.ctx.manda({
        tipo: 'impostazioni.audio',
        codec: codec.value as 'pcm' | 'opus' | 'flac' | 'ogg',
      }),
    )
    this.campi.set('codec', codec)

    return el(
      'div',
      { class: 'scheda' },
      el('h3', { testo: 'Audio' }),
      el(
        'div',
        { class: 'griglia-campi' },
        this.numero(
          'bufferMs',
          'Buffer (ms)',
          'Impostazione globale di snapserver: non esiste per Zona. E la parte grossa della latenza.',
          (v) => this.ctx.manda({ tipo: 'impostazioni.audio', bufferMs: v }),
          { min: '200', max: '4000', step: '100' },
        ),
        this.numero(
          'anticipoMs',
          'Anticipo di scrittura (ms)',
          'Assorbe le pause del GC, ma si somma al buffer: e latenza, non solo robustezza. ' +
            'Tenerlo al minimo che regge.',
          (v) => this.ctx.manda({ tipo: 'impostazioni.audio', anticipoMs: v }),
          { min: '0', max: '1000', step: '50' },
        ),
        el(
          'label',
          { class: 'campo' },
          'Codec',
          codec,
          el('span', {
            class: 'nota',
            testo: 'PCM e l\'unico verificato con Snapdroid. FLAC ha fallito in silenzio.',
          }),
        ),
        this.numero(
          'bloccoMs',
          'Blocco di mix (ms)',
          '20 ms = 882 campioni a 44100 Hz.',
          (v) => this.ctx.manda({ tipo: 'impostazioni.audio', bloccoMs: v }),
          { min: '5', max: '100', step: '5' },
        ),
        this.numero(
          'dissolvenzaMs',
          'Dissolvenza Effetti (ms)',
          'In apertura e chiusura di ogni Effetto, contro i click.',
          (v) => this.ctx.manda({ tipo: 'impostazioni.audio', dissolvenzaMs: v }),
          { min: '0', max: '200', step: '5' },
        ),
        this.numero(
          'idleThresholdMs',
          'Soglia di inattivita (ms)',
          'Col default di 100 ms il controllo scatta a 120 e nasce il lampeggio idle/playing ' +
            'che faceva smettere di suonare i client. Alzarlo lo cancella, gratis.',
          (v) => this.ctx.manda({ tipo: 'impostazioni.audio', idleThresholdMs: v }),
          { min: '10', max: '10000', step: '100' },
        ),
        this.numero(
          'portaBaseFlussi',
          'Prima porta dei Flussi',
          'La Zona n-esima ascolta su base + n. Il tredicesimo Flusso e quello dei non assegnati.',
          (v) => this.ctx.manda({ tipo: 'impostazioni.audio', portaBaseFlussi: v }),
          { min: '1024', max: '65000', step: '1' },
        ),
      ),
      this.banda,
    )
  }

  private schedaProgetto(): HTMLElement {
    const nome = el('input', { type: 'text' }) as HTMLInputElement
    nome.addEventListener('change', () =>
      this.ctx.manda({ tipo: 'progetto.rinomina', nome: nome.value.trim() || 'Casa degli orrori' }),
    )
    this.campi.set('nomeProgetto', nome)

    const esporta = el('a', {
      class: 'pulsante',
      href: '/api/progetto',
      download: 'progetto-regia.json',
      testo: 'Esporta il progetto',
    })

    const diario = el('button', { class: 'pulsante', type: 'button', testo: 'Esporta il diario' })
    diario.addEventListener('click', () => {
      const righe = this.ctx
        .diario()
        .map((r) => `${r.quando}\t${r.livello}\t${r.testo}`)
        .join('\r\n')
      const url = URL.createObjectURL(new Blob([righe], { type: 'text/plain;charset=utf-8' }))
      const a = el('a', { href: url, download: 'diario-regia.txt' })
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 5000)
    })

    return el(
      'div',
      { class: 'scheda' },
      el('h3', { testo: 'Progetto' }),
      el(
        'div',
        { class: 'griglia-campi' },
        el('label', { class: 'campo' }, 'Nome dell\'evento', nome),
        el('label', { class: 'campo' }, ' ', el('div', { class: 'fila' }, esporta, diario)),
      ),
      areaFile('Trascina qui un progetto esportato per importarlo', '.json,application/json', (file) => {
        const primo = file[0]
        if (primo) void this.importaProgetto(primo)
      }),
      this.notaEsportazione,
    )
  }

  private async importaProgetto(file: File): Promise<void> {
    try {
      await caricaFile('/api/progetto', file)
      this.ctx.avvisa('Progetto importato.', true)
    } catch (e) {
      this.ctx.avvisa((e as Error).message)
    }
  }
}
