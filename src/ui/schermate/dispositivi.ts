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
import { daQuando } from '../nucleo/viste'

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
      el('p', {
        class: 'nota',
        testo:
          'La password viene cifrata con DPAPI e non esce mai dal PC: non finisce nemmeno nel ' +
          'file esportato. Il rilevamento automatico via mDNS non e una strada praticabile — ' +
          'avahi non e compilato su Windows — quindi l\'indirizzo scritto a mano o la scansione ' +
          'sono le uniche due.',
      }),
    )
  }
}
