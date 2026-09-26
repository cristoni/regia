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
import type { Livello, Orientamento, TelecameraViva } from '../api/protocollo.js'
import { indirizziLocali, virtuale } from '../ambiente.js'
import { SpezzatoreAnnexB, geometriaDi } from './annexb.js'
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

/** Cio che si sa di una Telecamera dal giro di `/info.json`. */
interface Vista {
  readonly raggiungibile: boolean
  readonly batteria: number | null
  readonly segnale: number | null
  readonly fpsAnteprima: number | null
  readonly vistoIl: string | null
  readonly dettagli: Dettagli | null
  readonly inIdentificazione: boolean
}

/**
 * Cio che si sa di una Telecamera dal **video**, che `/info.json` non dice:
 * la geometria vera dell'ultimo fotogramma chiave e da che verso e girata.
 */
interface Geometria {
  readonly geometria: string
  readonly orientamento: Orientamento | null
  readonly cambiatoIl: string | null
}

export interface TelecameraVivaInterna extends Vista {
  readonly geometria: string | null
  readonly orientamento: Orientamento | null
  readonly orientamentoCambiatoIl: string | null
  readonly lampoMs: number | null
  readonly torciaFissa: boolean
}

/**
 * Una torcia che Regia ha acceso -- per un Lampo o per Identifica -- e non ha
 * ancora spento.
 *
 * Ce n'e al piu una per **telefono**, e chi la spegne e **l'ultimo** che l'ha
 * chiesta: `turno` dice chi e. Un Lampo che arriva mentre la torcia e gia
 * accesa non la spegne e riaccende, prende il turno e sposta lo spegnimento.
 */
interface Lampo {
  /**
   * Come raggiungere il telefono, preso quando si e accesa. Lo spegnimento
   * deve arrivare anche se nel frattempo la Telecamera e stata rimossa dal
   * progetto, o se un progetto importato ha dato il suo id a un altro
   * telefono: quello con la luce addosso resta nella stanza lo stesso.
   */
  accesso: AccessoTelecamera
  nome: string
  turno: number
  /**
   * Quanto resta accesa dalla conferma dell'`on`, o `null` per la torcia
   * **fissa** del pulsante on/off: accesa finche qualcuno non la spegne, e
   * quindi senza timer.
   */
  durataMs: number | null
  spegnimento: NodeJS.Timeout | null
}

/**
 * Di quale telefono e una torcia. Non l'id della Telecamera: gli id si
 * ripetono fra un progetto e l'altro (`t1` e il primo di ogni progetto), e
 * dopo un'importazione lo stesso id puo indicare un altro telefono. La torcia
 * sta sul telefono, e il telefono si riconosce dall'indirizzo.
 */
function telefonoDi(x: { readonly host: string; readonly porta: number }): string {
  return `${x.host}:${x.porta}`
}

export interface OpzioniGestore {
  readonly progetto: () => Progetto
  readonly suDiario: (livello: Livello, testo: string) => void
  readonly suFotogramma: (telecameraId: string, chiave: boolean, dati: Uint8Array) => void
  /** Restituisce la password in chiaro per una Telecamera, o `null`. */
  readonly password: (t: Telecamera) => string | null
}

/**
 * La geometria che Regia chiede al telefono (ADR 0014; sostituisce il valore
 * fisso dell'ADR 0012).
 *
 * **Perche non basta un valore solo.** Il telefono non ritaglia mai: impagina
 * cio che l'obiettivo gli da dentro la geometria che gli si chiede, e riempie
 * il resto di nero. Misurato il 19 settembre 2026: con `1280x720` chiesto a un
 * telefono in piedi l'immagine utile era **405x720**; con `1280x960` era
 * **720x960**, con 280 px di nero per lato; con **`960x1280`** il fotogramma
 * usciva **pieno**. Il nero si paga due volte, in banda e sul disco, e chi
 * guarda lo legge come un'inquadratura tagliata.
 *
 * **Da cosa dipende.** Non dalla rotazione dichiarata -- quella dice come si
 * vuole *vedere* il video, non come il telefono lo *produce* -- ma dal verso
 * in cui il sensore e montato. `sensorOrientation` vale 90 o 270 su quasi
 * tutti i telefoni: il sensore e coricato rispetto al verso naturale dello
 * schermo, l'app raddrizza l'immagine, e cio che esce e **verticale**. Serve
 * quindi un fotogramma verticale per contenerla senza bande; poi, se la
 * Telecamera e montata di traverso, e la rotazione dell'ADR 0014 a raddrizzare
 * la veduta -- nell'anteprima e nel file, non qui.
 *
 * Senza quel dato (`null`, il telefono non ha ancora risposto) si chiede
 * comunque la geometria verticale: e il caso di quasi ogni telefono, e
 * sbagliarla costa solo bande nere fino al giro di `/info.json` dopo.
 *
 * Il valore resta **concreto** apposta, come chiede l'ADR 0012: un `WxH`
 * spegne l'adattamento, un'etichetta come `high` no.
 */
export function risoluzioneRipresa(orientamentoSensore: number | null): string {
  const coricato = orientamentoSensore === null || orientamentoSensore === 90 || orientamentoSensore === 270
  return coricato ? '960x1280' : '1280x960'
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
/**
 * Oltre questo silenzio di fotogrammi, l'fps mostrato decade a 0 invece di
 * restare congelato all'ultimo valore. Piu lungo della finestra di misura (1 s)
 * cosi un normale intervallo fra due misure non lo fa sfarfallare a 0; piu corto
 * dei 3 s con cui l'anteprima copre la cella, cosi il numero e gia zero quando
 * il riquadro diventa nero.
 */
const FPS_STALLO_MS = 2500
/** Quanto resta accesa la torcia per Identifica. */
const DURATA_IDENTIFICA_MS = 2000
/**
 * Quante volte si prova a spegnere una torcia prima di arrendersi, e quanto si
 * aspetta fra un tentativo e l'altro. Un telefono puo non rispondere per un
 * istante -- il Wi-Fi che si riassocia, la camera che si ri-lega -- e una
 * torcia rimasta accesa per un solo `off` perso e una stanza illuminata per
 * tutta la serata.
 */
const TENTATIVI_SPEGNIMENTO = 3
const PAUSA_SPEGNIMENTO_MS = 1000

/**
 * L'fps da mostrare in anteprima: quello misurato, o 0 se lo stream ha smesso
 * di consegnare fotogrammi.
 *
 * Puro, e collaudato in `viste.test`-style, perche e l'unico punto dell'fps in
 * cui si puo sbagliare: senza la soglia, uno stream fermo mostrerebbe per sempre
 * l'ultimo fps misurato (il giro di `/info.json` lo ricopia identico ogni 3 s),
 * e l'Operatore vedrebbe "24 fps" su una cella che non si aggiorna piu.
 */
export function fpsVisibile(fpsPubblicato: number, ultimoFotogrammaIl: number, ora: number): number {
  return ora - ultimoFotogrammaIl > FPS_STALLO_MS ? 0 : fpsPubblicato
}

/**
 * Da che verso e girata un'immagine di questa geometria (ADR 0013).
 *
 * `verticale` se e piu alta che larga, `orizzontale` altrimenti: un quadrato
 * conta come orizzontale, che e il verso di un sensore lasciato in pace.
 * `null` se non e un `WxH` leggibile. Puro e provato a parte perche e l'unica
 * regola dell'orientamento: il resto e confrontare il verso di prima con
 * quello di adesso.
 */
export function orientamentoDi(geometria: string): Orientamento | null {
  const m = /^(\d+)x(\d+)$/.exec(geometria)
  if (!m) return null
  return Number(m[2]) > Number(m[1]) ? 'verticale' : 'orizzontale'
}

interface Sessione {
  flusso: FlussoAperto | null
  spezzatore: SpezzatoreAnnexB
  /** L'ultimo fotogramma chiave, per far partire subito chi si collega dopo. */
  ultimoIdr: Uint8Array | null
  /** Quando e arrivato. Un IDR vecchio non si serve: vedi `ultimoIdr()`. */
  ultimoIdrIl: number
  fotogrammiNelSecondo: number
  ultimaMisura: number
  /** L'ultimo fps calcolato sulla finestra di misura: e questo che si mostra. */
  fpsPubblicato: number
  /** Quando e arrivato l'ultimo fotogramma. Oltre `FPS_STALLO_MS` l'fps va a 0. */
  ultimoFotogrammaIl: number
  riprova: NodeJS.Timeout | null
}

export class GestoreTelecamere {
  private readonly viste = new Map<string, Vista>()
  /**
   * L'ultima geometria vista per Telecamera. Vive fuori dalla sessione di
   * proposito: se il telefono viene girato mentre nessuno lo guarda, il cambio
   * si vede al primo fotogramma chiave della sessione dopo, e va detto allora.
   */
  private readonly geometrie = new Map<string, Geometria>()
  /**
   * `sensorOrientation` dell'obiettivo attivo di ogni Telecamera, come l'ha
   * detto `/info.json`. Da qui si decide che geometria chiedere al telefono
   * (`risoluzioneRipresa`): e l'unico indizio che il telefono da sulla forma
   * dell'immagine che produce.
   */
  private readonly sensori = new Map<string, number>()
  private readonly sessioni = new Map<string, Sessione>()
  private readonly ascoltatoriByte = new Map<string, Set<AscoltatoreByte>>()
  private anteprime = new Set<string>()
  private battito: NodeJS.Timeout | null = null
  /** L'Identifica in corso: quale Telecamera, e il turno della torcia che ha acceso. */
  private identificazione: { telecameraId: string; telefono: string; turno: number } | null = null
  /** Le torce accese da Regia, per telefono (`telefonoDi`). */
  private readonly lampi = new Map<string, Lampo>()
  private turniTorcia = 0
  /**
   * I comandi della torcia, in fila per telefono. Senza, un `on` e un `off`
   * partiti a pochi millisecondi l'uno dall'altro viaggiano su due socket
   * diverse e possono arrivare al telefono nell'ordine sbagliato: la torcia
   * resterebbe accesa con Regia convinta di averla spenta.
   */
  private readonly codeTorcia = new Map<string, Promise<unknown>>()
  /** Quando e finito l'ultimo comando della torcia, per telefono (`performance.now()`). Vedi `rispegni`. */
  private readonly ultimoComandoTorcia = new Map<string, number>()
  /** I telefoni a cui `rispegni` ha gia mandato un `off` che non e ancora tornato. */
  private readonly rispegnimenti = new Set<string>()
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
    // Chi chiude Regia a torcia accesa non deve lasciare la luce nella stanza.
    // Lo spegnimento va in fila dietro a un eventuale `on` ancora in volo, e
    // il turno nuovo toglie a chi l'aveva acceso la voglia di riprogrammarlo.
    const spegnimenti = [...this.lampi].map(([telefono, l]) => {
      if (l.spegnimento) clearTimeout(l.spegnimento)
      l.spegnimento = null
      l.turno = ++this.turniTorcia
      return this.inFila(telefono, () => comanda(l.accesso, { torch: 'off' }, 1500)).catch(() => {})
    })
    this.lampi.clear()
    await Promise.all(spegnimenti)
  }

  // -------------------------------------------------------------- lettura

  viva(id: string): TelecameraVivaInterna | undefined {
    const v = this.viste.get(id)
    if (!v) return undefined
    const g = this.geometrie.get(id)
    const t = this.opzioni.progetto().telecamere.find((x) => x.id === id)
    const lampo = t ? this.lampi.get(telefonoDi(t)) : undefined
    return {
      ...v,
      inIdentificazione: this.identificazione?.telecameraId === id && this.identificaHaLaTorcia(),
      geometria: g?.geometria ?? null,
      orientamento: g?.orientamento ?? null,
      orientamentoCambiatoIl: g?.cambiatoIl ?? null,
      lampoMs: lampo?.durataMs ?? null,
      torciaFissa: lampo !== undefined && lampo.durataMs === null,
    }
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
    for (const id of [...this.geometrie.keys()]) {
      if (!conosciute.has(id)) this.geometrie.delete(id)
    }
    for (const id of [...this.sensori.keys()]) {
      if (!conosciute.has(id)) this.sensori.delete(id)
    }
  }

  // ------------------------------------------------------------- comandi

  /**
   * Identifica: due secondi di torcia accesa.
   *
   * E il modo di capire quale telefono e quale senza guardare sei anteprime e
   * senza entrare nella stanza. E un Lampo con un nome suo: la torcia la
   * spegne il timer del Lampo, non questa funzione, cosi un Lampo premuto
   * sulla griglia nel mezzo di una Identifica non viene tagliato a meta. Da
   * quel momento l'Identifica e finita, anche se questa funzione aspetta
   * ancora: la torcia e del Lampo (`identificaHaLaTorcia`).
   */
  async identifica(telecameraId: string): Promise<void> {
    const t = this.telecamera(telecameraId)
    const dettagli = this.viste.get(telecameraId)?.dettagli
    if (dettagli && !dettagli.haFlash) {
      throw new Error(`"${t.nome}" non ha il flash: usa l'anteprima per riconoscerla`)
    }
    if (this.identificaHaLaTorcia()) throw new Error('c\'e gia una Identifica in corso')

    const { lampo, turno } = this.prendiTorcia(t, DURATA_IDENTIFICA_MS)
    const questa = { telecameraId, telefono: telefonoDi(t), turno }
    this.identificazione = questa
    try {
      await this.accendi(lampo, turno)
      this.opzioni.suDiario('info', `Identifica su "${t.nome}": torcia accesa.`)
      await attendi(DURATA_IDENTIFICA_MS)
    } finally {
      if (this.identificazione === questa) this.identificazione = null
    }
  }

  /**
   * Un Lampo: la torcia accesa per `durataMs`, e poi spenta da Regia.
   *
   * Torna appena il telefono ha confermato l'accensione, non quando la torcia
   * si spegne: chi preme deve sapere subito se il telefono ha risposto, e un
   * comando appeso per cinque secondi non gli direbbe niente di piu. La durata
   * si conta **da quella conferma**, cosi la luce resta accesa quanto chiesto
   * anche su un telefono che risponde lento.
   *
   * Un Lampo nuovo sulla stessa Telecamera **sostituisce** quello in corso: la
   * torcia non si spegne e riaccende, resta accesa e si spegne `durataMs` dopo
   * l'ultimo. Vale in tutti e due i versi -- un "flash" premuto durante un
   * "5 sec" lo accorcia -- ed e voluto: l'ultimo clic dell'Operatore e quello
   * che sta guardando, ed e anche l'unico modo di spegnere prima del tempo.
   */
  async lampo(telecameraId: string, durataMs: number): Promise<void> {
    const t = this.telecamera(telecameraId)
    const dettagli = this.viste.get(telecameraId)?.dettagli
    if (dettagli && !dettagli.haFlash) throw new Error(`"${t.nome}" non ha il flash`)
    const { lampo, turno } = this.prendiTorcia(t, durataMs)
    await this.accendi(lampo, turno)
  }

  /**
   * Il pulsante on/off: la torcia accesa **finche non la si spegne**, o spenta
   * adesso.
   *
   * Accesa e un Lampo senza scadenza, e segue le stesse regole: prende la
   * torcia a chi l'aveva, e un Lampo premuto dopo la riprende -- un "flash" su
   * una torcia fissa la spegne dopo il lampo, perche l'ultimo clic decide. Ed
   * e di Regia, quindi `rispegni` non la tocca; se Regia si chiude la spegne
   * `chiudi()`, e se muore la spegne `rispegni` alla riapertura: la torcia
   * fissa non sopravvive a Regia, apposta.
   *
   * Spenta toglie la torcia a chiunque l'abbia -- Lampo, Identifica o fissa --
   * e aspetta la conferma del telefono. Se il telefono non risponde lo dice il
   * Diario, come per ogni spegnimento, e il giro di `/info.json` riprova.
   */
  async torcia(telecameraId: string, accesa: boolean): Promise<void> {
    const t = this.telecamera(telecameraId)
    if (accesa) {
      const dettagli = this.viste.get(telecameraId)?.dettagli
      if (dettagli && !dettagli.haFlash) throw new Error(`"${t.nome}" non ha il flash`)
      const { lampo, turno } = this.prendiTorcia(t, null)
      await this.accendi(lampo, turno)
      return
    }
    // Anche senza una torcia di Regia si manda l'`off`: chi preme "spegni"
    // vede una luce, e da dove venga non conta.
    const { turno } = this.prendiTorcia(t, null)
    await this.spegniTorcia(telefonoDi(t), turno)
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

  /**
   * Rimette la Telecamera nello stato che Regia si aspetta.
   *
   * Sul telefono **niente torna ai default da solo**: streaming, risoluzione,
   * zoom, rotazione e torcia restano come li ha lasciati l'ultima volta, anche
   * dopo un riavvio. Quindi non si da per scontato nulla di cio che Regia usa.
   *
   * Oggi il preset e di due voci, e sono le due che Regia cambia davvero:
   * lo streaming acceso, e la **torcia spenta**. La torcia conta piu di quanto
   * sembri: Lampi e Identifica la accendono, e sul telefono e persistente --
   * una luce dimenticata resta addosso a una stanza che deve essere buia. Qui
   * si spegne quando la Telecamera entra nel progetto; dopo, e `rispegni` a
   * spegnere a ogni giro di `/info.json` quella che nessun Lampo tiene accesa,
   * anche dopo una Regia morta a torcia accesa.
   *
   * Zoom e rotazione non stanno nel preset perche non stanno nel dominio:
   * `zTelecamera` non li ha, e Regia non li tocca mai. La risoluzione era
   * nella stessa frase fino all'ADR 0012: ora Regia la tocca, ma solo a
   * runtime e solo durante il REC (`fissaRisoluzione`), quindi nel preset
   * continua a non stare. La rotazione Regia continua a non toccarla, ma
   * dall'ADR 0013 la **legge**, dal video (`annotaGeometria`): e un'altra
   * cosa. Il giorno in cui una di queste voci entra nel progetto, entra
   * anche qui.
   */
  async preparaTelecamera(t: Telecamera): Promise<void> {
    const a = this.accesso(t)
    // Lo streaming e la ragione per cui la Telecamera esiste: se non si accende
    // chi ha aggiunto il telefono deve saperlo, e l'errore esce di qui.
    await accendiStreaming(a)
    try {
      // La geometria entra nel preset con l'ADR 0014: ora Regia sa come quella
      // Telecamera va inquadrata (la rotazione sta nel progetto), e un telefono
      // lasciato su un'altra geometria darebbe un'anteprima impaginata fra
      // bande nere fino al primo REC. Non fa fallire l'aggiunta: e il motivo
      // per cui sta qui dentro e non sopra, accanto allo streaming.
      await this.fissaRisoluzione(t)
    } catch (e) {
      this.opzioni.suDiario(
        'attenzione',
        `Non sono riuscito a fissare la geometria di "${t.nome}" (${(e as Error).message}): ` +
          'l anteprima potrebbe avere bande nere.',
      )
    }
    try {
      await this.inFila(telefonoDi(t), () => comanda(a, { torch: 'off' }))
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

  /**
   * Mette il telefono nella geometria che Regia si aspetta (ADR 0012 e 0014).
   *
   * Due ragioni, tutte e due misurate. Con `streamRes: "auto"` il telefono
   * cambia geometria a meta stream, e una registrazione `-c:v copy` che cambia
   * dimensione si blocca nei lettori rigidi (ADR 0012); e con una geometria
   * che non ha il rapporto dell'obiettivo il telefono impagina l'immagine fra
   * bande nere, buttando via banda e pixel (ADR 0014). Serve la forma `WxH`,
   * non `low|medium|high`: le etichette toccano solo il *target* di `auto` e
   * lasciano vivo l'adattamento (letto in `StreamingService.kt`).
   *
   * Si chiama in tre momenti: quando si aggiunge una Telecamera, quando
   * l'Operatore ne dichiara la rotazione, e all'accensione del REC -- cioe
   * ogni volta che Regia sa qualcosa di nuovo su come quella Telecamera va
   * inquadrata. Se il telefono e gia come si vuole non si manda niente.
   *
   * Questa scelta vince su un `auto` impostato a mano sul telefono, e il
   * Diario lo dice. Non si ripristina mai niente, coerente col preset: il
   * telefono resta come Regia l'ha lasciato.
   */
  async fissaRisoluzione(t: Telecamera): Promise<void> {
    const prima = this.viste.get(t.id)?.dettagli?.risoluzione
    const voluta = risoluzioneRipresa(this.sensori.get(t.id) ?? null)
    if (prima === voluta) return
    await comanda(this.accesso(t), { resolution: voluta })
    // Cio che si e appena chiesto si segna subito, senza aspettare il giro di
    // `/info.json` che arriva ogni tre secondi: chi chiama due volte di fila --
    // l'Operatore che gira la Telecamera e poi preme REC -- non deve far
    // ri-legare la camera al telefono due volte per la stessa geometria.
    const vista = this.viste.get(t.id)
    if (vista?.dettagli) {
      this.viste.set(t.id, { ...vista, dettagli: { ...vista.dettagli, risoluzione: voluta } })
    }
    this.opzioni.suDiario(
      'info',
      prima === 'auto'
        ? `Risoluzione di "${t.nome}" fissata a ${voluta}: una ripresa vuole una geometria ` +
            'stabile, e vince su "auto".'
        : `Risoluzione di "${t.nome}" fissata a ${voluta}.`,
    )
  }

  // ------------------------------------------------------------- interni

  /**
   * Prende la torcia del telefono di `t` per un turno nuovo. Sincrona apposta:
   * chi la chiama sa il proprio turno prima di aspettare il telefono.
   */
  private prendiTorcia(t: Telecamera, durataMs: number | null): { lampo: Lampo; turno: number } {
    const telefono = telefonoDi(t)
    const turno = ++this.turniTorcia
    let l = this.lampi.get(telefono)
    if (l) {
      if (l.spegnimento) clearTimeout(l.spegnimento)
      l.spegnimento = null
      l.turno = turno
      l.durataMs = durataMs
      l.accesso = this.accesso(t)
      l.nome = t.nome
    } else {
      l = { accesso: this.accesso(t), nome: t.nome, turno, durataMs, spegnimento: null }
      this.lampi.set(telefono, l)
    }
    return { lampo: l, turno }
  }

  /** Accende la torcia per il turno preso, e programma lo spegnimento. Vedi `lampo`. */
  private async accendi(lampo: Lampo, turno: number): Promise<void> {
    const telefono = telefonoDi(lampo.accesso)
    try {
      // Anche se la torcia e gia accesa: costa una richiesta, e un telefono
      // che ha perso l'`on` di prima -- o che si e riavviato -- si riaccende.
      await this.inFila(telefono, () => comanda(lampo.accesso, { torch: 'on' }))
    } catch (e) {
      // Non si sa se la torcia si e accesa: la risposta puo essersi persa dopo
      // che il telefono ha eseguito il comando, o l'`on` puo essere ancora in
      // viaggio -- ritrasmesso dal kernel dopo un buco del Wi-Fi -- e arrivare
      // **dopo** l'`off` che parte adesso su un'altra socket. Il primo caso lo
      // copre questo `off`; il secondo lo copre `rispegni`, al giro di
      // `/info.json` dopo.
      if (lampo.turno === turno) void this.spegniTorcia(telefono, turno)
      throw e
    }
    // Un Lampo piu recente ha preso la torcia mentre si aspettava il telefono:
    // lo spegnimento e suo. O Regia si sta chiudendo, e allora l'ha gia messo
    // in fila `chiudi()`.
    if (lampo.turno !== turno || this.chiuso || lampo.durataMs === null) return
    lampo.spegnimento = setTimeout(() => void this.spegniTorcia(telefono, turno), lampo.durataMs)
  }

  /** Vero se l'Identifica in corso ha ancora la torcia, cioe nessun Lampo gliel'ha presa. */
  private identificaHaLaTorcia(): boolean {
    const i = this.identificazione
    return i !== null && this.lampi.get(i.telefono)?.turno === i.turno
  }

  /**
   * Spegne la torcia accesa dal Lampo di questo turno, se nessuno gliel'ha
   * presa nel frattempo. Riprova: un `off` perso lascerebbe la luce accesa
   * per tutta la serata, ed e il solo comando di Regia che, dimenticato, fa
   * danno da solo.
   */
  private async spegniTorcia(telefono: string, turno: number): Promise<void> {
    const l = this.lampi.get(telefono)
    if (!l || l.turno !== turno) return
    l.spegnimento = null
    for (let tentativo = 1; ; tentativo++) {
      try {
        await this.inFila(telefono, () => comanda(l.accesso, { torch: 'off' }))
        break
      } catch (e) {
        if (l.turno !== turno) return
        if (tentativo >= TENTATIVI_SPEGNIMENTO) {
          this.opzioni.suDiario(
            'attenzione',
            `Non sono riuscito a spegnere la torcia di "${l.nome}" (${(e as Error).message}): ` +
              'potrebbe essere rimasta accesa.',
          )
          break
        }
        await attendi(PAUSA_SPEGNIMENTO_MS)
        if (l.turno !== turno) return
      }
    }
    // Se durante lo spegnimento e arrivato un Lampo nuovo, la torcia e sua: il
    // suo `on` e in fila dietro a questo `off`, e lo spegnimento lo programma lui.
    if (this.lampi.get(telefono) === l && l.turno === turno) this.lampi.delete(telefono)
  }

  /**
   * Spegne una torcia che il telefono dice accesa e che nessun Lampo sta
   * tenendo accesa.
   *
   * Regia e la sola ad accenderla -- Lampi e Identifica, nient'altro
   * nell'interfaccia manda `torch=on` -- quindi una torcia cosi e una torcia
   * dimenticata, e sul telefono **e persistente**: si riaccende da sola a ogni
   * avvio della camera (fatti verificati). Succede se un `on` scaduto arriva al
   * telefono dopo il suo `off`, se lo spegnimento si e arreso, o se Regia e
   * morta a torcia accesa: in quel caso e il primo giro di `/info.json` dopo la
   * riapertura a spegnerla.
   *
   * `chiestoIl` e quando si e chiesto `/info.json`. Se nel frattempo e finito
   * un comando della torcia, la lettura puo essere di prima di quel comando:
   * non si decide niente, e ci pensa il giro dopo.
   */
  private rispegni(t: Telecamera, chiestoIl: number): void {
    const telefono = telefonoDi(t)
    if (this.chiuso || this.lampi.has(telefono) || this.rispegnimenti.has(telefono)) return
    if ((this.ultimoComandoTorcia.get(telefono) ?? 0) >= chiestoIl) return
    this.rispegnimenti.add(telefono)
    const a = this.accesso(t)
    this.inFila(telefono, () => comanda(a, { torch: 'off' }))
      .then(() =>
        this.opzioni.suDiario(
          'attenzione',
          `La torcia di "${t.nome}" era accesa senza un Lampo di Regia: l'ho spenta.`,
        ),
      )
      // Se non risponde si riprova al giro dopo: la lettura dira ancora accesa.
      .catch(() => {})
      .finally(() => this.rispegnimenti.delete(telefono))
  }

  /** Mette `lavoro` in fila dietro ai comandi della torcia gia partiti per questo telefono. */
  private inFila<T>(telefono: string, lavoro: () => Promise<T>): Promise<T> {
    const prima = this.codeTorcia.get(telefono) ?? Promise.resolve()
    const questo = prima.then(lavoro)
    const coda = questo.catch(() => {}).then(() => {
      this.ultimoComandoTorcia.set(telefono, performance.now())
    })
    this.codeTorcia.set(telefono, coda)
    void coda.then(() => {
      if (this.codeTorcia.get(telefono) === coda) this.codeTorcia.delete(telefono)
    })
    return questo
  }

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
    // Orologio monotono, come `ultimoComandoTorcia`: con quello di parete un
    // salto indietro (NTP, un dual boot) zittirebbe `rispegni` per tutto il salto.
    const chiestoIl = performance.now()
    try {
      const info = await leggiInfo(this.accesso(t))
      if (info.torcia) this.rispegni(t, chiestoIl)
      // Il verso del sensore decide che geometria chiedere al telefono
      // (`risoluzioneRipresa`): si tiene da parte a ogni giro, perche cambia
      // quando si cambia obiettivo.
      if (info.orientamentoSensore !== null) this.sensori.set(t.id, info.orientamentoSensore)
      const sessione = this.sessioni.get(t.id)
      this.viste.set(t.id, {
        raggiungibile: true,
        batteria: info.batteria,
        segnale: info.segnale,
        // NON il contatore vivo: quello e un parziale a meta finestra, spesso 0
        // subito dopo un azzeramento, e ricopiarlo qui ogni 3 s faceva
        // sfarfallare l'anteprima a "0 fps" su uno stream perfettamente sano. Si
        // mostra l'ultimo fps misurato, che decade a 0 solo se lo stream si ferma.
        fpsAnteprima: sessione
          ? fpsVisibile(sessione.fpsPubblicato, sessione.ultimoFotogrammaIl, Date.now())
          : null,
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
          this.annotaGeometria(t.id, unita)
        }
        sessione.fotogrammiNelSecondo++
        sessione.ultimoFotogrammaIl = Date.now()
        this.opzioni.suFotogramma(t.id, chiave, unita)
      }),
      ultimoIdr: null,
      ultimoIdrIl: 0,
      fotogrammiNelSecondo: 0,
      ultimaMisura: Date.now(),
      fpsPubblicato: 0,
      ultimoFotogrammaIl: Date.now(),
      riprova: null,
    }
    this.sessioni.set(t.id, sessione)
    void this.collega(t, sessione)
  }

  private async collega(t: Telecamera, sessione: Sessione): Promise<void> {
    if (this.sessioni.get(t.id) !== sessione) return
    const a = this.accesso(t)
    // La geometria si mette a posto **prima** di aprire il flusso, non dopo:
    // cambiarla fa ri-legare la camera al telefono, e un flusso appena aperto
    // cadrebbe subito. Qui si intercetta il caso che sfuggiva a tutti gli
    // altri -- riaprire un progetto con un telefono lasciato su un'altra
    // geometria -- e l'anteprima sarebbe rimasta impaginata fra bande nere
    // fino al primo REC. Se e gia giusta non si manda niente (ADR 0014).
    try {
      await this.fissaRisoluzione(t)
    } catch {
      // Un telefono che non risponde qui non risponde nemmeno al flusso: se ne
      // occupa il ramo sotto, che sa anche riprovare.
    }
    if (this.sessioni.get(t.id) !== sessione) return
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
        const trascorso = ora - sessione.ultimaMisura
        if (trascorso >= 1000) {
          // fps sulla finestra EFFETTIVA, non sul nominale di 1 s: una consegna
          // a raffiche che arriva dopo 1,4 s non deve leggersi come 1 s di conteggio.
          sessione.fpsPubblicato = Math.round((sessione.fotogrammiNelSecondo * 1000) / trascorso)
          const vista = this.viste.get(t.id)
          if (vista) {
            this.viste.set(t.id, { ...vista, fpsAnteprima: sessione.fpsPubblicato })
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
   * L'orientamento si legge dal video, non si chiede al telefono (ADR 0013).
   *
   * L'SPS viaggia con ogni fotogramma chiave (annexb.ts, misurato) e dichiara
   * la geometria vera di cio che esce: con la rotazione cotta nel flusso
   * (android-ip-camera 0.13.1) un telefono in piedi manda `720x1280`, e
   * `/info.json` non lo dice -- riporta la preferenza `rotate`, non il verso
   * del video che sta uscendo (fatti verificati). Quindi il posto in cui ci
   * si accorge che una Telecamera e stata girata e questo: un fotogramma
   * chiave la cui geometria ha scambiato gli assi rispetto all'ultima vista.
   *
   * Si confronta l'**orientamento**, non la geometria. Con `streamRes: "auto"`
   * la geometria cambia da sola a ogni rebind (1024x576 -> 720x480, ADR 0012)
   * senza che nessuno abbia toccato il telefono, e scriverlo nel Diario ogni
   * volta sarebbe rumore; un cambio di verso, invece, e quasi sempre una mano
   * -- un telefono girato, caduto o rimontato -- ed e cio che l'Operatore
   * vuole sapere. Un giro di 180 gradi non scambia gli assi, e da qui non si
   * vede.
   */
  private annotaGeometria(id: string, unita: Uint8Array): void {
    const geometria = geometriaDi(unita)
    if (geometria === null) return
    const prima = this.geometrie.get(id)
    if (prima?.geometria === geometria) return
    const orientamento = orientamentoDi(geometria)
    let cambiatoIl = prima?.cambiatoIl ?? null
    // Se il fotogramma e diventato quello che Regia stessa ha appena chiesto
    // (ADR 0014), non c'e niente da segnalare: girare una Telecamera cambia la
    // geometria per definizione, e avvisarne l'Operatore sarebbe Regia che si
    // spaventa di se stessa.
    const chiesta = risoluzioneRipresa(this.sensori.get(id) ?? null)
    if (geometria !== chiesta && prima?.orientamento && orientamento && prima.orientamento !== orientamento) {
      cambiatoIl = new Date().toISOString()
      // Il nome si rilegge adesso: la sessione puo essere piu vecchia di una
      // rinomina, e il Diario deve dire il nome che l'Operatore vede.
      const nome = this.opzioni.progetto().telecamere.find((t) => t.id === id)?.nome ?? id
      this.opzioni.suDiario(
        'attenzione',
        `Il video di "${nome}" ha ruotato: il fotogramma e passato da ${prima.geometria} ` +
          `a ${geometria}.`,
      )
    }
    this.geometrie.set(id, { geometria, orientamento, cambiatoIl })
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
