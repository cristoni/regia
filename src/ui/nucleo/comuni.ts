/**
 * I pezzi di interfaccia che compaiono in piu di una schermata.
 *
 * Stanno insieme perche devono comportarsi allo stesso modo dappertutto: un
 * menu delle Zone che in una schermata mette "Non assegnato" in cima e in
 * un'altra in fondo e un modo di far sbagliare stanza a chi sta configurando
 * di fretta.
 */
import type { Stato } from '../../engine/api/protocollo'
import { attributo, classe, el, testo, valore } from './dom'

/**
 * Il menu con cui si mette un dispositivo in una Zona.
 *
 * "Non assegnato" e la prima voce e non e un errore: e lo stato normale a meta
 * Setup, e chi sta togliendo un dispositivo da una Zona lo cerca in cima.
 */
export function menuZone(suScelta: (zonaId: string | null) => void): {
  elemento: HTMLSelectElement
  aggiorna(stato: Stato, scelta: string | null): void
} {
  const s = el('select', { title: 'Zona' }) as HTMLSelectElement
  let firma = ''
  s.addEventListener('change', () => suScelta(s.value === '' ? null : s.value))

  return {
    elemento: s,
    aggiorna(stato, scelta) {
      // Le opzioni si ricostruiscono solo quando le Zone cambiano davvero:
      // rifarle a ogni istantanea chiuderebbe il menu mentre lo si sta usando.
      const nuova = stato.zone.map((z) => `${z.id}:${z.nome}`).join('|')
      if (nuova !== firma) {
        firma = nuova
        s.replaceChildren(
          el('option', { value: '', testo: 'Non assegnato' }),
          ...stato.zone.map((z) => el('option', { value: z.id, testo: z.nome })),
        )
      }
      valore(s, scelta ?? '')
    },
  }
}

/** La lucina verde/rossa davanti al nome di un dispositivo. */
export function luce(): { elemento: HTMLElement; aggiorna(viva: boolean, conosciuto?: boolean): void } {
  const e = el('span', { class: 'luce' })
  return {
    elemento: e,
    aggiorna(viva, conosciuto = true) {
      classe(e, 'viva', viva)
      classe(e, 'persa', !viva && conosciuto)
      attributo(e, 'title', viva ? 'collegato' : 'non collegato')
    },
  }
}

/**
 * Un campo di testo che manda il valore quando si finisce di scriverlo.
 *
 * Non a ogni tasto: rinominare una Zona riscrive la configurazione di
 * snapserver, e un comando per lettera sarebbe una decina di riconfigurazioni
 * per un nome. Si manda all'uscita dal campo o con Invio, che e anche il
 * momento in cui chi scrive ha deciso.
 */
export function campoTesto(
  suConferma: (valore: string) => void,
  attributi: Record<string, string> = {},
): HTMLInputElement {
  const i = el('input', { type: 'text', ...attributi }) as HTMLInputElement
  let ultimoMandato = ''
  const manda = () => {
    const v = i.value.trim()
    if (v === '' || v === ultimoMandato) return
    ultimoMandato = v
    suConferma(v)
  }
  i.addEventListener('change', manda)
  i.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      manda()
      i.blur()
    }
    if (e.key === 'Escape') i.blur()
  })
  return i
}

/** Un cursore da 0 a 200%, con l'etichetta accanto. */
export function cursoreVolume(
  suCambio: (volume: number) => void,
  titolo: string,
): { elemento: HTMLElement; aggiorna(volume: number): void } {
  const c = el('input', {
    type: 'range', min: '0', max: '200', step: '5', title: titolo,
  }) as HTMLInputElement
  const etichetta = el('span', { class: 'conteggi' })
  c.addEventListener('input', () => {
    testo(etichetta, `${c.value}%`)
    suCambio(Number(c.value) / 100)
  })
  return {
    elemento: el('div', { class: 'fila' }, c, etichetta),
    aggiorna(volume) {
      valore(c, String(Math.round(volume * 100)))
      testo(etichetta, `${Math.round(volume * 100)}%`)
    },
  }
}

/**
 * Manda un file al motore come byte.
 *
 * Non si passa da un percorso su disco: in Electron con `sandbox: true` un
 * `<input type=file>` non lo espone, e il tablet della Fase 3 non ha nemmeno
 * lo stesso disco. I byte funzionano da tutti e tre i posti.
 */
export async function caricaFile(percorso: string, file: File): Promise<void> {
  const risposta = await fetch(percorso, { method: 'POST', body: file })
  if (risposta.ok) return
  const corpo = (await risposta.json().catch(() => ({}))) as { errore?: string }
  throw new Error(corpo.errore ?? `il motore ha risposto ${risposta.status}`)
}

/**
 * Una zona di trascinamento che accetta file.
 *
 * Il §3.4 chiede il trascinamento nella finestra per importare i Suoni. Vale
 * anche per il progetto, e in tutti e due i casi la cosa importante e che
 * l'area si accenda quando ci passi sopra: senza, non si capisce dove lasciare.
 */
export function areaFile(
  etichetta: string,
  accetta: string,
  suFile: (file: File[]) => void,
): HTMLElement {
  const scelta = el('input', { type: 'file', accept: accetta, multiple: true }) as HTMLInputElement
  scelta.style.display = 'none'
  scelta.addEventListener('change', () => {
    if (scelta.files) suFile([...scelta.files])
    scelta.value = ''
  })

  const area = el(
    'div',
    { class: 'vuoto' },
    el('div', { testo: etichetta }),
    el('button', { class: 'pulsante piccolo', type: 'button', testo: 'Scegli i file…' }),
    scelta,
  )
  area.querySelector('button')?.addEventListener('click', () => scelta.click())

  for (const evento of ['dragenter', 'dragover'] as const) {
    area.addEventListener(evento, (e) => {
      e.preventDefault()
      area.style.borderColor = 'var(--accento)'
    })
  }
  for (const evento of ['dragleave', 'drop'] as const) {
    area.addEventListener(evento, () => (area.style.borderColor = ''))
  }
  area.addEventListener('drop', (e) => {
    e.preventDefault()
    const file = [...(e.dataTransfer?.files ?? [])]
    if (file.length > 0) suFile(file)
  })
  return area
}
