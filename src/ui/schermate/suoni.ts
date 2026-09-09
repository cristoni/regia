/**
 * Suoni: la libreria (§5.1.4).
 *
 * Un Suono e un file importato, con il suo nome, colore e volume. Diventa
 * Effetto o Sottofondo solo nel momento in cui una Zona lo usa: qui non si dice
 * mai "l'Effetto nella libreria", perche non esiste.
 *
 * L'importazione manda i **byte** al motore, non un percorso. In Electron con
 * `sandbox: true` un `<input type=file>` non espone il percorso vero, e il
 * tablet della Fase 3 non ha lo stesso disco: i byte sono l'unica cosa che
 * funziona da tutti e tre i posti, e costano una copia in piu di un file che
 * si importa una volta sola.
 *
 * Il colore non e decorazione. Durante l'Evento l'Operatore preme al buio, di
 * fretta, guardando le anteprime: la mano impara la posizione e il colore molto
 * prima del nome.
 */
import type { Stato, SuonoVivo } from '../../engine/api/protocollo'
import { Elenco, attributo, el, pulsanteConferma, testo, valore, type Voce } from '../nucleo/dom'
import { areaFile, campoTesto, caricaFile, cursoreVolume } from '../nucleo/comuni'
import type { Contesto, Schermata } from '../nucleo/schermata'
import { durata, scorciatoie } from '../nucleo/viste'

export class Suoni implements Schermata {
  readonly elemento = el('section', {})
  private readonly corpo = el('tbody', {})
  private readonly elenco: Elenco<SuonoVivo>
  private readonly tabella: HTMLElement
  private readonly vuoto = el('div', { class: 'vuoto' })
  private readonly conflitti = el('div', { class: 'avviso' })
  private ultimo: Stato | null = null

  constructor(private readonly ctx: Contesto) {
    this.tabella = el(
      'table',
      { class: 'elenco' },
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          el('th', {}),
          el('th', { testo: 'Suono' }),
          el('th', { testo: 'Categoria' }),
          el('th', { testo: 'Volume' }),
          el('th', { testo: 'Tasto' }),
          el('th', { testo: 'Durata' }),
          el('th', {}),
        ),
      ),
      this.corpo,
    )

    testo(
      this.vuoto,
      'La libreria e vuota. Trascina qui i file audio, o scegli quali importare.',
    )

    this.elemento.append(
      el('h1', { testo: 'Suoni' }),
      el('p', {
        class: 'sottotitolo',
        testo:
          'MP3, WAV, OGG e FLAC. Ogni file viene copiato e convertito una volta sola nel formato ' +
          'del server, cosi la riproduzione parte senza decodificare niente.',
      }),
      areaFile(
        'Trascina qui i file audio da importare',
        'audio/*,.mp3,.wav,.ogg,.flac,.m4a',
        (file) => void this.importa(file),
      ),
      this.conflitti,
      this.tabella,
      this.vuoto,
    )

    this.elenco = new Elenco(this.corpo, (s) => s.id, (s) => this.riga(s))
  }

  aggiorna(stato: Stato): void {
    this.ultimo = stato
    this.elenco.sincronizza(stato.suoni)
    this.tabella.hidden = stato.suoni.length === 0
    this.vuoto.hidden = stato.suoni.length > 0

    const { conflitti } = scorciatoie(stato)
    this.conflitti.hidden = conflitti.length === 0
    if (conflitti.length > 0) {
      testo(
        this.conflitti,
        'Tasti rapidi doppi: ' +
          conflitti.map((c) => `${c.tasto} → ${c.suoni.join(', ')}`).join(' ; ') +
          '. Premendoli parte solo il primo.',
      )
    }
  }

  // -------------------------------------------------------------- interni

  private async importa(file: File[]): Promise<void> {
    for (const f of file) {
      try {
        await caricaFile(`/api/suoni?nome=${encodeURIComponent(f.name)}`, f)
        this.ctx.avvisa(`"${f.name}" importato.`, true)
      } catch (e) {
        this.ctx.avvisa(`"${f.name}": ${(e as Error).message}`)
      }
    }
  }

  private riga(iniziale: SuonoVivo): Voce<SuonoVivo> {
    const id = iniziale.id

    const colore = el('input', { type: 'color', title: 'Colore del pulsante' }) as HTMLInputElement
    colore.addEventListener('change', () =>
      this.ctx.manda({ tipo: 'suono.aggiorna', suonoId: id, colore: colore.value }),
    )
    const nome = campoTesto((v) => this.ctx.manda({ tipo: 'suono.aggiorna', suonoId: id, nome: v }))
    const categoria = el('input', {
      type: 'text', placeholder: 'urlo, ambiente, botto…',
    }) as HTMLInputElement
    categoria.addEventListener('change', () =>
      this.ctx.manda({
        tipo: 'suono.aggiorna',
        suonoId: id,
        categoria: categoria.value.trim() || null,
      }),
    )
    const guadagno = cursoreVolume(
      (v) => this.ctx.manda({ tipo: 'suono.aggiorna', suonoId: id, guadagno: v }),
      'Volume relativo di questo Suono',
    )

    // Il tasto si registra premendolo, non scrivendolo: e l'unico modo di
    // essere sicuri che il tasto assegnato sia quello che si premera davvero.
    const tasto = el('input', {
      type: 'text', placeholder: 'premi un tasto', title: 'Clicca qui e premi il tasto',
    }) as HTMLInputElement
    tasto.style.width = '110px'
    tasto.addEventListener('keydown', (e) => {
      e.preventDefault()
      const scelto = e.key === 'Backspace' || e.key === 'Delete' ? null : e.key.toUpperCase()
      if (scelto === 'ESCAPE') {
        tasto.blur()
        return
      }
      this.ctx.manda({ tipo: 'suono.aggiorna', suonoId: id, tastoRapido: scelto })
      tasto.blur()
    })

    const durataCella = el('span', { class: 'conteggi' })

    const anteprima = el('button', {
      class: 'pulsante piccolo',
      type: 'button',
      testo: 'Ascolta',
      title: 'Dalle casse del PC, non dagli Altoparlanti',
    })
    anteprima.addEventListener('click', () =>
      this.ctx.manda({ tipo: 'suono.anteprima', suonoId: id }),
    )
    const su = el('button', { class: 'pulsante piccolo', type: 'button', testo: '↑' })
    const giu = el('button', { class: 'pulsante piccolo', type: 'button', testo: '↓' })
    su.addEventListener('click', () => this.sposta(id, -1))
    giu.addEventListener('click', () => this.sposta(id, +1))
    const elimina = pulsanteConferma(
      'Elimina',
      'Elimina davvero?',
      () => this.ctx.manda({ tipo: 'suono.elimina', suonoId: id }),
      'pulsante piccolo pericolo',
    )

    const riga = el(
      'tr',
      {},
      el('td', {}, colore),
      el('td', {}, nome),
      el('td', {}, categoria),
      el('td', {}, guadagno.elemento),
      el('td', {}, tasto),
      el('td', {}, durataCella),
      el('td', { class: 'comandi' }, anteprima, ' ', su, giu, ' ', elimina),
    )

    return {
      elemento: riga,
      aggiorna: (s) => {
        valore(colore, s.colore)
        valore(nome, s.nome)
        valore(categoria, s.categoria ?? '')
        guadagno.aggiorna(s.guadagno)
        valore(tasto, s.tastoRapido ?? '')
        testo(durataCella, s.pronto ? durata(s.durataMs) : 'in preparazione…')
        anteprima.disabled = !s.pronto
        attributo(riga, 'title', s.pronto ? '' : 'il thread audio non ha ancora i campioni')
      },
    }
  }

  private sposta(suonoId: string, di: number): void {
    const suoni = this.ultimo?.suoni
    if (!suoni) return
    const da = suoni.findIndex((s) => s.id === suonoId)
    const a = da + di
    if (da < 0 || a < 0 || a >= suoni.length) return
    const ordine = suoni.map((s) => s.id)
    ;[ordine[da], ordine[a]] = [ordine[a]!, ordine[da]!]
    this.ctx.manda({ tipo: 'suono.riordina', ordine: ordine as string[] })
  }
}
