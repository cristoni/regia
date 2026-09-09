/**
 * Il minimo indispensabile per costruire e aggiornare DOM a mano.
 *
 * Non c'e un framework, ed e una scelta. Lo stato arriva come istantanea
 * completa dieci volte al secondo: un framework che ricostruisce l'albero a
 * ogni istantanea distruggerebbe i `<canvas>` delle Telecamere, e con loro il
 * `VideoDecoder` che ci sta dietro -- un secondo di nero per riavere un IDR,
 * dieci volte al secondo, per sempre.
 *
 * Quindi: si crea una volta e si aggiorna in posto, con `Elenco` a tenere
 * allineate le liste per chiave. Le funzioni di aggiornamento devono essere
 * idempotenti e non toccare il DOM quando non c'e niente da cambiare: un
 * `textContent` riassegnato uguale non costa nulla, ma un `replaceChildren`
 * inutile fa perdere il fuoco e la selezione.
 */

type Figlio = Node | string | null | undefined | false

interface Attributi {
  readonly class?: string
  readonly title?: string
  readonly type?: string
  readonly id?: string
  readonly testo?: string
  readonly [chiave: string]: string | number | boolean | undefined | ((e: Event) => void)
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributi: Attributi = {},
  ...figli: Figlio[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attributi)) {
    if (v === undefined || v === false) continue
    if (k === 'testo') {
      e.textContent = String(v)
    } else if (k.startsWith('su') && typeof v === 'function') {
      // `suClic` -> `click`, `suIngresso` -> ... no: gli eventi si passano con
      // il nome DOM vero dopo `su`, minuscolo. `suclick`, `suinput`, `suchange`.
      e.addEventListener(k.slice(2), v as EventListener)
    } else if (typeof v === 'boolean') {
      if (v) e.setAttribute(k, '')
    } else {
      e.setAttribute(k, String(v))
    }
  }
  aggiungi(e, figli)
  return e
}

function aggiungi(genitore: HTMLElement, figli: readonly Figlio[]): void {
  for (const f of figli) {
    if (f === null || f === undefined || f === false) continue
    genitore.append(typeof f === 'string' ? document.createTextNode(f) : f)
  }
}

/** Assegna solo se cambia: risparmia il reflow e non disturba la selezione. */
export function testo(e: HTMLElement, valore: string): void {
  if (e.textContent !== valore) e.textContent = valore
}

export function classe(e: HTMLElement, nome: string, acceso: boolean): void {
  if (e.classList.contains(nome) !== acceso) e.classList.toggle(nome, acceso)
}

export function attributo(e: HTMLElement, nome: string, valore: string | null): void {
  if (valore === null) {
    if (e.hasAttribute(nome)) e.removeAttribute(nome)
  } else if (e.getAttribute(nome) !== valore) {
    e.setAttribute(nome, valore)
  }
}

/** Un campo di testo non si riscrive mentre ci si sta scrivendo dentro. */
export function valore(e: HTMLInputElement | HTMLSelectElement, v: string): void {
  if (document.activeElement === e) return
  if (e.value !== v) e.value = v
}

export interface Voce<T> {
  readonly elemento: HTMLElement
  aggiorna(dato: T): void
  /** Chiamata quando la voce esce dall'elenco: qui si chiudono i decodificatori. */
  chiudi?(): void
}

/**
 * Una lista del DOM tenuta allineata a una lista di dati, per chiave.
 *
 * Gli elementi che restano non vengono ricreati: e questa la proprieta che
 * serve. L'ordine si sistema con `insertBefore`, che su liste da dodici
 * elementi costa meno di qualunque cosa piu furba.
 */
export class Elenco<T> {
  private readonly voci = new Map<string, Voce<T>>()

  constructor(
    private readonly genitore: HTMLElement,
    private readonly chiave: (dato: T) => string,
    private readonly crea: (dato: T) => Voce<T>,
  ) {}

  sincronizza(dati: readonly T[]): void {
    const viste = new Set<string>()

    for (const dato of dati) {
      const k = this.chiave(dato)
      viste.add(k)
      let voce = this.voci.get(k)
      if (!voce) {
        voce = this.crea(dato)
        this.voci.set(k, voce)
      }
      voce.aggiorna(dato)
    }

    for (const [k, voce] of this.voci) {
      if (viste.has(k)) continue
      voce.chiudi?.()
      voce.elemento.remove()
      this.voci.delete(k)
    }

    // L'ordine, dopo: si scorre la lista voluta e si sposta solo cio che non e
    // gia al posto giusto.
    let atteso = this.genitore.firstElementChild
    for (const dato of dati) {
      const voce = this.voci.get(this.chiave(dato))!
      if (voce.elemento === atteso) {
        atteso = atteso.nextElementSibling
      } else {
        this.genitore.insertBefore(voce.elemento, atteso)
      }
    }
  }

  get(chiave: string): Voce<T> | undefined {
    return this.voci.get(chiave)
  }

  svuota(): void {
    for (const [, voce] of this.voci) {
      voce.chiudi?.()
      voce.elemento.remove()
    }
    this.voci.clear()
  }
}

/**
 * Un pulsante che chiede conferma prima di fare il danno.
 *
 * §5.2: ogni azione distruttiva chiede conferma, e nessuna finestra bloccante
 * durante l'Evento. `confirm()` del browser e bloccante e in Electron congela
 * la finestra: si usa un secondo clic, con il pulsante che cambia faccia e
 * torna com'era dopo qualche secondo se nessuno insiste.
 */
export function pulsanteConferma(
  etichetta: string,
  conferma: string,
  azione: () => void,
  classi = 'pulsante pericolo',
): HTMLButtonElement {
  let armato = false
  let scadenza: number | undefined

  const b = el('button', { class: classi, type: 'button', testo: etichetta })
  b.addEventListener('click', () => {
    if (armato) {
      window.clearTimeout(scadenza)
      armato = false
      b.textContent = etichetta
      b.classList.remove('armato')
      azione()
      return
    }
    armato = true
    b.textContent = conferma
    b.classList.add('armato')
    scadenza = window.setTimeout(() => {
      armato = false
      b.textContent = etichetta
      b.classList.remove('armato')
    }, 4000)
  })
  return b
}
