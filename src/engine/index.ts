/**
 * Il motore di Regia.
 *
 * Mette insieme i pezzi e li serve. Non importa niente di Electron, di proposito
 * (ADR 0004): si avvia da qui, dal guscio, o da uno script di collaudo, e in
 * tutti e tre i casi si comporta allo stesso modo.
 *
 * Cosa e collegato oggi: progetto, Zone, libreria dei Suoni, e il **thread
 * audio** che tiene mixer e scrittori. Cosa non lo e ancora: la distro WSL, il
 * JSON-RPC verso snapserver, le Telecamere e la registrazione. Quei comandi
 * rispondono con un errore esplicito invece di far finta -- un motore che dice
 * "non ancora" e utile, uno che finge non lo e.
 *
 * Qui dentro non c'e nessun mixer. Stanno tutti nel thread audio, dietro
 * `MotoreAudio`: e la conseguenza di una misura, non di un gusto. Sul thread
 * principale, sotto carico, lo scrittore restava indietro di oltre mezzo
 * secondo e rinunciava a pezzi di Flusso.
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
import { MotoreAudio } from './audio/motore-audio.js'
import { flussiDi } from './snapcast/configurazione.js'
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
  /** I Suoni che il thread audio ha confermato di avere in memoria. */
  private readonly suoniPronti = new Map<string, number>()
  private readonly ascoltatoriVideo: ((id: string, chiave: boolean, d: Uint8Array) => void)[] = []
  private readonly ascoltatoriDiario: ((e: Extract<Evento, { tipo: 'diario' }>) => void)[] = []
  private readonly avvisi: { livello: 'info' | 'attenzione' | 'grave'; testo: string }[] = []
  private prossimoId = 1

  constructor(
    progetto: Progetto,
    private readonly archivio: ArchivioProgetto,
    private readonly libreria: LibreriaSuoni,
    private readonly audio: MotoreAudio,
  ) {
    this.progetto = progetto
    this.riconfiguraAudio()
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
      // Lo stato arriva dal thread audio a intervalli regolari: si legge cio
      // che e arrivato per ultimo, senza mai aspettare.
      const f = this.audio.statoDi(z.id)
      return {
        id: z.id,
        nome: z.nome,
        colore: z.colore,
        // Il volume vero e quello applicato nel mix, non quello nel progetto:
        // in un istante in cui il comando fosse per strada sarebbero diversi.
        volume: f?.volume ?? z.volume,
        sottofondoId: f?.sottofondoAttivo ? z.sottofondoId : null,
        // Con l'identificativo del Suono, non solo il conteggio: e cosi che
        // l'interfaccia sa quale pulsante illuminare (§5.2).
        effettiInCorso: f?.effetti ?? [],
        altoparlantiCollegati: 0,
        altoparlantiTotali: collegati.get(z.id) ?? 0,
        telecamereCollegate: 0,
        telecamereTotali: this.progetto.telecamere.filter((t) => t.zonaId === z.id).length,
        buchiMs: f?.buchiMs ?? 0,
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
        durataMs: s.durataMs ?? this.suoniPronti.get(s.id) ?? null,
        tastoRapido: s.tastoRapido,
        pronto: this.suoniPronti.has(s.id),
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
        this.riconfiguraAudio()
        this.diario('info', `Creata la Zona "${z.nome}"`)
        break
      }
      case 'zona.rinomina':
        this.zona(c.zonaId).nome = c.nome
        // Il nome della Zona *e* l'identificativo del suo stream Snapcast
        // (ADR 0005): rinominarla cambia la configurazione del server.
        this.riconfiguraAudio()
        break
      case 'zona.colore':
        this.zona(c.zonaId).colore = c.colore
        break
      case 'zona.duplica': {
        const o = this.zona(c.zonaId)
        const z: Zona = { ...o, id: this.nuovoId('z'), nome: `${o.nome} (copia)`, ordine: this.progetto.zone.length }
        this.progetto.zone.push(z)
        this.riconfiguraAudio()
        break
      }
      case 'zona.elimina': {
        const z = this.zona(c.zonaId)
        this.progetto.zone = this.progetto.zone.filter((x) => x.id !== c.zonaId)
        // I dispositivi non si cancellano: tornano non assegnati, che e lo stato
        // normale di un telefono acceso ma non ancora messo in una stanza.
        for (const a of this.progetto.altoparlanti) if (a.zonaId === c.zonaId) a.zonaId = null
        for (const t of this.progetto.telecamere) if (t.zonaId === c.zonaId) t.zonaId = null
        this.riconfiguraAudio()
        this.diario('info', `Eliminata la Zona "${z.nome}"`)
        break
      }
      case 'zona.riordina':
        for (const [i, id] of c.ordine.entries()) this.zona(id).ordine = i
        // L'ordine decide le porte delle sorgenti: riordinare le rimescola.
        this.riconfiguraAudio()
        break
      case 'zona.sottofondo': {
        const z = this.zona(c.zonaId)
        z.sottofondoId = c.suonoId
        if (c.suonoId === null) {
          this.audio.sottofondo(z.id, null, 1)
          break
        }
        const s = this.suono(c.suonoId)
        if (!this.suoniPronti.has(c.suonoId)) {
          throw new Error(`il Suono "${s.nome}" non e ancora pronto`)
        }
        this.audio.sottofondo(z.id, c.suonoId, s.guadagno)
        break
      }
      case 'zona.suoniAbilitati':
        this.zona(c.zonaId).suoniAbilitati = c.suoni
        break

      case 'zona.suona': {
        const s = this.suono(c.suonoId)
        if (!this.suoniPronti.has(c.suonoId)) {
          throw new Error(`il Suono "${s.nome}" non e ancora pronto`)
        }
        // Si convalida TUTTO prima di mandare qualunque cosa al thread audio:
        // meglio un rifiuto netto che l'urlo che parte in due stanze su tre.
        for (const zonaId of c.zone) {
          const z = this.zona(zonaId)
          const ammessi = effettiDellaZona(this.progetto, z)
          if (!ammessi.some((x) => x.id === c.suonoId)) {
            throw new Error(`"${s.nome}" non e abilitato nella Zona "${z.nome}"`)
          }
        }
        this.audio.suona(c.zone, c.suonoId, s.guadagno, c.esclusivo)
        break
      }
      case 'zona.volume': {
        this.zona(c.zonaId).volume = c.volume
        this.audio.volume(c.zonaId, c.volume)
        break
      }
      case 'zona.stop':
        this.zona(c.zonaId)
        this.audio.stopZona(c.zonaId)
        break
      case 'stopTutto':
        this.audio.stopTutto()
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
          const esito = await this.libreria.assicura(s, this.progetto.audio)
          s.durataMs = esito.durataMs
          // Si aspetta che il thread audio abbia davvero i campioni: quando
          // questo comando torna, il pulsante funziona.
          await this.audio.caricaSuono(s.id, esito.percorso)
          this.suoniPronti.set(s.id, esito.durataMs)
          this.diario('info', `Importato il Suono "${s.nome}"`)
        }
        break
      }
      case 'suono.elimina': {
        const s = this.suono(c.suonoId)
        this.progetto.suoni = this.progetto.suoni.filter((x) => x.id !== c.suonoId)
        this.libreria.dimentica(c.suonoId)
        this.suoniPronti.delete(c.suonoId)
        this.audio.scaricaSuono(c.suonoId)
        for (const z of this.progetto.zone) {
          if (z.sottofondoId === c.suonoId) {
            z.sottofondoId = null
            this.audio.sottofondo(z.id, null, 1)
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

  /**
   * Ridice al thread audio quali Flussi servire.
   *
   * Si chiama a ogni cambiamento che tocchi le Zone -- creazione, rinomina,
   * riordino, eliminazione -- perche ognuno di quelli cambia anche la
   * configurazione di snapserver (ADR 0005). Succede in Setup, dove ricostruire
   * mixer e socket non costa nulla.
   */
  private riconfiguraAudio(): void {
    this.audio.configura(
      this.progetto.audio,
      flussiDi(this.progetto).map((f) => ({
        id: f.id,
        zonaId: f.zonaId,
        porta: f.porta,
        volume: f.zonaId ? (this.progetto.zone.find((z) => z.id === f.zonaId)?.volume ?? 1) : 1,
      })),
    )
  }

  /** Il thread audio conferma di avere un Suono in memoria. */
  segnaSuonoPronto(suonoId: string, durataMs: number): void {
    this.suoniPronti.set(suonoId, durataMs)
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

  // Il motore si crea prima del thread audio, e il thread audio ha bisogno di
  // parlargli: si risolve con un rimando, non con un ordine di costruzione
  // acrobatico.
  let motore: MotoreRegia | null = null
  const audio = new MotoreAudio({
    suDiario: (livello, testo) => motore?.diario(livello, testo),
  })
  await audio.aspettaPronto()

  motore = new MotoreRegia(progetto, archivio, libreria, audio)

  // I Suoni si decodificano qui e si caricano LA'. Il thread principale non
  // tiene in memoria un solo campione: legge il thread audio, dal file.
  const esitoSuoni = await libreria.assicuraTutti(progetto.suoni, progetto.audio)
  for (const errore of esitoSuoni.errori) motore.diario('attenzione', errore.message)
  await Promise.all(
    esitoSuoni.pronti.map(async ({ suono, percorso, durataMs }) => {
      suono.durataMs = durataMs
      try {
        await audio.caricaSuono(suono.id, percorso)
        motore?.segnaSuonoPronto(suono.id, durataMs)
      } catch (e) {
        motore?.diario('attenzione', `Suono "${suono.nome}" non caricato: ${(e as Error).message}`)
      }
    }),
  )

  // Il Flusso parte subito, anche se snapserver non c'e ancora: gli scrittori
  // riprovano finche non lo trovano, e il §4.3 vuole che quando c'e non ci sia
  // mai un istante di silenzio non prodotto da noi.
  audio.avvia()

  // Il Sottofondo di ogni Zona riparte da solo: il §3.9 chiede che riaprendo
  // l'app tutto torni com'era, e per una Zona "com'era" include cosa sta suonando.
  for (const z of progetto.zone) {
    if (!z.sottofondoId) continue
    const suono = progetto.suoni.find((x) => x.id === z.sottofondoId)
    if (!suono) continue
    audio.sottofondo(z.id, suono.id, suono.guadagno)
  }

  const servitore = new Servitore(motore, { ...OPZIONI_PREDEFINITE, ...opzioni.servitore })
  const porta = await servitore.avvia()
  motore.diario('info', `Regia in ascolto sulla porta ${porta}`)

  return {
    porta,
    indirizzo: `http://127.0.0.1:${porta}/`,
    async ferma() {
      await servitore.ferma()
      // Prima l'audio, poi il progetto: chiudere le socket in modo ordinato
      // richiede un attimo, e il salvataggio non ha fretta.
      await audio.chiudi()
      await archivio.chiudi()
    },
  }
}

/** Utile per dimensionare i buffer da fuori senza reimportare il dominio. */
export { byteBlocco }
