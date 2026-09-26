/**
 * Dispositivi: le due liste, audio e video (§5.1.2).
 *
 * E la schermata del pomeriggio. Qui si abbinano i telefoni alle stanze, e
 * l'unico modo che funziona davvero e **Identifica**: si preme il pulsante, si
 * sente un suono o si vede un lampo di torcia, e si sa quale telefono e. Il
 * §8.2 ci mette dentro un criterio di accettazione -- tre Zone e sei telefoni
 * in meno di cinque minuti -- e quel criterio si vince o si perde qui.
 *
 * Per questo Identifica sta sulla riga, accanto al menu della Zona: la mano che
 * identifica e la stessa che assegna, e non deve muoversi in mezzo.
 */
import type { AltoparlanteVivo, Stato, TelecameraViva } from '../../engine/api/protocollo'
import { Elenco, attributo, classe, el, pulsanteConferma, testo, valore, type Voce } from '../nucleo/dom'
import { campoTesto, cursoreVolume, luce, menuZone } from '../nucleo/comuni'
import type { Contesto, Schermata } from '../nucleo/schermata'
import { daQuando, descriviGeometria, ora, ruotataDaPoco } from '../nucleo/viste'

export class Dispositivi implements Schermata {
  readonly elemento = el('section', {})
  private readonly corpoAudio = el('tbody', {})
  private readonly corpoVideo = el('tbody', {})
  private readonly elencoAudio: Elenco<AltoparlanteVivo>
  private readonly elencoVideo: Elenco<TelecameraViva>
  private readonly vuotoAudio = el('div', { class: 'vuoto' })
  private readonly vuotoVideo = el('div', { class: 'vuoto' })
  private readonly tabellaAudio: HTMLElement
  private readonly tabellaVideo: HTMLElement
  private readonly scansione: HTMLButtonElement
  /**
   * La nota sotto il campo della password, che dice due cose diverse sui due
   * sistemi (e quindi si scrive in `aggiorna`, non nel costruttore).
   *
   * Non e pignoleria: e l'unica riga che l'Operatore legge **mentre** scrive
   * una password. Su Windows promette che finisce cifrata; fuori da Windows
   * quella promessa sarebbe falsa -- DPAPI non c'e e non ha equivalenti, quindi
   * la password non viene salvata affatto -- e una promessa di sicurezza falsa
   * detta nel punto in cui conta e peggio del silenzio.
   */
  private readonly notaPassword = el('p', { class: 'nota' })
  private ultimo: Stato | null = null

  constructor(private readonly ctx: Contesto) {
    this.tabellaAudio = el(
      'table',
      { class: 'elenco' },
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          el('th', { testo: 'Altoparlante' }),
          el('th', { testo: 'Zona' }),
          el('th', { testo: 'Volume' }),
          el('th', { testo: 'Latenza' }),
          el('th', { testo: 'Indirizzo' }),
          el('th', {}),
        ),
      ),
      this.corpoAudio,
    )

    this.tabellaVideo = el(
      'table',
      { class: 'elenco' },
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          el('th', { testo: 'Telecamera' }),
          el('th', { testo: 'Zona' }),
          el('th', { testo: 'Indirizzo' }),
          el('th', { testo: 'Batteria' }),
          el('th', { testo: 'Wi-Fi' }),
          el('th', { testo: 'Fotogramma' }),
          el('th', {}),
        ),
      ),
      this.corpoVideo,
    )

    this.scansione = el('button', {
      class: 'pulsante',
      type: 'button',
      testo: 'Cerca Telecamere sulla rete',
    })
    this.scansione.addEventListener('click', () => void this.cerca())

    this.elemento.append(
      el('h1', { testo: 'Dispositivi' }),
      el('p', {
        class: 'sottotitolo',
        testo:
          'I telefoni compaiono da soli quando si collegano. Usa Identifica per capire quale sta ' +
          'in quale stanza: un suono breve sugli Altoparlanti, un lampo di torcia sulle Telecamere.',
      }),
      el('h2', { testo: 'Altoparlanti' }),
      this.tabellaAudio,
      this.vuotoAudio,
      el(
        'div',
        { class: 'intestazione' },
        el('h2', { testo: 'Telecamere' }),
        el('div', { class: 'fila' }, this.scansione),
      ),
      this.tabellaVideo,
      this.vuotoVideo,
      this.formaAggiunta(),
    )

    this.elencoAudio = new Elenco(this.corpoAudio, (a) => a.id, (a) => this.rigaAudio(a))
    this.elencoVideo = new Elenco(this.corpoVideo, (t) => t.id, (t) => this.rigaVideo(t))
  }

  aggiorna(stato: Stato): void {
    this.ultimo = stato
    this.elencoAudio.sincronizza(stato.altoparlanti)
    this.elencoVideo.sincronizza(stato.telecamere)

    const senzaAudio = stato.altoparlanti.length === 0
    this.tabellaAudio.hidden = senzaAudio
    this.vuotoAudio.hidden = !senzaAudio
    testo(
      this.vuotoAudio,
      stato.server === 'acceso'
        ? 'Nessun Altoparlante collegato. Apri Snapdroid sui telefoni e inserisci l\'indirizzo del PC.'
        : 'Il server audio non e acceso: nessun telefono puo collegarsi. Vai al Setup guidato.',
    )

    const senzaVideo = stato.telecamere.length === 0
    this.tabellaVideo.hidden = senzaVideo
    this.vuotoVideo.hidden = !senzaVideo
    testo(
      this.vuotoVideo,
      'Nessuna Telecamera. Cercale sulla rete, o aggiungine una scrivendo il suo indirizzo.',
    )

    // Il discrimine e Windows, non Linux: DPAPI e di Windows, quindi ovunque
    // altro -- Linux, macOS, qualunque cosa arrivi come 'altro' -- vale la
    // seconda frase. E per la stessa ragione il mDNS: avahi non compilato e un
    // fatto di Windows (ADR 0002); altrove ci sarebbe, e resta spento perche lo
    // abbiamo deciso noi.
    const suWindows = stato.ambiente.piattaforma === 'windows'
    testo(
      this.notaPassword,
      (suWindows
        ? 'La password viene cifrata con DPAPI e non esce mai dal PC: non finisce nemmeno nel ' +
          'file esportato. '
        : 'La password non viene salvata: DPAPI e di Windows e non ha un equivalente qui, quindi ' +
          'resta solo in memoria e la Telecamera funziona finche Regia resta aperta. Al prossimo ' +
          'avvio va riscritta. ') +
        // Sul rilevamento automatico non c'e niente da distinguere fra i due
        // sistemi, e la ragione non e quella del server audio: `mdns_enabled =
        // false` riguarda snapserver, mentre una Telecamera andrebbe cercata
        // con un'altra pubblicazione ancora, che nel motore non c'e. Scriverlo
        // come una conseguenza di avahi -- vero solo su Windows -- faceva
        // credere che altrove esistesse un interruttore da accendere.
        'Non c\'e nessun rilevamento automatico delle Telecamere, su nessun sistema: ' +
        'l\'indirizzo scritto a mano o la scansione della sottorete sono le uniche due strade.',
    )
  }

  // -------------------------------------------------------------- interni

  private async cerca(): Promise<void> {
    this.scansione.disabled = true
    testo(this.scansione, 'Sto cercando…')
    try {
      await this.ctx.attendi({ tipo: 'telecamera.scansiona', sottorete: null })
    } catch (e) {
      this.ctx.avvisa((e as Error).message)
    } finally {
      this.scansione.disabled = false
      testo(this.scansione, 'Cerca Telecamere sulla rete')
    }
  }

  private rigaAudio(iniziale: AltoparlanteVivo): Voce<AltoparlanteVivo> {
    const spia = luce()
    const nome = campoTesto(
      (v) => this.ctx.manda({ tipo: 'altoparlante.rinomina', clientId: iniziale.id, nome: v }),
      { title: 'Il nome viene scritto anche sul server, cosi si vede da Snapdroid' },
    )
    const zona = menuZone((zonaId) =>
      this.ctx.manda({ tipo: 'altoparlante.assegna', clientId: iniziale.id, zonaId }),
    )
    const volume = cursoreVolume(
      (v) => this.ctx.manda({ tipo: 'altoparlante.volume', clientId: iniziale.id, volume: v }),
      'Volume di questo Altoparlante',
    )
    const muto = el('input', { type: 'checkbox', title: 'Muto' }) as HTMLInputElement
    muto.addEventListener('change', () =>
      this.ctx.manda({ tipo: 'altoparlante.muto', clientId: iniziale.id, muto: muto.checked }),
    )
    const latenza = el('input', {
      type: 'number', step: '10', min: '-10000', max: '10000',
      title: 'Correzione di latenza, per casse piu lente delle altre',
    }) as HTMLInputElement
    latenza.style.width = '86px'
    latenza.addEventListener('change', () =>
      this.ctx.manda({
        tipo: 'altoparlante.latenza',
        clientId: iniziale.id,
        latenzaMs: Math.round(Number(latenza.value) || 0),
      }),
    )

    const indirizzo = el('span', { class: 'conteggi' })
    const identifica = el('button', {
      class: 'pulsante piccolo',
      type: 'button',
      testo: 'Identifica',
      title: 'Fa suonare un segnale breve solo su questo Altoparlante',
    })
    identifica.addEventListener('click', () =>
      this.ctx.manda({ tipo: 'altoparlante.identifica', clientId: iniziale.id }),
    )
    const dimentica = pulsanteConferma(
      'Dimentica',
      'Confermi?',
      () => this.ctx.manda({ tipo: 'altoparlante.dimentica', clientId: iniziale.id }),
      'pulsante piccolo pericolo',
    )

    const riga = el(
      'tr',
      {},
      el('td', {}, spia.elemento, nome),
      el('td', {}, zona.elemento),
      el('td', {}, el('div', { class: 'fila' }, volume.elemento, muto)),
      el('td', {}, latenza),
      el('td', {}, indirizzo),
      el('td', { class: 'comandi' }, identifica, ' ', dimentica),
    )

    return {
      elemento: riga,
      aggiorna: (a) => {
        spia.aggiorna(a.collegato)
        valore(nome, a.nome)
        if (this.ultimo) zona.aggiorna(this.ultimo, a.zonaId)
        volume.aggiorna(a.volume)
        if (document.activeElement !== muto) muto.checked = a.muto
        valore(latenza, String(a.latenzaMs))
        // Passando dal ponte di rete, snapserver vede tutti i client
        // all'indirizzo del ponte: mostrare `127.0.0.1` come se fosse l'IP del
        // telefono sarebbe un'informazione falsa, e si dice invece cos'e.
        testo(
          indirizzo,
          a.indirizzo === null
            ? '—'
            : a.indirizzo === '127.0.0.1'
              ? 'via ponte'
              : a.indirizzo,
        )
        classe(riga, 'assente', !a.collegato)
        attributo(identifica, 'aria-busy', a.inIdentificazione ? 'true' : 'false')
        identifica.disabled = a.inIdentificazione || !a.collegato
        testo(identifica, a.inIdentificazione ? 'Sta suonando…' : 'Identifica')
        attributo(riga, 'title', a.collegato ? '' : `visto l'ultima volta ${daQuando(a.vistoIl)}`)
      },
    }
  }

  private rigaVideo(iniziale: TelecameraViva): Voce<TelecameraViva> {
    const spia = luce()
    const nome = campoTesto((v) =>
      this.ctx.manda({ tipo: 'telecamera.rinomina', telecameraId: iniziale.id, nome: v }),
    )
    const zona = menuZone((zonaId) =>
      this.ctx.manda({ tipo: 'telecamera.assegna', telecameraId: iniziale.id, zonaId }),
    )
    const indirizzo = el('span', { class: 'conteggi' })
    const batteria = el('span', { class: 'conteggi' })
    const segnale = el('span', { class: 'conteggi' })
    // La geometria del fotogramma che arriva, letta dal video stesso
    // (ADR 0013). Resta vuota finche nessuno ha guardato questa Telecamera --
    // il flusso si apre solo se qualcuno lo guarda.
    const orientamento = el('span', { class: 'conteggi' })
    // Il giro dell'inquadratura (ADR 0014). Sta anche qui, oltre che sulla
    // cella, perche questa e la schermata del pomeriggio: si monta un telefono
    // di traverso e lo si dichiara subito, senza cercare la sua cella.
    const gira = el('button', { class: 'pulsante piccolo', type: 'button', testo: '0°' })
    let rotazione: 0 | 90 | 180 | 270 = 0
    gira.addEventListener('click', () =>
      this.ctx.manda({
        tipo: 'telecamera.rotazione',
        telecameraId: iniziale.id,
        gradi: (((rotazione + 90) % 360) as 0 | 90 | 180 | 270),
      }),
    )

    const identifica = el('button', {
      class: 'pulsante piccolo',
      type: 'button',
      testo: 'Identifica',
      title: 'Accende la torcia per due secondi',
    })
    identifica.addEventListener('click', () =>
      this.ctx.manda({ tipo: 'telecamera.identifica', telecameraId: iniziale.id }),
    )
    const rec = el('button', { class: 'pulsante piccolo', type: 'button', testo: 'REC' })
    rec.addEventListener('click', () => {
      const attiva = this.ultimo?.telecamere.find((t) => t.id === iniziale.id)?.inRegistrazione
      this.ctx.manda({
        tipo: attiva ? 'registrazione.ferma' : 'registrazione.avvia',
        ambito: { su: 'telecamera', telecameraId: iniziale.id },
      })
    })
    const rimuovi = pulsanteConferma(
      'Rimuovi',
      'Confermi?',
      () => this.ctx.manda({ tipo: 'telecamera.rimuovi', telecameraId: iniziale.id }),
      'pulsante piccolo pericolo',
    )

    const riga = el(
      'tr',
      {},
      el('td', {}, spia.elemento, nome),
      el('td', {}, zona.elemento),
      el('td', {}, indirizzo),
      el('td', {}, batteria),
      el('td', {}, segnale),
      el('td', {}, el('div', { class: 'fila' }, orientamento, gira)),
      el('td', { class: 'comandi' }, identifica, ' ', rec, ' ', rimuovi),
    )

    return {
      elemento: riga,
      aggiorna: (t) => {
        spia.aggiorna(t.raggiungibile)
        valore(nome, t.nome)
        if (this.ultimo) zona.aggiorna(this.ultimo, t.zonaId)
        testo(indirizzo, `${t.https ? 'https' : 'http'}://${t.host}:${t.porta}`)
        testo(batteria, t.batteria === null ? '—' : `${t.batteria}%`)
        testo(segnale, t.segnale === null ? '—' : `${t.segnale}%`)
        testo(orientamento, descriviGeometria(t) ?? '—')
        rotazione = t.rotazione
        testo(gira, `${t.rotazione}°`)
        classe(gira, 'principale', t.rotazione !== 0)
        attributo(
          gira,
          'title',
          'Gira l inquadratura di quarto in quarto, in senso orario. Non tocca il ' +
            'telefono: gira l anteprima e le registrazioni nuove.',
        )
        const daPoco = ruotataDaPoco(t)
        orientamento.style.color = daPoco ? 'var(--attenzione)' : ''
        attributo(
          orientamento,
          'title',
          t.orientamentoCambiatoIl
            ? `il video ha ruotato alle ${ora(t.orientamentoCambiatoIl)}`
            : 'il fotogramma che arriva, misurato sul video. Non dice come sta ' +
              'l immagine dentro il fotogramma: il telefono puo impaginarne una ' +
              'verticale fra due bande nere',
        )
        classe(riga, 'assente', !t.raggiungibile)

        identifica.disabled =
          !t.raggiungibile || t.inIdentificazione || t.dettagli?.haFlash === false
        testo(identifica, t.inIdentificazione ? 'Torcia accesa' : 'Identifica')
        attributo(
          identifica,
          'title',
          t.dettagli?.haFlash === false
            ? 'questo telefono non ha il flash'
            : 'Accende la torcia per due secondi',
        )
        testo(rec, t.inRegistrazione ? 'Ferma REC' : 'REC')
        classe(rec, 'pericolo', t.inRegistrazione)
        rec.disabled = !t.raggiungibile && !t.inRegistrazione
      },
    }
  }

  /** Aggiunta a mano: l'IP scritto o incollato. Resta l'unica strada certa. */
  private formaAggiunta(): HTMLElement {
    const host = el('input', { type: 'text', placeholder: '192.168.1.7' }) as HTMLInputElement
    const porta = el('input', { type: 'number', value: '4444' }) as HTMLInputElement
    const utente = el('input', { type: 'text', placeholder: 'facoltativo' }) as HTMLInputElement
    const password = el('input', { type: 'password', placeholder: 'facoltativa' }) as HTMLInputElement
    const conHttps = el('input', { type: 'checkbox' }) as HTMLInputElement
    const aggiungi = el('button', { class: 'pulsante principale', type: 'button', testo: 'Aggiungi' })

    aggiungi.addEventListener('click', () => {
      const indirizzo = host.value.trim()
      if (!indirizzo) {
        this.ctx.avvisa('Scrivi l\'indirizzo della Telecamera.')
        return
      }
      this.ctx.manda({
        tipo: 'telecamera.aggiungi',
        host: indirizzo,
        porta: Number(porta.value) || 4444,
        https: conHttps.checked,
        utente: utente.value.trim() || null,
        password: password.value || null,
      })
      host.value = ''
      password.value = ''
    })

    return el(
      'div',
      { class: 'scheda' },
      el('h3', { testo: 'Aggiungi una Telecamera a mano' }),
      el(
        'div',
        { class: 'griglia-campi' },
        el('label', { class: 'campo' }, 'Indirizzo', host),
        el('label', { class: 'campo' }, 'Porta', porta),
        el('label', { class: 'campo' }, 'Utente', utente),
        el('label', { class: 'campo' }, 'Password', password),
        el('label', { class: 'campo' }, 'HTTPS', el('div', { class: 'fila' }, conHttps, 'certificato autofirmato accettato')),
        el('label', { class: 'campo' }, ' ', aggiungi),
      ),
      this.notaPassword,
    )
  }
}
