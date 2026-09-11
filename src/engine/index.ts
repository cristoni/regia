/**
 * Il motore di Regia.
 *
 * Mette insieme i pezzi e li serve. Non importa niente di Electron, di proposito
 * (ADR 0004): si avvia da qui, dal guscio, o da uno script di collaudo, e in
 * tutti e tre i casi si comporta allo stesso modo.
 *
 * Qui dentro non c'e nessun mixer. Stanno tutti nel thread audio, dietro
 * `MotoreAudio`: e la conseguenza di una misura, non di un gusto. Sul thread
 * principale, sotto carico, lo scrittore restava indietro di oltre mezzo
 * secondo e rinunciava a pezzi di Flusso.
 *
 * E non c'e nemmeno nessuna decisione su *come* si fanno le cose: il ciclo di
 * vita di snapserver sta nel supervisore, le Telecamere nel loro gestore, la
 * registrazione nel registratore. Questo file e il posto dove il **dominio**
 * decide -- quali Suoni sono ammessi in una Zona, cosa vuol dire eliminare una
 * Zona, quando il progetto va salvato -- e null'altro.
 */
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'

import {
  byteBlocco,
  effettiDellaZona,
  latenzaAttesaMs,
  progettoVuoto,
  violazioni,
  zProgetto,
  zoneOrdinate,
  type Progetto,
  type Suono,
  type Telecamera,
  type Zona,
} from './dominio/progetto.js'
import { ArchivioProgetto } from './progetto/archivio.js'
import { LibreriaSuoni } from './audio/libreria.js'
import { MotoreAudio } from './audio/motore-audio.js'
import { AnteprimaSuoni } from './audio/anteprima.js'
import { SUONO_IDENTIFICA, SUONO_PROVA, scriviSegnali } from './audio/segnali.js'
import { flussiDi, generaConfigurazione } from './snapcast/configurazione.js'
import {
  FLUSSO_NON_ASSEGNATI,
  SupervisoreSnapcast,
  chiaveFlussoDi,
} from './snapcast/supervisore.js'
import { GestoreTelecamere } from './telecamere/gestore.js'
import { Registratore, type FileRegistrato } from './registrazione/registratore.js'
import { Ambiente } from './ambiente.js'
import { apriCartella } from './apri-cartella.js'
import { vigilaAnello } from './anello.js'
import { DpapiNonDisponibile, cifra, decifra } from './sicurezza/dpapi.js'
import { OPZIONI_PREDEFINITE, Servitore, type Motore, type OpzioniServitore } from './api/servitore.js'
import type { Comando, Evento, Livello, Stato, ZonaViva } from './api/protocollo.js'

export interface OpzioniMotore {
  /** Cartella dei dati di Regia: progetto, suoni, cache. */
  readonly cartellaDati: string
  readonly servitore: Partial<OpzioniServitore>
  /** Cartella dei file compilati dell'interfaccia. `null` = solo API. */
  readonly cartellaUi: string | null
}

export interface MotoreAvviato {
  readonly indirizzo: string
  readonly porta: number
  ferma(): Promise<void>
}

/**
 * Cio che il motore usa delle sue tre dipendenze -- e niente di piu.
 *
 * Tipi strutturali (`Pick`) invece delle classi concrete, e non per gusto: le
 * classi hanno campi privati, quindi un finto non le puo soddisfare, e il test
 * di regressione sull'importazione ha bisogno di un thread audio che fallisca
 * a comando -- un caso che contro il worker vero non si riesce a costruire.
 */
export type ArchivioDelMotore = Pick<ArchivioProgetto, 'programmaSalvataggio'>
export type LibreriaDelMotore = Pick<LibreriaSuoni, 'importa' | 'assicura' | 'assicuraTutti'>
export type AudioDelMotore = Pick<
  MotoreAudio,
  | 'configura' | 'suona' | 'sottofondo' | 'volume' | 'stopZona' | 'stopTutto'
  | 'caricaSuono' | 'scaricaSuono' | 'statoDi'
>

/**
 * Quanto si aspetta prima di riavviare il server dopo un cambio di Zone.
 *
 * Rinominare una Zona cambia l'identificativo del suo stream (ADR 0005) e quindi
 * la configurazione di snapserver. Senza attesa, ogni lettera digitata nel campo
 * "nome" riavvierebbe il server: si aspetta che l'Operatore abbia finito.
 */
const ATTESA_RICONFIGURAZIONE_MS = 900

/** Quante righe di diario si tengono per l'esportazione (§3.10). */
const RIGHE_DIARIO = 2000

export class MotoreRegia implements Motore {
  private progetto: Progetto
  /** I Suoni che il thread audio ha confermato di avere in memoria. */
  private readonly suoniPronti = new Map<string, number>()
  private readonly durateSegnali = new Map<string, number>()
  private readonly ascoltatoriVideo: ((id: string, chiave: boolean, d: Uint8Array) => void)[] = []
  private readonly ascoltatoriDiario: ((e: Extract<Evento, { tipo: 'diario' }>) => void)[] = []
  private readonly avvisi: { livello: Livello; testo: string }[] = []
  private readonly righeDiario: Extract<Evento, { tipo: 'diario' }>[] = []
  /** Password decifrate, tenute solo in memoria: sul disco stanno cifrate (§6). */
  private readonly passwordInChiaro = new Map<string, string>()
  private prossimoId = 1
  private riconfigurazione: NodeJS.Timeout | null = null
  /**
   * Dove gli scrittori aprono le socket delle sorgenti.
   *
   * Parte da `127.0.0.1` perche finche non si sa dov'e la Sede e l'unica cosa
   * che si puo provare. Su Linux e gia la risposta definitiva. Su Windows
   * **non e l'indirizzo giusto**: in `networkingMode=NAT` gli inoltri di WSL
   * su `127.0.0.1` sopravvivono al processo che ascoltava, accettano
   * connessioni e non leggono niente. Appena il supervisore sa l'indirizzo
   * vero, si riconfigura.
   */
  private hostFlussi = '127.0.0.1'

  readonly server: SupervisoreSnapcast
  readonly telecamere: GestoreTelecamere
  readonly registratore: Registratore
  readonly ambiente = new Ambiente()
  /**
   * L'anteprima riferisce al Diario, e senza questo aggancio sarebbe muta.
   *
   * `suona()` risponde quando il suono e **cominciato** -- aspettare la fine
   * terrebbe in piedi la richiesta per tutta la durata del Suono -- quindi cio
   * che va storto dopo (il lettore che non parte, che non trova un server
   * audio, che esce con un errore) arriva troppo tardi per l'esito del comando.
   * Senza il Diario, l'Operatore preme "ascolta", non sente niente, e non ha
   * modo di sapere se e rotto il file, la scheda audio o il pulsante.
   */
  private readonly anteprima = new AnteprimaSuoni((livello, testo) =>
    this.diario(livello, testo),
  )

  constructor(
    progetto: Progetto,
    private readonly archivio: ArchivioDelMotore,
    private readonly libreria: LibreriaDelMotore,
    private readonly audio: AudioDelMotore,
  ) {
    this.progetto = progetto
    // Gli identificativi ripartono da oltre il massimo gia nel file: un
    // progetto riaperto ha gia `z1`..`z8`, e ricominciare da uno li duplicherebbe.
    this.prossimoId = prossimoIdLibero(progetto)

    this.server = new SupervisoreSnapcast({
      progetto: () => this.progetto,
      suDiario: (l, t) => this.diario(l, t),
      suClientNuovo: (id, nome) => this.accogliAltoparlante(id, nome),
      suonaIdentifica: (chiave) => {
        this.audio.suona([chiave], SUONO_IDENTIFICA, 1, false)
        return this.durateSegnali.get(SUONO_IDENTIFICA) ?? 600
      },
      suIndirizzoFlussi: (ip) => {
        if (ip === this.hostFlussi) return
        this.hostFlussi = ip
        this.diario('info', `Le sorgenti audio vanno a ${ip}.`)
        this.riconfiguraAudio()
      },
    })

    this.telecamere = new GestoreTelecamere({
      progetto: () => this.progetto,
      suDiario: (l, t) => this.diario(l, t),
      suFotogramma: (id, chiave, dati) => {
        for (const a of this.ascoltatoriVideo) a(id, chiave, dati)
      },
      password: (t) => this.password(t),
    })

    this.registratore = new Registratore({
      progetto: () => this.progetto,
      suDiario: (l, t) => this.diario(l, t),
      telecamere: this.telecamere,
    })

    this.riconfiguraAudio()
  }

  // ------------------------------------------------------------- lettura

  istantanea(): Progetto {
    return this.progetto
  }

  private get osservati() {
    return this.server.clienti()
  }
  private get identificazioni() {
    return this.server.inIdentificazione()
  }

  stato(): Stato {
    const a = this.progetto.audio
    const assegnati = new Map<string, number>()
    const collegati = new Map<string, number>()
    for (const alt of this.progetto.altoparlanti) {
      if (!alt.zonaId) continue
      assegnati.set(alt.zonaId, (assegnati.get(alt.zonaId) ?? 0) + 1)
      if (this.osservati.get(alt.id)?.collegato) {
        collegati.set(alt.zonaId, (collegati.get(alt.zonaId) ?? 0) + 1)
      }
    }
    const flussi = new Map(flussiDi(this.progetto).map((f) => [f.zonaId, f.id]))

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
        altoparlantiCollegati: collegati.get(z.id) ?? 0,
        altoparlantiTotali: assegnati.get(z.id) ?? 0,
        telecamereCollegate: this.progetto.telecamere.filter(
          (t) => t.zonaId === z.id && this.telecamere.viva(t.id)?.raggiungibile,
        ).length,
        telecamereTotali: this.progetto.telecamere.filter((t) => t.zonaId === z.id).length,
        ritardoMsAlSecondo: f?.ritardoMsAlSecondo ?? 0,
        suoniAbilitati: z.suoniAbilitati,
        flusso: flussi.get(z.id) ?? '',
        scrittore: f?.scrittore ?? 'fermo',
        scartoMs: f?.scartoMs ?? 0,
      }
    })

    const reg = this.registratore.stato()
    return {
      progettoNome: this.progetto.nome,
      server: this.server.stato(),
      zone,
      altoparlanti: this.progetto.altoparlanti.map((x) => {
        const o = this.osservati.get(x.id)
        return {
          id: x.id, nome: x.nome, zonaId: x.zonaId, collegato: o?.collegato ?? false,
          volume: x.volume, muto: x.muto, latenzaMs: x.latenzaMs,
          indirizzo: o?.indirizzo ?? null, vistoIl: x.vistoIl,
          inIdentificazione: this.identificazioni.has(x.id),
        }
      }),
      telecamere: this.progetto.telecamere.map((t) => {
        const v = this.telecamere.viva(t.id)
        return {
          id: t.id, nome: t.nome, zonaId: t.zonaId, host: t.host, porta: t.porta,
          raggiungibile: v?.raggiungibile ?? false,
          batteria: v?.batteria ?? null,
          segnale: v?.segnale ?? null,
          inRegistrazione: reg.telecamere.includes(t.id),
          fpsAnteprima: v?.fpsAnteprima ?? null,
          vistoIl: v?.vistoIl ?? null,
          https: t.https,
          utente: t.utente,
          conPassword: t.passwordCifrata !== null,
          dettagli: v?.dettagli ?? null,
          inIdentificazione: v?.inIdentificazione ?? false,
        }
      }),
      suoni: [...this.progetto.suoni]
        .sort((x, y) => x.ordine - y.ordine)
        .map((s) => ({
          id: s.id, nome: s.nome, colore: s.colore, categoria: s.categoria,
          durataMs: s.durataMs ?? this.suoniPronti.get(s.id) ?? null,
          tastoRapido: s.tastoRapido,
          pronto: this.suoniPronti.has(s.id),
          guadagno: s.guadagno,
        })),
      registrazione: {
        attive: reg.telecamere.length,
        spazioLiberoGb: Math.round(reg.spazioLiberoGb * 10) / 10,
        sottoAvviso: reg.spazioLiberoGb < this.progetto.registrazione.avvisoSpazioGb,
        bloccata: reg.spazioLiberoGb < this.progetto.registrazione.bloccoSpazioGb,
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
      impostazioni: {
        audio: this.progetto.audio,
        server: this.progetto.server,
        registrazione: this.progetto.registrazione,
      },
      ambiente: this.ambiente.ultimo(),
      latenzaAttesaMs: latenzaAttesaMs(a),
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

  diario(livello: Livello, testo: string): void {
    const e = { tipo: 'diario', quando: new Date().toISOString(), livello, testo } as const
    this.righeDiario.push(e)
    if (this.righeDiario.length > RIGHE_DIARIO) this.righeDiario.shift()
    for (const a of this.ascoltatoriDiario) a(e)
  }

  /** Le Telecamere di cui almeno un'interfaccia collegata vuole i fotogrammi. */
  interessatoVideo(telecamere: readonly string[]): void {
    this.telecamere.vuoleAnteprima(telecamere)
  }

  /**
   * L'ultimo fotogramma chiave, per chi si collega adesso.
   *
   * La Telecamera emette un IDR ogni secondo e non e configurabile: senza
   * questa cache, ogni interfaccia che apre la griglia vede nero fino a un
   * secondo per cella. Ogni IDR e preceduto da SPS e PPS, quindi quello che
   * esce di qui e autonomamente decodificabile.
   */
  ultimoIdr(telecameraId: string): Uint8Array | null {
    return this.telecamere.ultimoIdr(telecameraId)
  }

  elencoRegistrazioni(): Promise<FileRegistrato[]> {
    return this.registratore.elenco()
  }

  /**
   * Un Suono caricato dall'interfaccia come byte, non come percorso.
   *
   * L'interfaccia e una pagina web: in Electron con `sandbox: true` un
   * `<input type=file>` non da il percorso vero del file, e il tablet della
   * Fase 3 non ha nemmeno lo stesso disco. I byte funzionano da tutti e tre i
   * posti, e passano dalla stessa strada di un'importazione da percorso --
   * si scrive un file temporaneo e si riusa `suono.importa`.
   */
  async importaSuono(nome: string, dati: Buffer): Promise<void> {
    const sicuro = path.basename(nome).replace(/[^\p{L}\p{N} ._-]+/gu, '_').slice(0, 80) || 'suono'
    // Il file temporaneo si chiama come l'originale, e a essere unica e la
    // **cartella**: il nome del Suono nasce dal nome del file, e un pulsante
    // che dice "regia-import-1788957434051-catene" non lo legge nessuno al buio.
    const cartella = await fs.mkdtemp(path.join(os.tmpdir(), 'regia-import-'))
    const temporaneo = path.join(cartella, sicuro)
    await fs.writeFile(temporaneo, dati)
    try {
      await this.esegui({ tipo: 'suono.importa', percorsi: [temporaneo] })
    } finally {
      await fs.rm(cartella, { recursive: true, force: true }).catch(() => {})
    }
  }

  async esportaProgetto(): Promise<string> {
    return JSON.stringify(
      {
        ...this.progetto,
        telecamere: this.progetto.telecamere.map((t) => ({ ...t, passwordCifrata: null })),
      },
      null,
      2,
    )
  }

  async importaProgettoDaTesto(testo: string): Promise<void> {
    const temporaneo = path.join(os.tmpdir(), `regia-progetto-${Date.now()}.json`)
    await fs.writeFile(temporaneo, testo, 'utf8')
    try {
      await this.importa(temporaneo)
      this.archivio.programmaSalvataggio(this.progetto)
    } finally {
      await fs.rm(temporaneo, { force: true }).catch(() => {})
    }
  }

  // -------------------------------------------------------------- comandi

  async esegui(c: Comando): Promise<void> {
    switch (c.tipo) {
      // ------------------------------------------------------------- Zone
      case 'zona.crea': {
        if (this.progetto.zone.length >= 12) {
          throw new Error('dodici Zone sono il massimo (§3.1)')
        }
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
        this.riconfiguraTutto()
        this.diario('info', `Creata la Zona "${z.nome}"`)
        break
      }
      case 'zona.rinomina':
        this.zona(c.zonaId).nome = c.nome
        // Il nome della Zona *e* l'identificativo del suo stream Snapcast
        // (ADR 0005): rinominarla cambia la configurazione del server.
        this.riconfiguraTutto()
        break
      case 'zona.colore':
        this.zona(c.zonaId).colore = c.colore
        break
      case 'zona.duplica': {
        const o = this.zona(c.zonaId)
        const z: Zona = { ...o, id: this.nuovoId('z'), nome: `${o.nome} (copia)`, ordine: this.progetto.zone.length }
        this.progetto.zone.push(z)
        this.riconfiguraTutto()
        break
      }
      case 'zona.elimina': {
        const z = this.zona(c.zonaId)
        this.progetto.zone = this.progetto.zone.filter((x) => x.id !== c.zonaId)
        // I dispositivi non si cancellano: tornano non assegnati, che e lo stato
        // normale di un telefono acceso ma non ancora messo in una stanza.
        for (const a of this.progetto.altoparlanti) if (a.zonaId === c.zonaId) a.zonaId = null
        for (const t of this.progetto.telecamere) if (t.zonaId === c.zonaId) t.zonaId = null
        this.riconfiguraTutto()
        this.diario('info', `Eliminata la Zona "${z.nome}"`)
        break
      }
      case 'zona.riordina':
        for (const [i, id] of c.ordine.entries()) this.zona(id).ordine = i
        // L'ordine decide le porte delle sorgenti: riordinare le rimescola.
        this.riconfiguraTutto()
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

      // ---------------------------------------------------- riproduzione
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
      case 'zona.provaAudio': {
        const z = this.zona(c.zonaId)
        this.audio.suona([z.id], SUONO_PROVA, 1, false)
        this.diario('info', `Suono di prova nella Zona "${z.nome}"`)
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

      // ------------------------------------------------------------ Suoni
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
        if (c.tastoRapido !== undefined) s.tastoRapido = c.tastoRapido
        if (c.guadagno !== undefined) {
          s.guadagno = c.guadagno
          // Un Sottofondo gia in corso non si riavvia per un cambio di volume:
          // si ridice al mixer con che guadagno mixarlo, e prosegue a meta.
          for (const z of this.progetto.zone) {
            if (z.sottofondoId === s.id) this.audio.sottofondo(z.id, s.id, s.guadagno)
          }
        }
        break
      }
      case 'suono.riordina':
        for (const [i, id] of c.ordine.entries()) this.suono(id).ordine = i
        break
      case 'suono.anteprima': {
        const s = this.suono(c.suonoId)
        const esito = await this.libreria.assicura(s, this.progetto.audio)
        await this.anteprima.suona(esito.percorso, this.progetto.audio)
        break
      }

      // ---------------------------------------------------- Altoparlanti
      case 'altoparlante.assegna': {
        const a = this.altoparlante(c.clientId)
        if (c.zonaId) this.zona(c.zonaId)
        a.zonaId = c.zonaId
        // Non si aspetta la passata periodica: chi assegna un Altoparlante sta
        // guardando il telefono, e vuole sentirlo suonare adesso.
        void this.server.ricollega()
        break
      }
      case 'altoparlante.rinomina': {
        const a = this.altoparlante(c.clientId)
        a.nome = c.nome
        // Il nome si scrive anche sul server, cosi e persistente e lo si vede
        // da Snapdroid; ma la verita resta il file di progetto (ADR 0005).
        await this.server.rinominaClient(c.clientId, c.nome).catch(() => {})
        break
      }
      case 'altoparlante.volume':
        this.altoparlante(c.clientId).volume = c.volume
        void this.server.ricollega()
        break
      case 'altoparlante.muto':
        this.altoparlante(c.clientId).muto = c.muto
        void this.server.ricollega()
        break
      case 'altoparlante.latenza':
        this.altoparlante(c.clientId).latenzaMs = c.latenzaMs
        void this.server.ricollega()
        break
      case 'altoparlante.identifica':
        await this.server.identifica(c.clientId)
        break
      case 'altoparlante.dimentica': {
        const a = this.altoparlante(c.clientId)
        this.progetto.altoparlanti = this.progetto.altoparlanti.filter((x) => x.id !== c.clientId)
        await this.server.dimenticaClient(c.clientId).catch(() => {})
        this.diario('info', `Dimenticato l'Altoparlante "${a.nome}"`)
        break
      }

      // ------------------------------------------------------ Telecamere
      case 'telecamera.aggiungi': {
        const t: Telecamera = {
          id: this.nuovoId('t'),
          nome: `Telecamera ${this.progetto.telecamere.length + 1}`,
          host: c.host,
          porta: c.porta,
          https: c.https,
          utente: c.utente,
          passwordCifrata: null,
          zonaId: null,
        }
        if (c.password) this.impostaPassword(t, c.password)
        this.progetto.telecamere.push(t)
        this.telecamere.sincronizza()
        // Il preset si applica subito: `streaming_enabled` e persistente fra i
        // riavvii del telefono, quindi non si puo dare per acceso.
        this.telecamere
          .preparaTelecamera(t)
          .catch((e: unknown) =>
            this.diario('attenzione', `"${t.nome}" aggiunta ma non risponde: ${(e as Error).message}`),
          )
        this.diario('info', `Aggiunta la Telecamera ${t.host}:${t.porta}`)
        break
      }
      case 'telecamera.rinomina':
        this.telecamera(c.telecameraId).nome = c.nome
        break
      case 'telecamera.assegna': {
        const t = this.telecamera(c.telecameraId)
        if (c.zonaId) this.zona(c.zonaId)
        t.zonaId = c.zonaId
        break
      }
      case 'telecamera.identifica':
        await this.telecamere.identifica(c.telecameraId)
        break
      case 'telecamera.rimuovi': {
        const t = this.telecamera(c.telecameraId)
        await this.registratore.spegni(c.telecameraId)
        this.progetto.telecamere = this.progetto.telecamere.filter((x) => x.id !== c.telecameraId)
        this.passwordInChiaro.delete(c.telecameraId)
        this.telecamere.sincronizza()
        this.diario('info', `Rimossa la Telecamera "${t.nome}"`)
        break
      }
      case 'telecamera.controlla':
        await this.telecamere.controlla(c.telecameraId, c.parametri)
        break
      case 'telecamera.scansiona': {
        const trovate = await this.telecamere.scansiona(c.sottorete)
        const gia = new Set(this.progetto.telecamere.map((t) => `${t.host}:${t.porta}`))
        for (const t of trovate) {
          if (gia.has(`${t.host}:${t.porta}`)) continue
          const nuova: Telecamera = {
            id: this.nuovoId('t'),
            nome: t.nome ?? `Telecamera ${t.host.split('.').pop()}`,
            host: t.host, porta: t.porta, https: false,
            utente: null, passwordCifrata: null, zonaId: null,
          }
          this.progetto.telecamere.push(nuova)
        }
        this.telecamere.sincronizza()
        break
      }

      // ---------------------------------------------------- Registrazione
      case 'registrazione.avvia':
        await this.registratore.accendiMolte(this.telecamereDi(c.ambito))
        break
      case 'registrazione.ferma':
        await this.registratore.spegniMolte(this.telecamereDi(c.ambito))
        break
      case 'registrazione.apriCartella': {
        const cartella = this.progetto.registrazione.cartella
        await fs.mkdir(cartella, { recursive: true })
        // Il comando cambia col sistema e l'errore di avvio va ascoltato, o su
        // Linux un `xdg-open` che manca diventa un'eccezione non gestita.
        apriCartella(cartella, (motivo) => this.diario('attenzione', motivo))
        break
      }

      // --------------------------------------------------- server e rete
      case 'server.avvia':
        await this.server.avvia()
        break
      case 'server.ferma':
        await this.server.ferma()
        break
      case 'server.riavvia':
        await this.server.riavvia()
        break
      case 'ricollegaTutto':
        await this.server.ricollega()
        this.telecamere.sincronizza()
        this.diario('info', 'Ricollegamento forzato di Altoparlanti e Telecamere.')
        break
      case 'ambiente.controlla':
        await this.ambiente.controlla(
          this.progetto.server,
          generaConfigurazione(this.progetto).porte,
        )
        break

      // -------------------------------------- progetto e impostazioni
      case 'progetto.rinomina':
        this.progetto.nome = c.nome
        break
      case 'progetto.esporta':
        await this.esporta(c.percorso)
        break
      case 'progetto.importa':
        await this.importa(c.percorso)
        break

      case 'impostazioni.audio': {
        const a = this.progetto.audio
        if (c.bufferMs !== undefined) a.bufferMs = c.bufferMs
        if (c.codec !== undefined) a.codec = c.codec
        if (c.bloccoMs !== undefined) a.bloccoMs = c.bloccoMs
        if (c.dissolvenzaMs !== undefined) a.dissolvenzaMs = c.dissolvenzaMs
        if (c.anticipoMs !== undefined) a.anticipoMs = c.anticipoMs
        if (c.idleThresholdMs !== undefined) a.idleThresholdMs = c.idleThresholdMs
        if (c.portaBaseFlussi !== undefined) a.portaBaseFlussi = c.portaBaseFlussi
        this.riconfiguraTutto()
        this.diario(
          'attenzione',
          `Latenza attesa dal pulsante al suono: ${latenzaAttesaMs(a)} ms`,
        )
        break
      }
      case 'impostazioni.server': {
        const s = this.progetto.server
        if (c.distro !== undefined) s.distro = c.distro
        if (c.portaControllo !== undefined) s.portaControllo = c.portaControllo
        if (c.portaHttp !== undefined) s.portaHttp = c.portaHttp
        if (c.portaFlussoClient !== undefined) s.portaFlussoClient = c.portaFlussoClient
        this.riconfiguraTutto()
        break
      }
      case 'impostazioni.registrazione': {
        const r = this.progetto.registrazione
        if (c.cartella !== undefined) r.cartella = c.cartella
        if (c.minutiSegmento !== undefined) r.minutiSegmento = c.minutiSegmento
        if (c.conAudio !== undefined) r.conAudio = c.conAudio
        if (c.avvisoSpazioGb !== undefined) r.avvisoSpazioGb = c.avvisoSpazioGb
        if (c.bloccoSpazioGb !== undefined) r.bloccoSpazioGb = c.bloccoSpazioGb
        break
      }
      case 'diario.esporta': {
        const righe = this.righeDiario.map((r) => `${r.quando}\t${r.livello}\t${r.testo}`)
        await fs.writeFile(c.percorso, righe.join('\r\n') + '\r\n', 'utf8')
        this.diario('info', `Diario esportato in ${c.percorso}`)
        break
      }

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
   * Ridice al thread audio quali Flussi servire, e al server che la sua
   * configurazione e cambiata.
   *
   * Il thread audio si riconfigura subito -- ricostruire mixer e socket costa
   * millisecondi. Il server no: riavviarlo sono due secondi di silenzio, e
   * questo comando arriva a ogni lettera digitata nel nome di una Zona. Si
   * aspetta che l'Operatore abbia finito di scrivere.
   */
  private riconfiguraTutto(): void {
    this.riconfiguraAudio()
    // Da qui al riavvio il progetto e gia quello nuovo e il server e ancora
    // quello vecchio: il supervisore deve saperlo, o riconcilierebbe contro
    // stream che non esistono ancora.
    this.server.annunciaRiconfigurazione()
    if (this.riconfigurazione) clearTimeout(this.riconfigurazione)
    this.riconfigurazione = setTimeout(() => {
      this.riconfigurazione = null
      void this.server.riconfigura().catch((e: unknown) =>
        this.diario('attenzione', `Riconfigurazione del server fallita: ${(e as Error).message}`),
      )
    }, ATTESA_RICONFIGURAZIONE_MS)
    this.riconfigurazione.unref?.()
  }

  private riconfiguraAudio(): void {
    this.audio.configura(
      this.hostFlussi,
      this.progetto.audio,
      flussiDi(this.progetto).map((f) => ({
        id: f.id,
        // Il Flusso dei non assegnati ha bisogno di un nome per essere
        // indirizzato: Identifica ci scrive dentro, e senza un mixer vivo la
        // `async_read` di snapserver su quella socket resta pendente.
        zonaId: chiaveFlussoDi(f.zonaId),
        porta: f.porta,
        volume: f.zonaId ? (this.progetto.zone.find((z) => z.id === f.zonaId)?.volume ?? 1) : 1,
      })),
    )
  }

  /**
   * Assicura i `.pcm` di tutta la libreria, li fa caricare al thread audio e
   * riavvia i Sottofondi delle Zone.
   *
   * E la stessa strada per l'avvio (§3.9: riaprendo l'app tutto torna com'era,
   * Sottofondo compreso) e per `progetto.importa`, con la stessa semantica: un
   * Suono che non si decodifica o non si carica degrada a riga di Diario e
   * resta "non pronto", senza fermare gli altri. Prima erano due copie, e
   * quella dell'importazione esplodeva a meta -- col progetto gia sostituito e
   * nessun rollback possibile.
   */
  async caricaSuoniEAvviaSottofondi(): Promise<void> {
    const esito = await this.libreria.assicuraTutti(this.progetto.suoni, this.progetto.audio)
    for (const errore of esito.errori) this.diario('attenzione', errore.message)
    for (const { suono, percorso, durataMs } of esito.pronti) {
      suono.durataMs = durataMs
      try {
        await this.audio.caricaSuono(suono.id, percorso)
        this.suoniPronti.set(suono.id, durataMs)
      } catch (e) {
        this.diario('attenzione', `Suono "${suono.nome}" non caricato: ${(e as Error).message}`)
      }
    }
    // Il Sottofondo riparte solo se il suo Suono e davvero in memoria ADESSO:
    // il vincolo su `suoniPronti` e cio che impedisce di far suonare campioni
    // rimasti nella cache del thread audio da un progetto precedente.
    for (const z of this.progetto.zone) {
      if (!z.sottofondoId || !this.suoniPronti.has(z.sottofondoId)) continue
      const s = this.progetto.suoni.find((x) => x.id === z.sottofondoId)
      if (s) this.audio.sottofondo(z.id, s.id, s.guadagno)
    }
  }

  segnaSegnale(id: string, durataMs: number): void {
    this.durateSegnali.set(id, durataMs)
  }

  /**
   * Un telefono che il server vede e che il progetto non conosce.
   *
   * Entra come non assegnato, che e lo stato normale a meta Setup e non un
   * errore: la lista si riempie da sola man mano che i telefoni si collegano
   * (§3.8, passo 4), e l'Operatore li mette nelle Zone con Identifica.
   */
  private accogliAltoparlante(clientId: string, nome: string): void {
    if (this.progetto.altoparlanti.some((a) => a.id === clientId)) return
    this.progetto.altoparlanti.push({
      id: clientId,
      nome: nome.slice(0, 40) || 'Altoparlante',
      zonaId: null,
      volume: 1,
      muto: false,
      latenzaMs: 0,
      vistoIl: new Date().toISOString(),
    })
    this.diario('info', `Nuovo Altoparlante: "${nome}". E non assegnato.`)
    this.archivio.programmaSalvataggio(this.progetto)
  }

  private telecamereDi(ambito: Extract<Comando, { tipo: 'registrazione.avvia' }>['ambito']): string[] {
    switch (ambito.su) {
      case 'telecamera':
        this.telecamera(ambito.telecameraId)
        return [ambito.telecameraId]
      case 'zona':
        this.zona(ambito.zonaId)
        return this.progetto.telecamere.filter((t) => t.zonaId === ambito.zonaId).map((t) => t.id)
      case 'tutto':
        return this.progetto.telecamere.map((t) => t.id)
    }
  }

  // ------------------------------------------------------------ password

  private impostaPassword(t: Telecamera, password: string): void {
    this.passwordInChiaro.set(t.id, password)
    try {
      t.passwordCifrata = cifra(password)
    } catch (e) {
      // §6: cifrate con DPAPI o non salvate. Non si ripiega su base64.
      t.passwordCifrata = null
      this.diario('attenzione', (e as DpapiNonDisponibile).message)
    }
  }

  /**
   * La password in chiaro di una Telecamera, decifrandola una volta sola.
   *
   * ⚠️ **Anche il fallimento si ricorda, e questa e la parte che conta.** Questa
   * funzione non sta in un posto tranquillo: `GestoreTelecamere` interroga tutte
   * le Telecamere ogni tre secondi, e ogni giro passa di qui. Ricordando solo i
   * successi, una password che non si decifra scriveva una riga di Diario per
   * Telecamera **ogni tre secondi, per sempre** -- con sei Telecamere il Diario
   * intero (2000 righe) si riscrive in un quarto d'ora, e ci si perde dentro
   * tutto il resto.
   *
   * Non e un caso di scuola: su Linux DPAPI non esiste, quindi `decifra` si
   * rifiuta *sempre*, e basta aprire su Linux un progetto preparato su Windows.
   * Il rifiuto e giusto (§6: cifrate con DPAPI o non salvate); dirlo mille volte
   * no. Si dice una volta per Telecamera, e le volte dopo si tace.
   *
   * ⚠️ **La rinuncia e permanente anche su Windows, ed e una scelta.** Li DPAPI
   * c'e, quindi il fallimento non parla del sistema ma di *quel* segreto: una
   * password cifrata da un altro utente o su un altro PC non si decifrera mai,
   * perche `CurrentUser` la lega a chi ha fatto il Setup. Riprovare ogni tre
   * secondi vorrebbe dire un processo PowerShell da mezzo secondo ogni tre
   * secondi, per sempre, per una risposta che non cambiera.
   *
   * Il prezzo lo paga il caso raro: un PowerShell che va in timeout sotto carico
   * e recuperabile, e qui viene trattato come definitivo. Non resta bloccato --
   * riscrivere la password in Impostazioni sovrascrive questa memoria (vedi
   * `impostaPassword`), e cosi fa un riavvio di Regia -- ma va saputo, ed e il
   * motivo per cui il messaggio dice all'Operatore cosa fare invece di limitarsi
   * a constatare.
   */
  private password(t: Telecamera): string | null {
    const inMemoria = this.passwordInChiaro.get(t.id)
    if (inMemoria !== undefined) return inMemoria || null
    if (!t.passwordCifrata) return null
    try {
      const chiara = decifra(t.passwordCifrata)
      this.passwordInChiaro.set(t.id, chiara)
      return chiara
    } catch (e) {
      // La stringa vuota e la memoria del fallimento: al giro dopo esce dal
      // `inMemoria` qui sopra come `null`, senza riprovare e senza ridirlo.
      this.passwordInChiaro.set(t.id, '')
      this.diario(
        'attenzione',
        `Non riesco a decifrare la password di "${t.nome}": ${(e as Error).message} ` +
          'Riscrivila in Impostazioni se la Telecamera la richiede.',
      )
      return null
    }
  }

  // ------------------------------------------------------ esporta/importa

  /**
   * Esporta il progetto per riusarlo in un altro evento (§3.9).
   *
   * Le password non escono mai: sono cifrate con DPAPI legata a *questo* utente
   * su *questo* PC, quindi altrove sarebbero comunque illeggibili -- e un file
   * che le contenesse sarebbe un file da trattare con cura, che e esattamente
   * cio che nessuno fa con un file di configurazione.
   */
  private async esporta(percorso: string): Promise<void> {
    await fs.writeFile(percorso, await this.esportaProgetto(), 'utf8')
    this.diario('info', `Progetto esportato in ${percorso}`)
  }

  private async importa(percorso: string): Promise<void> {
    const testo = await fs.readFile(percorso, 'utf8')
    const letto = zProgetto.safeParse(JSON.parse(testo))
    if (!letto.success) {
      throw new Error(
        `il file non e un progetto di Regia: ${letto.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`,
      )
    }
    const rotture = violazioni(letto.data)
    if (rotture.length > 0) {
      throw new Error(`il progetto e incoerente: ${rotture[0]!.dove} — ${rotture[0]!.problema}`)
    }

    await this.registratore.chiudi()
    // I Suoni del progetto vecchio si scaricano dal thread audio PRIMA di
    // caricare i nuovi. Non e pulizia: se il progetto nuovo riusa un id e il
    // suo file non si carica, il mixer ritroverebbe in cache i campioni vecchi
    // e un Sottofondo partirebbe con l'audio del progetto sbagliato.
    for (const id of this.suoniPronti.keys()) this.audio.scaricaSuono(id)
    this.progetto = letto.data
    this.passwordInChiaro.clear()
    this.suoniPronti.clear()
    // Gli identificativi del file importato possono arrivare fin dove vogliono:
    // il contatore riparte oltre il massimo, o il prossimo id collidera.
    this.prossimoId = prossimoIdLibero(this.progetto)
    this.riconfiguraTutto()
    this.telecamere.sincronizza()

    await this.caricaSuoniEAvviaSottofondi()
    this.diario('info', `Progetto "${this.progetto.nome}" importato da ${percorso}`)
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
  private telecamera(id: string): Telecamera {
    const t = this.progetto.telecamere.find((x) => x.id === id)
    if (!t) throw new Error(`Telecamera inesistente: ${id}`)
    return t
  }

  async chiudi(): Promise<void> {
    if (this.riconfigurazione) clearTimeout(this.riconfigurazione)
    await this.anteprima.ferma()
    await this.registratore.chiudi()
    await this.telecamere.chiudi()
    // Il server audio **non** si spegne: e staccato con `setsid` apposta per
    // sopravvivere alla chiusura di Regia, e riaprendo l'app se lo ritrova gia
    // acceso invece di ricomprarsi due secondi di silenzio.
    await this.server.chiudi()
  }
}

/**
 * Il primo identificativo che nessuno usa.
 *
 * Gli id sono `z1`, `s7`, `t3`: un contatore solo per tutti i prefissi. Dopo
 * un'importazione va portato oltre il massimo gia presente, o il primo Suono
 * aggiunto prenderebbe l'identificativo di una Zona esistente.
 */
export function prossimoIdLibero(p: Progetto): number {
  let massimo = 0
  for (const id of [
    ...p.zone.map((x) => x.id),
    ...p.suoni.map((x) => x.id),
    ...p.telecamere.map((x) => x.id),
  ]) {
    const n = /^[a-z](\d+)$/.exec(id)
    if (n) massimo = Math.max(massimo, Number(n[1]))
  }
  return massimo + 1
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

  const cartellaCache = path.join(cartellaDati, 'cache')
  const libreria = new LibreriaSuoni(path.join(cartellaDati, 'suoni'), cartellaCache)

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
  // tiene in memoria un solo campione: legge il thread audio, dal file. La
  // stessa passata riavvia i Sottofondi: il §3.9 chiede che riaprendo l'app
  // tutto torni com'era, e per una Zona "com'era" include cosa sta suonando.
  await motore.caricaSuoniEAvviaSottofondi()

  // I due segnali che Regia si fabbrica da sola: Identifica e il test audio di
  // Zona. Non stanno nella libreria -- non sono Suoni del dominio -- ma per il
  // mixer sono Suoni come gli altri, e questo e cio che li rende semplici.
  for (const s of await scriviSegnali(cartellaCache, progetto.audio)) {
    try {
      await audio.caricaSuono(s.id, s.percorso)
      motore.segnaSegnale(s.id, s.durataMs)
    } catch (e) {
      motore.diario('attenzione', `Segnale "${s.id}" non caricato: ${(e as Error).message}`)
    }
  }

  // Il Flusso parte subito, anche se snapserver non c'e ancora: gli scrittori
  // riprovano finche non lo trovano, e il §4.3 vuole che quando c'e non ci sia
  // mai un istante di silenzio non prodotto da noi.
  audio.avvia()

  motore.telecamere.avvia()
  motore.registratore.avvia()

  // Il server audio: prima si prova ad **adottarne** uno gia acceso. Con
  // `setsid` sopravvive alla chiusura di Regia, e riavviarlo per abitudine
  // sarebbe due secondi di silenzio che nessuno ha chiesto.
  // L'indirizzo dei Flussi si cerca **prima** di qualunque altra cosa: e dove
  // gli scrittori devono aprire le socket, e su Windows partire da `127.0.0.1`
  // per qualche secondo significa aprirle su un inoltro di WSL che non legge.
  void motore.server
    .aggiornaIndirizzoFlussi()
    .catch(() => null)
    .then(() => motore?.server.adotta())
    .then((trovato) => {
      if (trovato) motore?.diario('info', 'Trovato un server audio gia acceso: adottato.')
    })
  void motore.ambiente
    .controlla(progetto.server, generaConfigurazione(progetto).porte)
    .catch(() => {})

  const servitore = new Servitore(motore, {
    ...OPZIONI_PREDEFINITE,
    ...(opzioni.cartellaUi !== undefined ? { cartellaUi: opzioni.cartellaUi } : {}),
    ...opzioni.servitore,
  })

  let porta: number
  try {
    porta = await servitore.avvia()
  } catch (e) {
    // Se la porta e occupata non si lascia in giro un thread audio che scrive
    // su tredici socket per sempre: si smonta tutto quello che si e acceso
    // prima di rilanciare l'errore.
    await motore.chiudi().catch(() => {})
    await audio.chiudi().catch(() => {})
    await archivio.chiudi().catch(() => {})
    throw e
  }
  motore.diario('info', `Regia in ascolto sulla porta ${porta}`)

  // Da qui in avanti il thread principale ha del lavoro vero da fare, e il
  // ponte di rete dipende da lui: se si ferma, si vuole leggerlo nel Diario
  // invece di dedurlo dai telefoni che si ricollegano.
  const smettiVigilanza = vigilaAnello((l, t) => motore?.diario(l, t))

  const vivo = motore
  return {
    porta,
    indirizzo: `http://127.0.0.1:${porta}/`,
    async ferma() {
      smettiVigilanza()
      await servitore.ferma()
      await vivo.chiudi()
      // Prima l'audio, poi il progetto: chiudere le socket in modo ordinato
      // richiede un attimo, e il salvataggio non ha fretta.
      await audio.chiudi()
      await archivio.chiudi()
    },
  }
}

/** Utile per dimensionare i buffer da fuori senza reimportare il dominio. */
export { byteBlocco, FLUSSO_NON_ASSEGNATI }
