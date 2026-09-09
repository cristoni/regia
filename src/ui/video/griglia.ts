/**
 * La griglia delle anteprime video (§3.6).
 *
 * Una cella per Telecamera, raggruppate per Zona, con il nome della Zona
 * sovraimpresso e il layout che si sceglie da solo. Ingrandire una cella e un
 * clic, tornare indietro un altro.
 *
 * Il `<canvas>` di una cella **non si ricrea mai** finche quella Telecamera
 * esiste: dietro c'e un `VideoDecoder`, e ricrearlo significa aspettare il
 * prossimo fotogramma chiave -- fino a un secondo di nero, ogni volta. Per
 * questo l'aggiornamento passa da `Elenco`, che tiene le voci per chiave e
 * aggiorna in posto, e non da una ricostruzione dell'albero.
 *
 * Ingrandendo una cella si smette di chiedere le altre. Non e un'ottimizzazione
 * gratuita: la banda e il collo di bottiglia, e cinque flussi che nessuno sta
 * guardando sono cinque flussi tolti agli Altoparlanti.
 */
import type { Comando, Stato } from '../../engine/api/protocollo'
import { Elenco, attributo, classe, el, testo, type Voce } from '../nucleo/dom'
import { celleVideo, colonneGriglia, type CellaVideo } from '../nucleo/viste'
import { DecodificatoreVideo } from './decodificatore'

interface VoceCella extends Voce<CellaVideo> {
  fotogramma(chiave: boolean, dati: Uint8Array): void
}

export class GrigliaVideo {
  readonly elemento = el('div', { class: 'video-griglia' })
  private readonly elenco: Elenco<CellaVideo>
  private readonly celle = new Map<string, VoceCella>()
  private ingrandita: string | null = null
  private visibili: string[] = []

  constructor(
    private readonly suAvviso: (testo: string) => void,
    private readonly comanda: (c: Comando) => void,
  ) {
    this.elenco = new Elenco(
      this.elemento,
      (c) => c.telecamera.id,
      (c) => this.creaCella(c),
    )
  }

  aggiorna(stato: Stato): void {
    const celle = celleVideo(stato)
    // Una Telecamera ingrandita che sparisce -- rimossa, o il progetto
    // importato da capo -- non deve lasciare la griglia in uno stato in cui
    // non si vede piu niente.
    if (this.ingrandita && !celle.some((c) => c.telecamera.id === this.ingrandita)) {
      this.ingrandita = null
    }
    this.elenco.sincronizza(celle)
    this.visibili = this.ingrandita ? [this.ingrandita] : celle.map((c) => c.telecamera.id)

    const colonne = this.ingrandita ? 1 : colonneGriglia(celle.length)
    this.elemento.style.gridTemplateColumns = `repeat(${colonne}, 1fr)`
  }

  /** Le Telecamere che vale la pena chiedere al motore, adesso. */
  telecamere(): string[] {
    return this.visibili
  }

  fotogramma(telecameraId: string, chiave: boolean, dati: Uint8Array): void {
    this.celle.get(telecameraId)?.fotogramma(chiave, dati)
  }

  chiudi(): void {
    this.elenco.svuota()
    this.celle.clear()
  }

  // -------------------------------------------------------------- interni

  private creaCella(iniziale: CellaVideo): VoceCella {
    const id = iniziale.telecamera.id
    const tela = el('canvas', { width: '640', height: '360' })
    // REC sta **sulla cella**, non solo nella schermata Dispositivi: durante
    // l'Evento l'Operatore guarda la griglia, e il §3.7 vuole un REC/STOP per
    // singola Telecamera dove la Telecamera si vede.
    //
    // Acceso e un clic solo, perche perdere l'inizio di una scena e peggio che
    // registrare in piu. Spento ne vuole due -- il pulsante chiede "Fermare?"
    // e aspetta -- perche in una stanza al buio un clic di troppo sulla cella
    // sbagliata butterebbe via la ripresa in corso senza dire niente.
    const rec = el('button', { class: 'rec', type: 'button', testo: 'REC' })
    let inRegistrazione = false
    let armato = false
    let scadenzaArmo: number | undefined
    const disarma = (): void => {
      window.clearTimeout(scadenzaArmo)
      armato = false
      classe(rec, 'armato', false)
      testo(rec, 'REC')
    }
    rec.addEventListener('click', (e) => {
      // Senza questo, il clic arriva anche alla cella e la ingrandisce.
      e.stopPropagation()
      if (!inRegistrazione) {
        this.comanda({
          tipo: 'registrazione.avvia',
          ambito: { su: 'telecamera', telecameraId: id },
        })
        return
      }
      if (armato) {
        disarma()
        this.comanda({
          tipo: 'registrazione.ferma',
          ambito: { su: 'telecamera', telecameraId: id },
        })
        return
      }
      armato = true
      classe(rec, 'armato', true)
      testo(rec, 'Fermare?')
      scadenzaArmo = window.setTimeout(disarma, 4000)
    })
    const nomeZona = el('span', { class: 'zona-nome' })
    const nomeCamera = el('span', { class: 'nome' })
    const spia = el('span', { class: 'spia' })
    const assente = el('div', { class: 'assente' })
    const cella = el(
      'div',
      { class: 'cella' },
      tela,
      rec,
      assente,
      el('div', { class: 'etichetta' }, nomeZona, nomeCamera, spia),
    )

    cella.addEventListener('click', () => {
      this.ingrandita = this.ingrandita === id ? null : id
      // Il riflesso immediato: si aspetta la prossima istantanea per il resto,
      // ma la classe si mette adesso, o il clic sembra non aver fatto niente.
      for (const [altroId, voce] of this.celle) {
        classe(voce.elemento, 'ingrandita', altroId === this.ingrandita)
      }
      this.visibili = this.ingrandita ? [this.ingrandita] : [...this.celle.keys()]
      this.elemento.style.gridTemplateColumns = this.ingrandita
        ? '1fr'
        : `repeat(${colonneGriglia(this.celle.size)}, 1fr)`
    })

    let decodificatore: DecodificatoreVideo | null = null
    let ultimoFotogramma = 0
    const avvisa = (m: string) => this.suAvviso(`${iniziale.telecamera.nome}: ${m}`)

    const voce: VoceCella = {
      elemento: cella,
      aggiorna: (dato) => {
        const t = dato.telecamera
        cella.style.setProperty('--colore-zona', dato.colore)
        testo(nomeZona, dato.zona ?? 'Non assegnata')
        testo(nomeCamera, t.nome)
        testo(
          spia,
          [
            t.fpsAnteprima !== null ? `${t.fpsAnteprima} fps` : null,
            t.batteria !== null ? `${t.batteria}%` : null,
            t.segnale !== null ? `${t.segnale}% Wi-Fi` : null,
          ]
            .filter(Boolean)
            .join('  ·  '),
        )
        if (inRegistrazione !== t.inRegistrazione) {
          inRegistrazione = t.inRegistrazione
          // Se la registrazione si e fermata da sola -- il telefono sparito,
          // il disco pieno -- la richiesta di conferma non ha piu senso.
          disarma()
        }
        classe(rec, 'accesa', t.inRegistrazione)
        attributo(
          rec,
          'title',
          t.inRegistrazione ? `Ferma la registrazione di "${t.nome}"` : `Registra "${t.nome}"`,
        )
        classe(cella, 'ingrandita', this.ingrandita === id)

        // "Muta" e diverso da "non raggiungibile": il telefono puo rispondere a
        // `/info.json` e non mandare un fotogramma da tre secondi, ed e proprio
        // il caso in cui serve dirlo.
        const muta = !t.raggiungibile || Date.now() - ultimoFotogramma > 3000
        assente.hidden = !muta
        if (muta) {
          testo(
            assente,
            t.raggiungibile ? 'in attesa di un fotogramma chiave…' : 'non raggiungibile',
          )
        }
        attributo(cella, 'title', `${t.nome} — ${t.host}:${t.porta}`)
      },
      fotogramma: (chiave, dati) => {
        decodificatore ??= new DecodificatoreVideo(tela, avvisa)
        ultimoFotogramma = Date.now()
        assente.hidden = true
        decodificatore.fotogramma(chiave, dati)
      },
      chiudi: () => {
        decodificatore?.chiudi()
        decodificatore = null
        this.celle.delete(id)
      },
    }

    this.celle.set(id, voce)
    return voce
  }
}
