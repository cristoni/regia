/**
 * Zone: creare le stanze e decidere cosa ci suona dentro (§5.1.3).
 *
 * E una schermata di Setup, e si vede: qui si fanno le cose che durante
 * l'Evento sono vietate. Creare, rinominare, riordinare o eliminare una Zona
 * **riavvia il server audio** -- il nome della Zona *e* l'identificativo del
 * suo stream Snapcast (ADR 0005) -- e sono due secondi di silenzio. In Setup
 * non costano niente; alle nove di sera costerebbero tutto, e la schermata lo
 * dice invece di far finta.
 *
 * L'elenco dei Suoni abilitati vive qui e non nella libreria, perche e una
 * proprieta della **stanza**: nella cucina non deve poter partire il rumore di
 * catene che appartiene alla cantina.
 */
import type { Stato, ZonaViva } from '../../engine/api/protocollo'
import { Elenco, attributo, el, pulsanteConferma, testo, valore, type Voce } from '../nucleo/dom'
import { campoTesto } from '../nucleo/comuni'
import type { Contesto, Schermata } from '../nucleo/schermata'

const COLORI = [
  '#c0392b', '#e67e22', '#f1c40f', '#27ae60',
  '#16a085', '#2980b9', '#8e44ad', '#7f8c8d',
]

export class Zone implements Schermata {
  readonly elemento = el('section', {})
  private readonly contenitore = el('div', { class: 'zone-griglia' })
  private readonly elenco: Elenco<ZonaViva>
  private readonly vuoto = el('div', {
    class: 'vuoto',
    testo: 'Nessuna Zona. Creane una: e da qui che comincia tutto il resto.',
  })
  private readonly avvisoEvento = el('div', { class: 'avviso' })
  private ultimo: Stato | null = null

  constructor(private readonly ctx: Contesto) {
    const nuovoNome = el('input', { type: 'text', placeholder: 'Cucina' }) as HTMLInputElement
    const crea = el('button', { class: 'pulsante principale', type: 'button', testo: 'Crea Zona' })
    const creaZona = () => {
      const nome = nuovoNome.value.trim()
      if (!nome) {
        this.ctx.avvisa('Dai un nome alla Zona.')
        return
      }
      const quante = this.ultimo?.zone.length ?? 0
      this.ctx.manda({ tipo: 'zona.crea', nome, colore: COLORI[quante % COLORI.length]! })
      nuovoNome.value = ''
    }
    crea.addEventListener('click', creaZona)
    nuovoNome.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') creaZona()
    })

    this.elemento.append(
      el(
        'div',
        { class: 'intestazione' },
        el(
          'div',
          {},
          el('h1', { testo: 'Zone' }),
          el('p', {
            class: 'sottotitolo',
            testo:
              'Una Zona e una stanza: cio che si guarda e cio che suona li dentro. Da 1 a 12. ' +
              'Ogni cambiamento qui riscrive la configurazione del server audio.',
          }),
        ),
        el('div', { class: 'fila' }, nuovoNome, crea),
      ),
      this.avvisoEvento,
      this.vuoto,
      this.contenitore,
    )

    this.elenco = new Elenco(this.contenitore, (z) => z.id, (z) => this.scheda(z))
  }

  aggiorna(stato: Stato): void {
    this.ultimo = stato
    this.elenco.sincronizza(stato.zone)
    this.vuoto.hidden = stato.zone.length > 0
    this.avvisoEvento.hidden = stato.server !== 'acceso'
    testo(
      this.avvisoEvento,
      'Il server audio e acceso: creare, rinominare, riordinare o eliminare una Zona lo riavvia, ' +
        'e per un paio di secondi gli Altoparlanti tacciono. In Setup non e un problema.',
    )
  }

  // -------------------------------------------------------------- interni

  private scheda(iniziale: ZonaViva): Voce<ZonaViva> {
    const id = iniziale.id

    const nome = campoTesto((v) => this.ctx.manda({ tipo: 'zona.rinomina', zonaId: id, nome: v }))
    const colore = el('input', { type: 'color', title: 'Colore della Zona' }) as HTMLInputElement
    colore.addEventListener('change', () =>
      this.ctx.manda({ tipo: 'zona.colore', zonaId: id, colore: colore.value }),
    )

    const sottofondo = el('select', { title: 'Sottofondo in loop' }) as HTMLSelectElement
    let firmaSuoni = ''
    sottofondo.addEventListener('change', () =>
      this.ctx.manda({
        tipo: 'zona.sottofondo',
        zonaId: id,
        suonoId: sottofondo.value === '' ? null : sottofondo.value,
      }),
    )

    const flusso = el('div', { class: 'sottofondo assente' })
    const dispositivi = el('div', { class: 'sottofondo' })

    const tutti = el('input', { type: 'checkbox' }) as HTMLInputElement
    const abilitati = el('div', { class: 'fila' })
    const elencoAbilitati = new Elenco<{ id: string; nome: string; colore: string }>(
      abilitati,
      (s) => s.id,
      (s) => this.gettoneSuono(id, s),
    )
    tutti.addEventListener('change', () =>
      this.ctx.manda({
        tipo: 'zona.suoniAbilitati',
        zonaId: id,
        suoni: tutti.checked ? null : [],
      }),
    )

    const su = el('button', { class: 'pulsante piccolo', type: 'button', testo: '↑' })
    const giu = el('button', { class: 'pulsante piccolo', type: 'button', testo: '↓' })
    su.addEventListener('click', () => this.sposta(id, -1))
    giu.addEventListener('click', () => this.sposta(id, +1))

    const duplica = el('button', { class: 'pulsante piccolo', type: 'button', testo: 'Duplica' })
    duplica.addEventListener('click', () => this.ctx.manda({ tipo: 'zona.duplica', zonaId: id }))

    const prova = el('button', {
      class: 'pulsante piccolo',
      type: 'button',
      testo: 'Prova audio',
      title: 'Manda un suono di prova a tutti gli Altoparlanti di questa Zona',
    })
    prova.addEventListener('click', () => this.ctx.manda({ tipo: 'zona.provaAudio', zonaId: id }))

    const elimina = pulsanteConferma(
      'Elimina',
      'Elimina davvero?',
      () => this.ctx.manda({ tipo: 'zona.elimina', zonaId: id }),
      'pulsante piccolo pericolo',
    )

    const scheda = el(
      'div',
      { class: 'zona' },
      el('header', {}, colore, nome),
      dispositivi,
      flusso,
      el('label', { class: 'campo' }, 'Sottofondo', sottofondo),
      el(
        'label',
        { class: 'interruttore', title: 'Tutta la libreria e utilizzabile in questa Zona' },
        tutti,
        'tutti i Suoni della libreria',
      ),
      abilitati,
      el('div', { class: 'fila' }, su, giu, duplica, prova, elimina),
    )

    return {
      elemento: scheda,
      aggiorna: (z) => {
        const stato = this.ultimo
        scheda.style.setProperty('--colore-zona', z.colore)
        valore(nome, z.nome)
        valore(colore, z.colore)

        testo(
          dispositivi,
          `${z.altoparlantiTotali} Altoparlanti · ${z.telecamereTotali} Telecamere` +
            (z.altoparlantiTotali === 0 && z.telecamereTotali === 0
              ? ' — assegnali da Dispositivi'
              : ''),
        )
        testo(flusso, z.flusso ? `Flusso Snapcast: "${z.flusso}"` : '')

        if (stato) {
          const firma = stato.suoni.map((s) => `${s.id}:${s.nome}`).join('|')
          if (firma !== firmaSuoni) {
            firmaSuoni = firma
            sottofondo.replaceChildren(
              el('option', { value: '', testo: 'Nessuno' }),
              ...stato.suoni.map((s) => el('option', { value: s.id, testo: s.nome })),
            )
          }
          valore(sottofondo, z.sottofondoId ?? '')

          if (document.activeElement !== tutti) tutti.checked = z.suoniAbilitati === null
          abilitati.hidden = z.suoniAbilitati === null
          elencoAbilitati.sincronizza(z.suoniAbilitati === null ? [] : stato.suoni)
        }
        attributo(scheda, 'title', `Zona ${z.nome}`)
      },
    }
  }

  /** Un gettone per Suono: acceso se abilitato in questa Zona. */
  private gettoneSuono(
    zonaId: string,
    iniziale: { id: string; nome: string; colore: string },
  ): Voce<{ id: string; nome: string; colore: string }> {
    const b = el('button', { class: 'gettone', type: 'button' })
    b.addEventListener('click', () => {
      const z = this.ultimo?.zone.find((x) => x.id === zonaId)
      if (!z) return
      const attuali = new Set(z.suoniAbilitati ?? this.ultimo!.suoni.map((s) => s.id))
      if (attuali.has(iniziale.id)) attuali.delete(iniziale.id)
      else attuali.add(iniziale.id)
      this.ctx.manda({ tipo: 'zona.suoniAbilitati', zonaId, suoni: [...attuali] })
    })
    return {
      elemento: b,
      aggiorna: (s) => {
        testo(b, s.nome)
        const z = this.ultimo?.zone.find((x) => x.id === zonaId)
        const acceso = z?.suoniAbilitati === null || (z?.suoniAbilitati?.includes(s.id) ?? false)
        attributo(b, 'aria-pressed', acceso ? 'true' : 'false')
      },
    }
  }

  /**
   * Sposta una Zona di un posto.
   *
   * L'ordine non e cosmetico: decide le porte delle sorgenti TCP, quindi
   * riordinare rimescola i Flussi e riavvia il server. Si manda l'ordine
   * completo, non "scambia questi due": il motore non deve indovinare niente.
   */
  private sposta(zonaId: string, di: number): void {
    const zone = this.ultimo?.zone
    if (!zone) return
    const da = zone.findIndex((z) => z.id === zonaId)
    const a = da + di
    if (da < 0 || a < 0 || a >= zone.length) return
    const ordine = zone.map((z) => z.id)
    ;[ordine[da], ordine[a]] = [ordine[a]!, ordine[da]!]
    this.ctx.manda({ tipo: 'zona.riordina', ordine: ordine as string[] })
  }
}
