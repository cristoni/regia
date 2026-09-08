/**
 * Il motore di Regia.
 *
 * Mette insieme i pezzi e li serve. Non importa niente di Electron, di proposito
 * (ADR 0004): si avvia da qui, dal guscio, o da uno script di collaudo, e in
 * tutti e tre i casi si comporta allo stesso modo.
 *
 * Cosa e collegato oggi: progetto, Zone, libreria dei Suoni, mixer per Zona,
 * riproduzione. Cosa non lo e ancora: la distro WSL, il JSON-RPC verso
 * snapserver, le Telecamere e la registrazione. Quei comandi rispondono con un
 * errore esplicito invece di far finta -- un motore che dice "non ancora" e
 * utile, uno che finge non lo e.
 */
import * as os from 'node:os'
import * as path from 'node:path'

import {
  byteBlocco,
  effettiDellaZona,
  latenzaAttesaMs,
  progettoVuoto,
  zoneOrdinate,
  type Progetto,
  type Suono,
  type Zona,
} from './dominio/progetto.js'
import { ArchivioProgetto } from './progetto/archivio.js'
import { LibreriaSuoni } from './audio/libreria.js'
import { MixerZona } from './audio/mixer.js'
import { OPZIONI_PREDEFINITE, Servitore, type Motore, type OpzioniServitore } from './api/servitore.js'
import type { Comando, Evento, Stato, ZonaViva } from './api/protocollo.js'

export interface OpzioniMotore {
  /** Cartella dei dati di Regia: progetto, suoni, cache. */
  readonly cartellaDati: string
  readonly servitore: Partial<OpzioniServitore>
}

export interface MotoreAvviato {
  readonly indirizzo: string
  readonly porta: number
  ferma(): Promise<void>
}

class NonAncora extends Error {
  constructor(cosa: string) {
    super(`${cosa}: non ancora collegato in questa versione`)
    this.name = 'NonAncora'
  }
}

export class MotoreRegia implements Motore {
  private progetto: Progetto
  private readonly mixer = new Map<string, MixerZona>()
  private readonly ascoltatoriVideo: ((id: string, chiave: boolean, d: Uint8Array) => void)[] = []
  private readonly ascoltatoriDiario: ((e: Extract<Evento, { tipo: 'diario' }>) => void)[] = []
  private readonly avvisi: { livello: 'info' | 'attenzione' | 'grave'; testo: string }[] = []
  private prossimoId = 1

  constructor(
    progetto: Progetto,
    private readonly archivio: ArchivioProgetto,
    private readonly libreria: LibreriaSuoni,
  ) {
    this.progetto = progetto
    for (const z of progetto.zone) this.creaMixer(z)
  }

  // ------------------------------------------------------------- lettura

  istantanea(): Progetto {
    return this.progetto
  }

  stato(): Stato {
    const a = this.progetto.audio
    const collegati = new Map<string, number>()
    for (const alt of this.progetto.altoparlanti) {
      if (alt.zonaId) collegati.set(alt.zonaId, (collegati.get(alt.zonaId) ?? 0) + 1)
    }

    const zone: ZonaViva[] = zoneOrdinate(this.progetto).map((z) => {
      const m = this.mixer.get(z.id)?.stato()
      return {
        id: z.id,
        nome: z.nome,
        colore: z.colore,
        // Il volume vero e quello nel mixer: e li che viene applicato, e in un
        // istante in cui il comando fosse a meta strada sarebbero diversi.
        volume: m?.volume ?? z.volume,
        sottofondoId: m?.sottofondoAttivo ? z.sottofondoId : null,
        // Con l'identificativo del Suono, non solo il conteggio: e cosi che
        // l'interfaccia sa quale pulsante illuminare (§5.2).
        effettiInCorso: m?.effetti ?? [],
        altoparlantiCollegati: 0,
        altoparlantiTotali: collegati.get(z.id) ?? 0,
        telecamereCollegate: 0,
        telecamereTotali: this.progetto.telecamere.filter((t) => t.zonaId === z.id).length,
        buchiMs: 0,
      }
    })

    return {
      progettoNome: this.progetto.nome,
      server: 'non installato',
      zone,
      altoparlanti: this.progetto.altoparlanti.map((x) => ({
        id: x.id, nome: x.nome, zonaId: x.zonaId, collegato: false,
        volume: x.volume, muto: x.muto, latenzaMs: x.latenzaMs,
        indirizzo: null, vistoIl: x.vistoIl, inIdentificazione: false,
      })),
      telecamere: this.progetto.telecamere.map((t) => ({
        id: t.id, nome: t.nome, zonaId: t.zonaId, host: t.host, porta: t.porta,
        raggiungibile: false, batteria: null, segnale: null,
        inRegistrazione: false, fpsAnteprima: null, vistoIl: null,
      })),
      suoni: this.progetto.suoni.map((s) => ({
        id: s.id, nome: s.nome, colore: s.colore, categoria: s.categoria,
        durataMs: s.durataMs, tastoRapido: s.tastoRapido,
        pronto: this.libreria.ottieni(s.id) !== undefined,
      })),
      registrazione: {
        attive: 0, spazioLiberoGb: 0, sottoAvviso: false, bloccata: false,
        cartella: this.progetto.registrazione.cartella,
      },
      audio: {
        bufferMs: a.bufferMs,
        codec: a.codec,
        bandaMbit:
          Math.round(
            ((a.frequenza * a.canali * 2 * 8 * this.progetto.altoparlanti.length) / 1e6) * 10,
          ) / 10,
      },
      avvisi: [...this.avvisi],
    }
  }

  ascoltaVideo(a: (id: string, chiave: boolean, d: Uint8Array) => void): () => void {
    this.ascoltatoriVideo.push(a)
    return () => {
      const i = this.ascoltatoriVideo.indexOf(a)
      if (i >= 0) this.ascoltatoriVideo.splice(i, 1)
    }
  }

  ascoltaDiario(a: (e: Extract<Evento, { tipo: 'diario' }>) => void): () => void {
    this.ascoltatoriDiario.push(a)
    return () => {
      const i = this.ascoltatoriDiario.indexOf(a)
      if (i >= 0) this.ascoltatoriDiario.splice(i, 1)
    }
  }

  diario(livello: 'info' | 'attenzione' | 'grave', testo: string): void {
    const e = { tipo: 'diario', quando: new Date().toISOString(), livello, testo } as const
    for (const a of this.ascoltatoriDiario) a(e)
  }

  // -------------------------------------------------------------- comandi

  async esegui(c: Comando): Promise<void> {
    switch (c.tipo) {
      case 'zona.crea': {
        const z: Zona = {
          id: this.nuovoId('z'),
          nome: c.nome,
          colore: c.colore,
          ordine: this.progetto.zone.length,
          volume: 1,
          sottofondoId: null,
          suoniAbilitati: null,
        }
        this.progetto.zone.push(z)
        this.creaMixer(z)
        this.diario('info', `Creata la Zona "${z.nome}"`)
        break
      }
      case 'zona.rinomina':
        this.zona(c.zonaId).nome = c.nome
        break
      case 'zona.colore':
        this.zona(c.zonaId).colore = c.colore
        break
      case 'zona.duplica': {
        const o = this.zona(c.zonaId)
        const z: Zona = { ...o, id: this.nuovoId('z'), nome: `${o.nome} (copia)`, ordine: this.progetto.zone.length }
        this.progetto.zone.push(z)
        this.creaMixer(z)
        break
      }
      case 'zona.elimina': {
        const z = this.zona(c.zonaId)
        this.progetto.zone = this.progetto.zone.filter((x) => x.id !== c.zonaId)
        this.mixer.delete(c.zonaId)
        // I dispositivi non si cancellano: tornano non assegnati, che e lo stato
        // normale di un telefono acceso ma non ancora messo in una stanza.
        for (const a of this.progetto.altoparlanti) if (a.zonaId === c.zonaId) a.zonaId = null
        for (const t of this.progetto.telecamere) if (t.zonaId === c.zonaId) t.zonaId = null
        this.diario('info', `Eliminata la Zona "${z.nome}"`)
        break
      }
      case 'zona.riordina':
        for (const [i, id] of c.ordine.entries()) this.zona(id).ordine = i
        break
      case 'zona.sottofondo': {
        const z = this.zona(c.zonaId)
        z.sottofondoId = c.suonoId
        const m = this.mixer.get(z.id)
        if (!m) break
        if (!c.suonoId) m.impostaSottofondo(null)
        else {
          const s = this.suono(c.suonoId)
          const campionato = this.libreria.ottieni(c.suonoId)
          if (!campionato) throw new Error(`il Suono "${s.nome}" non e ancora pronto`)
          m.impostaSottofondo(campionato, s.guadagno)
        }
        break
      }
      case 'zona.suoniAbilitati':
        this.zona(c.zonaId).suoniAbilitati = c.suoni
        break

      case 'zona.suona': {
        const s = this.suono(c.suonoId)
        const campionato = this.libreria.ottieni(c.suonoId)
        if (!campionato) throw new Error(`il Suono "${s.nome}" non e ancora pronto`)
        for (const zonaId of c.zone) {
          const z = this.zona(zonaId)
          const m = this.mixer.get(zonaId)
          if (!m) continue
          const ammessi = effettiDellaZona(this.progetto, z)
          if (!ammessi.some((x) => x.id === c.suonoId)) {
            throw new Error(`"${s.nome}" non e abilitato nella Zona "${z.nome}"`)
          }
          if (c.esclusivo) m.avviaEffettoEsclusivo(campionato, s.guadagno)
          else m.avviaEffetto(campionato, s.guadagno)
        }
        break
      }
      case 'zona.volume': {
        this.zona(c.zonaId).volume = c.volume
        this.mixer.get(c.zonaId)?.impostaVolume(c.volume)
        break
      }
      case 'zona.stop':
        this.mixer.get(c.zonaId)?.fermaEffetti()
        break
      case 'stopTutto':
        for (const m of this.mixer.values()) m.fermaEffetti()
        this.diario('attenzione', 'STOP TUTTO')
        break

      case 'suono.importa': {
        for (const percorso of c.percorsi) {
          const file = await this.libreria.importa(percorso)
          const s: Suono = {
            id: this.nuovoId('s'),
            nome: path.basename(percorso, path.extname(percorso)).slice(0, 40),
            file, colore: '#cc0000', categoria: null, guadagno: 1,
            durataMs: null, tastoRapido: null, ordine: this.progetto.suoni.length,
          }
          this.progetto.suoni.push(s)
          const esito = await this.libreria.prepara(s, this.progetto.audio)
          s.durataMs = esito.durataMs
          this.diario('info', `Importato il Suono "${s.nome}"`)
        }
        break
      }
      case 'suono.elimina': {
        const s = this.suono(c.suonoId)
        this.progetto.suoni = this.progetto.suoni.filter((x) => x.id !== c.suonoId)
        this.libreria.dimentica(c.suonoId)
        for (const z of this.progetto.zone) {
          if (z.sottofondoId === c.suonoId) {
            z.sottofondoId = null
            this.mixer.get(z.id)?.impostaSottofondo(null)
          }
          if (z.suoniAbilitati) z.suoniAbilitati = z.suoniAbilitati.filter((x) => x !== c.suonoId)
        }
        this.diario('info', `Eliminato il Suono "${s.nome}"`)
        break
      }
      case 'suono.aggiorna': {
        const s = this.suono(c.suonoId)
        if (c.nome !== undefined) s.nome = c.nome
        if (c.colore !== undefined) s.colore = c.colore
        if (c.categoria !== undefined) s.categoria = c.categoria
        if (c.guadagno !== undefined) s.guadagno = c.guadagno
        if (c.tastoRapido !== undefined) s.tastoRapido = c.tastoRapido
        break
      }
      case 'suono.riordina':
        for (const [i, id] of c.ordine.entries()) this.suono(id).ordine = i
        break

      case 'altoparlante.assegna': {
        const a = this.altoparlante(c.clientId)
        if (c.zonaId) this.zona(c.zonaId)
        a.zonaId = c.zonaId
        break
      }
      case 'altoparlante.rinomina':
        this.altoparlante(c.clientId).nome = c.nome
        break
      case 'altoparlante.volume':
        this.altoparlante(c.clientId).volume = c.volume
        break
      case 'altoparlante.muto':
        this.altoparlante(c.clientId).muto = c.muto
        break
      case 'altoparlante.latenza':
        this.altoparlante(c.clientId).latenzaMs = c.latenzaMs
        break
      case 'altoparlante.dimentica':
        this.progetto.altoparlanti = this.progetto.altoparlanti.filter((x) => x.id !== c.clientId)
        break

      case 'impostazioni.audio': {
        if (c.bufferMs !== undefined) this.progetto.audio.bufferMs = c.bufferMs
        this.diario(
          'attenzione',
          `Latenza attesa dal pulsante al suono: ${latenzaAttesaMs(this.progetto.audio)} ms`,
        )
        break
      }

      // Non ancora collegati. Meglio un errore netto che un comportamento finto.
      case 'altoparlante.identifica':
        throw new NonAncora('Identifica')
      case 'telecamera.aggiungi': case 'telecamera.rinomina': case 'telecamera.assegna':
      case 'telecamera.identifica': case 'telecamera.rimuovi': case 'telecamera.controlla':
      case 'telecamera.scansiona':
        throw new NonAncora('le Telecamere')
      case 'registrazione.avvia': case 'registrazione.ferma':
        throw new NonAncora('la registrazione')
      case 'server.avvia': case 'server.ferma': case 'server.riavvia': case 'ricollegaTutto':
        throw new NonAncora('il server audio')
      case 'suono.anteprima':
        throw new NonAncora("l'anteprima dei Suoni sul PC")
      default: {
        const mai: never = c
        throw new Error(`comando sconosciuto: ${JSON.stringify(mai)}`)
      }
    }

    // §3.9: salvataggio automatico a ogni modifica. Raggruppato, ma mai perso.
    this.archivio.programmaSalvataggio(this.progetto)
  }

  // -------------------------------------------------------------- interni

  private creaMixer(z: Zona): void {
    this.mixer.set(z.id, new MixerZona(this.progetto.audio, z.volume))
  }

  private nuovoId(prefisso: string): string {
    return `${prefisso}${this.prossimoId++}`
  }

  private zona(id: string): Zona {
    const z = this.progetto.zone.find((x) => x.id === id)
    if (!z) throw new Error(`Zona inesistente: ${id}`)
    return z
  }
  private suono(id: string) {
    const s = this.progetto.suoni.find((x) => x.id === id)
    if (!s) throw new Error(`Suono inesistente: ${id}`)
    return s
  }
  private altoparlante(id: string) {
    const a = this.progetto.altoparlanti.find((x) => x.id === id)
    if (!a) throw new Error(`Altoparlante inesistente: ${id}`)
    return a
  }
}

export async function avviaMotore(opzioni: Partial<OpzioniMotore> = {}): Promise<MotoreAvviato> {
  const cartellaDati = opzioni.cartellaDati ?? path.join(os.homedir(), 'Regia')
  const archivio = new ArchivioProgetto(path.join(cartellaDati, 'progetto.json'), (e) =>
    console.error('salvataggio del progetto fallito:', e),
  )

  const caricato = await archivio.carica()
  const progetto =
    caricato.stato === 'caricato'
      ? caricato.progetto
      : progettoVuoto(path.join(os.homedir(), 'Videos', 'Regia'))

  if (caricato.stato === 'illeggibile') {
    // Non si sovrascrive un progetto che non si e riusciti a leggere: potrebbe
    // essere il lavoro di un intero pomeriggio, e un bug nostro.
    throw new Error(
      `il file di progetto esiste ma non e leggibile (${caricato.motivo}). ` +
        'Spostalo o correggilo prima di riavviare Regia.',
    )
  }

  const libreria = new LibreriaSuoni(
    path.join(cartellaDati, 'suoni'),
    path.join(cartellaDati, 'cache'),
  )
  const esitoSuoni = await libreria.preparaTutti(progetto.suoni, progetto.audio)

  const motore = new MotoreRegia(progetto, archivio, libreria)
  for (const errore of esitoSuoni.errori) motore.diario('attenzione', errore.message)

  // Il Sottofondo di ogni Zona riparte da solo: il §3.9 chiede che riaprendo
  // l'app tutto torni com'era, e per una Zona "com'era" include cosa sta suonando.
  for (const z of progetto.zone) {
    if (!z.sottofondoId) continue
    try {
      await motore.esegui({ tipo: 'zona.sottofondo', zonaId: z.id, suonoId: z.sottofondoId })
    } catch (e) {
      motore.diario('attenzione', `Sottofondo della Zona "${z.nome}": ${(e as Error).message}`)
    }
  }

  const servitore = new Servitore(motore, { ...OPZIONI_PREDEFINITE, ...opzioni.servitore })
  const porta = await servitore.avvia()
  motore.diario('info', `Regia in ascolto sulla porta ${porta}`)

  return {
    porta,
    indirizzo: `http://127.0.0.1:${porta}/`,
    async ferma() {
      await servitore.ferma()
      await archivio.chiudi()
    },
  }
}

/** Utile per dimensionare i buffer da fuori senza reimportare il dominio. */
export { byteBlocco }
