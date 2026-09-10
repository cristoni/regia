/**
 * Le Telecamere viste dal motore: chi risponde, chi no, e chi sta mandando video.
 *
 * Due regole reggono tutto il file.
 *
 * **Una sola connessione per Telecamera, in totale.** Il §4.5 lo chiede, e
 * l'app del telefono ha un limite basso di client concorrenti. Quindi
 * `/video/h264` si apre una volta e i byte si sdoppiano qui dentro (ADR 0009):
 * agli ascoltatori dei fotogrammi -- le interfacce collegate -- e agli
 * ascoltatori dei byte grezzi, che oggi e solo ffmpeg quando registra.
 *
 * **Il flusso si apre solo se qualcuno lo guarda.** Sei Telecamere aperte in
 * permanenza sono 6-12 Mbit/s continui su una rete che sta gia portando 11
 * Mbit/s di PCM: la banda e il collo di bottiglia, non la CPU. Un'anteprima
 * chiusa e banda che torna agli Altoparlanti.
 *
 * Il polling di `/info.json`, invece, resta acceso sempre: e poche centinaia di
 * byte ogni tre secondi, ed e l'unico modo di accorgersi entro dieci secondi
 * che un telefono ha perso il Wi-Fi (§8.8).
 */
import type { Progetto, Telecamera } from '../dominio/progetto.js'
import type { TelecameraViva } from '../api/protocollo.js'
import { indirizziLocali, virtuale } from '../ambiente.js'
import { SpezzatoreAnnexB } from './annexb.js'
import {
  accendiStreaming,
  apriFlussoAudio,
  apriFlussoH264,
  comanda,
  leggiInfo,
  type AccessoTelecamera,
  type FlussoAperto,
} from './cliente.js'

export type Dettagli = NonNullable<TelecameraViva['dettagli']>

export interface AscoltatoreByte {
  byte(dati: Uint8Array): void
  /** Il flusso si e interrotto. Arrivera dell'altro solo dopo una ripresa. */
  caduto(motivo: string): void
}

export interface TelecameraVivaInterna {
  readonly raggiungibile: boolean
  readonly batteria: number | null
  readonly segnale: number | null
  readonly fpsAnteprima: number | null
  readonly vistoIl: string | null
  readonly dettagli: Dettagli | null
  readonly inIdentificazione: boolean
}

export interface OpzioniGestore {
  readonly progetto: () => Progetto
  readonly suDiario: (livello: 'info' | 'attenzione' | 'grave', testo: string) => void
  readonly suFotogramma: (telecameraId: string, chiave: boolean, dati: Uint8Array) => void
  /** Restituisce la password in chiaro per una Telecamera, o `null`. */
  readonly password: (t: Telecamera) => string | null
}

/** Ogni quanto si chiede a ogni telefono come sta. */
const CADENZA_INFO_MS = 3000
/** Quanto si aspetta prima di riaprire un flusso caduto. */
const RIPROVA_FLUSSO_MS = 2000
/**
 * Oltre quanto un fotogramma chiave in cache smette di valere come "adesso".
 * Gli IDR arrivano ogni secondo: tre secondi sono tre occasioni mancate, cioe
 * un flusso che non sta piu arrivando.
 */
const VALIDITA_IDR_MS = 3000

interface Sessione {
  flusso: FlussoAperto | null
  spezzatore: SpezzatoreAnnexB
  /** L'ultimo fotogramma chiave, per far partire subito chi si collega dopo. */
  ultimoIdr: Uint8Array | null
  /** Quando e arrivato. Un IDR vecchio non si serve: vedi `ultimoIdr()`. */
  ultimoIdrIl: number
  fotogrammiNelSecondo: number
  ultimaMisura: number
  riprova: NodeJS.Timeout | null
}

export class GestoreTelecamere {
  private readonly viste = new Map<string, TelecameraVivaInterna>()
  private readonly sessioni = new Map<string, Sessione>()
  private readonly ascoltatoriByte = new Map<string, Set<AscoltatoreByte>>()
  private anteprime = new Set<string>()
  private battito: NodeJS.Timeout | null = null
  private identificazione: string | null = null
  private chiuso = false

  constructor(private readonly opzioni: OpzioniGestore) {}

  avvia(): void {
    if (this.battito) return
    this.battito = setInterval(() => void this.giroInfo(), CADENZA_INFO_MS)
    this.battito.unref?.()
    void this.giroInfo()
  }

  async chiudi(): Promise<void> {
    this.chiuso = true
    if (this.battito) clearInterval(this.battito)
    this.battito = null
    for (const id of [...this.sessioni.keys()]) this.chiudiSessione(id)
  }

  // -------------------------------------------------------------- lettura

  viva(id: string): TelecameraVivaInterna | undefined {
    const v = this.viste.get(id)
    if (!v) return undefined
    return { ...v, inIdentificazione: this.identificazione === id }
  }

  /**
   * L'ultimo fotogramma chiave, ma **solo se e ancora recente**.
   *
   * Serve a togliere fino a un secondo di nero a chi apre l'anteprima adesso:
   * gli IDR arrivano ogni secondo e l'intervallo non e configurabile.
   *
   * La scadenza non e prudenza generica. Se il flusso e caduto e sta
   * riprovando, in cache resta l'ultimo fotogramma buono: mandarlo a chi si
   * collega mostrerebbe una stanza com'era mezz'ora fa dentro un riquadro che
   * dice "diretta". In una casa degli orrori quella e la peggiore delle bugie
   * possibili -- meglio un riquadro nero, che almeno si vede che e nero.
   */
  ultimoIdr(id: string): Uint8Array | null {
    const s = this.sessioni.get(id)
    if (!s?.ultimoIdr) return null
    return Date.now() - s.ultimoIdrIl <= VALIDITA_IDR_MS ? s.ultimoIdr : null
  }

  // -------------------------------------------------------- chi vuole cosa

  /** Le Telecamere di cui almeno una interfaccia collegata vuole l'anteprima. */
  vuoleAnteprima(ids: readonly string[]): void {
    const nuove = new Set(ids)
    if (stessoInsieme(nuove, this.anteprime)) return
    this.anteprime = nuove
    this.sincronizza()
  }

  /**
   * I byte grezzi, per la registrazione. Non apre una seconda connessione.
   *
   * `caduto` non e un dettaglio: il §3.7 vuole che a Wi-Fi caduto il file si
   * chiuda **bene** -- deve restare leggibile -- e che la registrazione riparta
   * su un file nuovo quando il telefono torna. Senza questo avviso, ffmpeg
   * resterebbe con lo stdin aperto e ci scriverebbe dentro l'ora di buco.
   */
  ascoltaByte(telecameraId: string, ascoltatore: AscoltatoreByte): () => void {
    let insieme = this.ascoltatoriByte.get(telecameraId)
    if (!insieme) {
      insieme = new Set()
      this.ascoltatoriByte.set(telecameraId, insieme)
    }
    insieme.add(ascoltatore)
    this.sincronizza()
    return () => {
      insieme.delete(ascoltatore)
      if (insieme.size === 0) this.ascoltatoriByte.delete(telecameraId)
      this.sincronizza()
    }
  }

  /**
   * Apre e chiude i flussi per far coincidere cio che scorre con cio che serve.
   * Si chiama a ogni cambiamento: iscrizioni, registrazioni, progetto.
   */
  sincronizza(): void {
    if (this.chiuso) return
    const telecamere = this.opzioni.progetto().telecamere
    const conosciute = new Set(telecamere.map((t) => t.id))

    for (const t of telecamere) {
      const serve = this.anteprime.has(t.id) || (this.ascoltatoriByte.get(t.id)?.size ?? 0) > 0
      const aperta = this.sessioni.has(t.id)
      if (serve && !aperta) this.apriSessione(t)
      else if (!serve && aperta) this.chiudiSessione(t.id)
    }
    for (const id of [...this.sessioni.keys()]) {
      if (!conosciute.has(id)) this.chiudiSessione(id)
    }
    for (const id of [...this.viste.keys()]) {
      if (!conosciute.has(id)) this.viste.delete(id)
    }
  }

  // ------------------------------------------------------------- comandi

  /**
   * Identifica: due secondi di torcia accesa.
   *
   * E il modo di capire quale telefono e quale senza guardare sei anteprime e
   * senza entrare nella stanza. La torcia si spegne in un `finally`: se
   * qualcosa va storto a meta, un telefono con la torcia accesa per tutta la
   * serata si scaricherebbe e illuminerebbe una stanza che deve essere buia.
   */
  async identifica(telecameraId: string): Promise<void> {
    const t = this.telecamera(telecameraId)
    const dettagli = this.viste.get(telecameraId)?.dettagli
    if (dettagli && !dettagli.haFlash) {
      throw new Error(`"${t.nome}" non ha il flash: usa l'anteprima per riconoscerla`)
    }
    if (this.identificazione) throw new Error('c\'e gia una Identifica in corso')

    this.identificazione = telecameraId
    const a = this.accesso(t)
    try {
      await comanda(a, { torch: 'on' })
      this.opzioni.suDiario('info', `Identifica su "${t.nome}": torcia accesa.`)
      await attendi(2000)
    } finally {
      this.identificazione = null
      try {
        await comanda(a, { torch: 'off' })
      } catch (e) {
        this.opzioni.suDiario(
          'attenzione',
          `Non sono riuscito a spegnere la torcia di "${t.nome}": ${(e as Error).message}`,
        )
      }
    }
  }

  async controlla(
    telecameraId: string,
    parametri: Readonly<Record<string, string>>,
  ): Promise<void> {
    const t = this.telecamera(telecameraId)
    await comanda(this.accesso(t), parametri)
    // Cio che si e appena cambiato si rilegge subito, invece di aspettare il
    // giro: l'interfaccia deve mostrare l'effetto del comando, non l'intenzione.
    await this.chiediInfo(t)
  }

  /**
   * Cerca Telecamere sulla rete (§3.3).
   *
   * Si sonda `/info.json` sulla porta 4444 di ogni indirizzo della sottorete,
   * in parallelo e con timeout corto. **La scansione e l'unica strada insieme
   * all'IP scritto a mano, e lo resta su tutti e due i sistemi.**
   *
   * Su Windows perche non c'e scelta: avahi e compilato solo
   * `if(NOT WIN32 AND NOT ANDROID)` (ADR 0002) e da WSL il multicast verso la
   * LAN non e affidabile. Su Linux la scelta ci sarebbe -- avahi li e compilato
   * -- ma Regia scrive comunque `mdns_enabled = false` nella configurazione di
   * snapserver (`configurazione.ts`), e nel motore non c'e nessun client mDNS:
   * quella riga riguarda comunque il server audio, non le Telecamere, che
   * andrebbero cercate con un'altra pubblicazione ancora.
   *
   * Quindi il codice qui sotto non ha un ramo in meno da qualche parte: ha
   * sempre e solo questo.
   */
  async scansiona(
    sottorete: string | null,
    porta = 4444,
  ): Promise<{ host: string; porta: number; nome: string | null }[]> {
    const base = sottorete ?? this.sottoreteProbabile()
    if (!base) throw new Error('non riesco a indovinare la sottorete: scrivila a mano, es. 192.168.1')
    const radice = base.replace(/\.$/, '').split('.').slice(0, 3).join('.')

    const trovate: { host: string; porta: number; nome: string | null }[] = []
    const indirizzi = Array.from({ length: 254 }, (_, i) => `${radice}.${i + 1}`)

    // A ondate: 254 connessioni insieme fanno perdere pacchetti sulla Wi-Fi e
    // producono falsi negativi -- una Telecamera c'e ma non risponde in tempo.
    const AMPIEZZA = 32
    for (let i = 0; i < indirizzi.length; i += AMPIEZZA) {
      await Promise.all(
        indirizzi.slice(i, i + AMPIEZZA).map(async (host) => {
          try {
            const info = await leggiInfo(
              { host, porta, https: false, utente: null, password: null },
              1200,
            )
            trovate.push({ host, porta, nome: info.nome })
          } catch {
            /* non e una Telecamera, o non risponde: e il caso normale */
          }
        }),
      )
    }
    this.opzioni.suDiario(
      'info',
      `Scansione di ${radice}.0/24: ${trovate.length} Telecamere trovate.`,
    )
    return trovate
  }

  /**
   * Rimette la Telecamera nello stato che Regia si aspetta.
   *
   * Sul telefono **niente torna ai default da solo**: streaming, risoluzione,
   * zoom, rotazione e torcia restano come li ha lasciati l'ultima volta, anche
   * dopo un riavvio. Quindi non si da per scontato nulla di cio che Regia usa.
   *
   * Oggi il preset e di due voci, e sono le due che Regia cambia davvero:
   * lo streaming acceso, e la **torcia spenta**. La torcia conta piu di quanto
   * sembri: Identifica la accende, e se Regia muore nei due secondi in cui e
   * accesa, quel telefono resta con la luce addosso per sempre -- in una stanza
   * al buio, dentro una casa degli orrori. Riaprire il progetto la spegne.
   *
   * Risoluzione, zoom e rotazione non stanno nel preset perche non stanno nel
   * dominio: `zTelecamera` non li ha, e Regia non li tocca mai. Il giorno in cui
   * entrano nel progetto, entrano anche qui.
   */
  /**
   * Apre `/audio` di una Telecamera, per la registrazione.
   *
   * Passa da qui e non dal registratore perche le credenziali del telefono
   * stanno qui: chi parla col telefono e sempre il gestore, e ffmpeg non apre
   * mai una connessione sua (ADR 0009). Si apre solo mentre si registra con
   * l'audio acceso -- e una connessione in piu sul telefono, e il §4.5 le
   * conta.
   */
  apriAudio(telecameraId: string, ascoltatore: AscoltatoreByte): () => void {
    const t = this.telecamera(telecameraId)
    let flusso = apriFlussoAudio(
      this.accesso(t),
      (d) => ascoltatore.byte(d),
      (motivo) => {
        ascoltatore.caduto(motivo)
        // Non si riprova da qui: chi registra sa se ha ancora senso, e la
        // pompa nel frattempo scrive silenzio invece di lasciare un buco.
        flusso = null
      },
    ) as ReturnType<typeof apriFlussoAudio> | null
    return () => {
      flusso?.chiudi()
      flusso = null
    }
  }

  async preparaTelecamera(t: Telecamera): Promise<void> {
    const a = this.accesso(t)
    // Lo streaming e la ragione per cui la Telecamera esiste: se non si accende
    // chi ha aggiunto il telefono deve saperlo, e l'errore esce di qui.
    await accendiStreaming(a)
    try {
      await comanda(a, { torch: 'off' })
    } catch (e) {
      // La torcia no. Un telefono senza flash risponde male a questo comando, e
      // far fallire l'aggiunta di una Telecamera perfettamente funzionante per
      // una luce che non ha sarebbe un pessimo scambio: si scrive e si tira
      // avanti.
      this.opzioni.suDiario(
        'info',
        `"${t.nome}": non sono riuscito a spegnere la torcia (${(e as Error).message}). ` +
          'Se il telefono non ha il flash, e normale.',
      )
    }
  }

  // ------------------------------------------------------------- interni

  private telecamera(id: string): Telecamera {
    const t = this.opzioni.progetto().telecamere.find((x) => x.id === id)
    if (!t) throw new Error(`Telecamera inesistente: ${id}`)
    return t
  }

  private accesso(t: Telecamera): AccessoTelecamera {
    return {
      host: t.host,
      porta: t.porta,
      https: t.https,
      utente: t.utente,
      password: this.opzioni.password(t),
    }
  }

  private async giroInfo(): Promise<void> {
    const telecamere = this.opzioni.progetto().telecamere
    await Promise.all(telecamere.map((t) => this.chiediInfo(t)))
    this.sincronizza()
  }

  private async chiediInfo(t: Telecamera): Promise<void> {
    const prima = this.viste.get(t.id)
    try {
      const info = await leggiInfo(this.accesso(t))
      const sessione = this.sessioni.get(t.id)
      this.viste.set(t.id, {
        raggiungibile: true,
        batteria: info.batteria,
        segnale: info.segnale,
        fpsAnteprima: sessione ? sessione.fotogrammiNelSecondo : null,
        vistoIl: new Date().toISOString(),
        dettagli: {
          torcia: info.torcia,
          haFlash: info.haFlash,
          risoluzione: info.risoluzione,
          fps: info.fps,
          obiettivo: info.obiettivo,
          obiettiviDisponibili: info.obiettiviDisponibili,
          risoluzioniDisponibili: info.risoluzioniDisponibili,
        },
        inIdentificazione: false,
      })
      if (prima && !prima.raggiungibile) {
        this.opzioni.suDiario('info', `Telecamera "${t.nome}" tornata raggiungibile.`)
      }
    } catch {
      this.viste.set(t.id, {
        raggiungibile: false,
        batteria: prima?.batteria ?? null,
        segnale: prima?.segnale ?? null,
        fpsAnteprima: null,
        vistoIl: prima?.vistoIl ?? null,
        dettagli: prima?.dettagli ?? null,
        inIdentificazione: false,
      })
      if (prima?.raggiungibile) {
        this.opzioni.suDiario('attenzione', `Telecamera "${t.nome}" non risponde piu.`)
      }
    }
  }

  private apriSessione(t: Telecamera): void {
    const sessione: Sessione = {
      flusso: null,
      spezzatore: new SpezzatoreAnnexB((unita, chiave) => {
        if (chiave) {
          sessione.ultimoIdr = unita
          sessione.ultimoIdrIl = Date.now()
        }
        sessione.fotogrammiNelSecondo++
        this.opzioni.suFotogramma(t.id, chiave, unita)
      }),
      ultimoIdr: null,
      ultimoIdrIl: 0,
      fotogrammiNelSecondo: 0,
      ultimaMisura: Date.now(),
      riprova: null,
    }
    this.sessioni.set(t.id, sessione)
    void this.collega(t, sessione)
  }

  private async collega(t: Telecamera, sessione: Sessione): Promise<void> {
    if (this.sessioni.get(t.id) !== sessione) return
    const a = this.accesso(t)
    try {
      // Lo streaming e persistente fra i riavvii, ma "persistente" vuol dire
      // "come l'ha lasciato l'ultima volta", e l'ultima volta puo essere stata
      // qualcun altro: si accende sempre, prima di chiedere il flusso.
      await accendiStreaming(a)
    } catch (e) {
      this.riprogramma(t, sessione, (e as Error).message)
      return
    }
    if (this.sessioni.get(t.id) !== sessione) return

    sessione.flusso = apriFlussoH264(
      a,
      (d) => {
        sessione.spezzatore.spingi(d)
        const ascoltatori = this.ascoltatoriByte.get(t.id)
        if (ascoltatori) for (const a of ascoltatori) a.byte(d)
        const ora = Date.now()
        if (ora - sessione.ultimaMisura >= 1000) {
          const vista = this.viste.get(t.id)
          if (vista) {
            this.viste.set(t.id, { ...vista, fpsAnteprima: sessione.fotogrammiNelSecondo })
          }
          sessione.fotogrammiNelSecondo = 0
          sessione.ultimaMisura = ora
        }
      },
      (motivo) => this.riprogramma(t, sessione, motivo),
    )
  }

  private riprogramma(t: Telecamera, sessione: Sessione, motivo: string): void {
    if (this.chiuso || this.sessioni.get(t.id) !== sessione) return
    sessione.flusso = null
    sessione.spezzatore.chiudi()
    for (const a of this.ascoltatoriByte.get(t.id) ?? []) a.caduto(motivo)
    if (sessione.riprova) return
    this.opzioni.suDiario('attenzione', `Video di "${t.nome}" interrotto: ${motivo}. Riprovo.`)
    sessione.riprova = setTimeout(() => {
      sessione.riprova = null
      void this.collega(t, sessione)
    }, RIPROVA_FLUSSO_MS)
    sessione.riprova.unref?.()
  }

  private chiudiSessione(id: string): void {
    const s = this.sessioni.get(id)
    if (!s) return
    this.sessioni.delete(id)
    if (s.riprova) clearTimeout(s.riprova)
    s.flusso?.chiudi()
    s.spezzatore.chiudi()
  }

  /**
   * Da dove partire a cercare.
   *
   * Se una Telecamera c'e gia, la sua sottorete e la risposta migliore: e per
   * definizione quella dove stanno i telefoni. Solo dopo si guarda la rete del
   * PC, che ha quasi sempre anche interfacce che non portano da nessuna parte:
   * quella di WSL e di Hyper-V su Windows, `docker0` e i `veth` dei container
   * su Linux. Hanno un IP vero e una sottorete tutta loro, e scandirla vuol
   * dire 254 sonde verso il nulla: la prima interfaccia **non** virtuale e
   * quella giusta. Il giudizio sta in `virtuale()` in `ambiente.ts` -- una sola
   * regola, che copre i due sistemi, invece di due elenchi che divergono.
   */
  private sottoreteProbabile(): string | null {
    for (const t of this.opzioni.progetto().telecamere) {
      const p = t.host.split('.')
      if (p.length === 4) return p.slice(0, 3).join('.')
    }
    const locale = indirizziLocali().find((i) => !virtuale(i.interfaccia))
    return locale ? locale.ip.split('.').slice(0, 3).join('.') : null
  }
}

function stessoInsieme(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

function attendi(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
