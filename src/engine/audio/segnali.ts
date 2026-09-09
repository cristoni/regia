/**
 * I due Suoni che Regia si fabbrica da sola.
 *
 * "Identifica" e il modo principale con cui si abbinano i telefoni alle stanze
 * (§3.2), e il test audio di Zona e il passo 6 del Setup guidato: nessuno dei
 * due puo dipendere da un file che l'Operatore deve ricordarsi di importare.
 * Si generano come PCM al formato del progetto e si scrivono nella cache, cosi
 * il thread audio li carica esattamente come qualunque altro Suono -- non c'e
 * un percorso speciale nel mixer per farli suonare.
 *
 * Non finiscono nella libreria: non sono Suoni del dominio, sono strumenti. Per
 * questo hanno identificativi che nessun Suono importato puo avere (`@`).
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { BYTE_PER_CAMPIONE, type ImpostazioniAudio } from '../dominio/progetto.js'

export const SUONO_IDENTIFICA = '@identifica'
export const SUONO_PROVA = '@prova'

interface Nota {
  /** Hz. */
  readonly altezza: number
  readonly inizioMs: number
  readonly durataMs: number
  readonly ampiezza: number
}

/**
 * Due note salienti, corte e riconoscibili anche in una stanza rumorosa a
 * meta pomeriggio, con qualcuno che tiene il telefono in mano.
 */
const IDENTIFICA: readonly Nota[] = [
  { altezza: 880, inizioMs: 0, durataMs: 180, ampiezza: 0.5 },
  { altezza: 1320, inizioMs: 220, durataMs: 260, ampiezza: 0.5 },
]

/**
 * Il test audio deve provare che *quella* Zona suona, quindi dura piu a lungo e
 * copre piu registro: una cassa scollegata a meta si sente subito.
 */
const PROVA: readonly Nota[] = [
  { altezza: 440, inizioMs: 0, durataMs: 300, ampiezza: 0.45 },
  { altezza: 554, inizioMs: 300, durataMs: 300, ampiezza: 0.45 },
  { altezza: 659, inizioMs: 600, durataMs: 500, ampiezza: 0.45 },
]

/** Dissolvenza sui bordi di ogni nota: senza, ogni nota inizia con un click. */
const BORDO_MS = 12

export function generaSegnale(note: readonly Nota[], a: ImpostazioniAudio): Buffer {
  const durataMs = Math.max(...note.map((n) => n.inizioMs + n.durataMs)) + 60
  const campioni = Math.ceil((a.frequenza * durataMs) / 1000)
  const b = Buffer.alloc(campioni * a.canali * BYTE_PER_CAMPIONE)

  for (const nota of note) {
    const da = Math.floor((a.frequenza * nota.inizioMs) / 1000)
    const quanti = Math.floor((a.frequenza * nota.durataMs) / 1000)
    const bordo = Math.max(1, Math.floor((a.frequenza * BORDO_MS) / 1000))

    for (let i = 0; i < quanti; i++) {
      const t = (da + i) / a.frequenza
      const inviluppo = Math.min(1, i / bordo, (quanti - i) / bordo)
      const v = Math.sin(2 * Math.PI * nota.altezza * t) * nota.ampiezza * inviluppo
      const intero = Math.max(-32768, Math.min(32767, Math.round(v * 32767)))
      for (let canale = 0; canale < a.canali; canale++) {
        const offset = ((da + i) * a.canali + canale) * BYTE_PER_CAMPIONE
        if (offset + 1 < b.length) b.writeInt16LE(intero, offset)
      }
    }
  }
  return b
}

export interface SegnaleScritto {
  readonly id: string
  readonly percorso: string
  readonly durataMs: number
}

/**
 * Scrive i due segnali nella cache e dice dove sono.
 *
 * Si riscrivono a ogni avvio invece di controllare se ci sono gia: sono
 * qualche decina di kilobyte, e il formato dipende dalle impostazioni audio,
 * che l'Operatore puo aver cambiato mentre l'app era chiusa.
 */
export async function scriviSegnali(
  cartellaCache: string,
  a: ImpostazioniAudio,
): Promise<SegnaleScritto[]> {
  await fs.mkdir(cartellaCache, { recursive: true })
  const bytePerSecondo = a.frequenza * a.canali * BYTE_PER_CAMPIONE

  const fuori: SegnaleScritto[] = []
  for (const [id, note] of [
    [SUONO_IDENTIFICA, IDENTIFICA],
    [SUONO_PROVA, PROVA],
  ] as const) {
    const dati = generaSegnale(note, a)
    const percorso = path.join(cartellaCache, `${id.slice(1)}.pcm`)
    await fs.writeFile(percorso, dati)
    fuori.push({ id, percorso, durataMs: Math.round((dati.byteLength / bytePerSecondo) * 1000) })
  }
  return fuori
}
