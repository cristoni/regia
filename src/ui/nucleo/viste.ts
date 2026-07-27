/**
 * Le derivazioni dall'istantanea: da `Stato` a "cosa si vede".
 *
 * Stanno tutte qui, e sono tutte funzioni pure, per una ragione pratica: il
 * DOM non si puo collaudare con il test runner di Node, e queste sono le
 * uniche cose dell'interfaccia in cui si puo davvero sbagliare -- quale
 * pulsante e acceso, quali Suoni sono ammessi in una Zona, come si dispone una
 * griglia di sei celle. Il codice che tocca il DOM, sopra a queste, e sottile
 * abbastanza da non avere bisogno di prove.
 */
import type { Stato, SuonoVivo, TelecameraViva, ZonaViva } from '../../engine/api/protocollo'

// ------------------------------------------------------- il passo del Flusso

/**
 * Sopra quanti millisecondi di ritardo al secondo si avvisa l'Operatore.
 *
 * Cinque su mille sono lo 0,5% del tempo reale, e sotto quella soglia non c'e
 * niente da dire: un singolo intoppo -- un garbage collector, un disco che si
 * ferma -- si spalma sulla finestra di trenta secondi e non arriva qui. Quel
 * che deve accendersi e la condizione **cronica**, che e l'unica che si sente:
 * a 25 ms al secondo i client tagliano una quarantina di volte al secondo.
 *
 * Quel 25 e una misura, non una stima, ma e una misura fatta in **un** caso --
 * l'orologio della distro WSL andato storto dopo una sospensione del PC. La
 * soglia vale ovunque; l'aneddoto no: una Sede locale su Linux non ha quel
 * meccanismo, e li un ritardo cronico avra un'altra causa da cercare.
 */
export const SOGLIA_RITARDO_MS_AL_SECONDO = 5

/**
 * A che percentuale del tempo reale sta scorrendo il Flusso di una Zona.
 *
 * `null` quando non c'e niente da mostrare: e il caso normale, e una scheda
 * senza numeri e una scheda che va bene.
 */
export function passoDelFlusso(zona: ZonaViva): number | null {
  if (zona.ritardoMsAlSecondo < SOGLIA_RITARDO_MS_AL_SECONDO) return null
  return Math.max(0, Math.round(100 - zona.ritardoMsAlSecondo / 10))
}

// ------------------------------------------------------------------ Suoni

/**
 * Gli Effetti utilizzabili in una Zona.
 *
 * `suoniAbilitati === null` significa "tutta la libreria", che e il valore
 * iniziale e quello che vuole quasi sempre chi non ci ha pensato. Un elenco
 * vuoto e invece una scelta: quella Zona non ha Effetti.
 */
export function effettiDellaZona(stato: Stato, zona: ZonaViva): SuonoVivo[] {
  if (zona.suoniAbilitati === null) return [...stato.suoni]
  const ammessi = new Set(zona.suoniAbilitati)
  return stato.suoni.filter((s) => ammessi.has(s.id))
}

/** Vero se il pulsante di questo Suono deve illuminarsi in questa Zona (§5.2). */
export function inCorso(zona: ZonaViva, suonoId: string): boolean {
  return zona.effettiInCorso.some((e) => e.suonoId === suonoId)
}

/**
 * I tasti rapidi, e i doppioni.
 *
 * Due Suoni sullo stesso tasto sono una svista di Setup che si scopre solo
 * premendolo, cioe la sera. Meglio dirlo prima: la mappa tiene il primo, e
 * l'elenco dei conflitti va mostrato nella schermata Suoni.
 */
export function scorciatoie(stato: Stato): {
  perTasto: Map<string, string>
  conflitti: { tasto: string; suoni: string[] }[]
} {
  const perTasto = new Map<string, string>()
  const tutti = new Map<string, string[]>()
  for (const s of stato.suoni) {
    if (!s.tastoRapido) continue
    const t = s.tastoRapido.toUpperCase()
    if (!perTasto.has(t)) perTasto.set(t, s.id)
    tutti.set(t, [...(tutti.get(t) ?? []), s.nome])
  }
  const conflitti = [...tutti.entries()]
    .filter(([, nomi]) => nomi.length > 1)
    .map(([tasto, suoni]) => ({ tasto, suoni }))
  return { perTasto, conflitti }
}

// ------------------------------------------------------------------ Video

export interface CellaVideo {
  readonly telecamera: TelecameraViva
  /** Il nome della Zona da sovraimprimere, o `null` se non assegnata. */
  readonly zona: string | null
  readonly colore: string
}

/**
 * Le celle della griglia video, raggruppate per Zona (§3.6).
 *
 * L'ordine e quello delle Zone, non quello alfabetico delle Telecamere: chi
 * guarda la griglia sta cercando una **stanza**, e le stanze hanno l'ordine
 * che l'Operatore ha dato loro. Le non assegnate vanno in fondo, dove non
 * disturbano ma si vedono -- a meta Setup sono la maggioranza.
 */
export function celleVideo(stato: Stato): CellaVideo[] {
  const zone = new Map(stato.zone.map((z, i) => [z.id, { z, i }]))
  return [...stato.telecamere]
    .sort((a, b) => {
      const za = a.zonaId ? (zone.get(a.zonaId)?.i ?? 99) : 99
      const zb = b.zonaId ? (zone.get(b.zonaId)?.i ?? 99) : 99
      return za - zb || a.nome.localeCompare(b.nome)
    })
    .map((t) => {
      const z = t.zonaId ? zone.get(t.zonaId)?.z : undefined
      return { telecamera: t, zona: z?.nome ?? null, colore: z?.colore ?? '#555a66' }
    })
}

/**
 * Quante colonne per N celle.
 *
 * Il §3.6 chiede "layout automatico (1, 2, 4, 6, 9 celle)". Si ragiona a
 * colonne perche le celle hanno rapporto fisso e il posto e largo: due righe da
 * tre stanno meglio di tre righe da due su un 16:9, che e il monitor che c'e.
 */
export function colonneGriglia(quante: number): number {
  if (quante <= 1) return 1
  if (quante <= 4) return 2
  if (quante <= 9) return 3
  return 4
}

// ------------------------------------------------------------ diagnostica

// Il tipo vive nel contratto (`api/protocollo.ts`): qui si ri-esporta perche le
// schermate lo hanno sempre importato da questo modulo.
export type { Livello } from '../../engine/api/protocollo'
import type { Livello } from '../../engine/api/protocollo'

export interface Salute {
  readonly livello: Livello
  readonly testo: string
}

/**
 * Il riassunto della barra di stato (§3.10).
 *
 * Dice **una** cosa, la peggiore: durante l'Evento l'Operatore guarda quella
 * barra con la coda dell'occhio, e un elenco di sei righe non lo guarda
 * nessuno. Il dettaglio sta nelle altre schermate.
 */
export function salute(stato: Stato): Salute {
  const grave = stato.avvisi.find((a) => a.livello === 'grave')
  if (grave) return { livello: 'grave', testo: grave.testo }

  if (stato.server === 'caduto') {
    return { livello: 'grave', testo: 'Il server audio non risponde: gli Altoparlanti sono muti.' }
  }
  if (stato.registrazione.bloccata) {
    return { livello: 'grave', testo: 'Spazio su disco esaurito: la registrazione e bloccata.' }
  }

  const persi = stato.altoparlanti.filter((a) => a.zonaId && !a.collegato)
  if (persi.length > 0) {
    return {
      livello: 'attenzione',
      testo:
        persi.length === 1
          ? `Altoparlante "${persi[0]!.nome}" non collegato.`
          : `${persi.length} Altoparlanti non collegati.`,
    }
  }
  const spente = stato.telecamere.filter((t) => t.zonaId && !t.raggiungibile)
  if (spente.length > 0) {
    return {
      livello: 'attenzione',
      testo:
        spente.length === 1
          ? `Telecamera "${spente[0]!.nome}" non raggiungibile.`
          : `${spente.length} Telecamere non raggiungibili.`,
    }
  }
  // Uno scrittore che non e `attivo` e una Zona che non sta suonando, anche se
  // nessun altro indicatore lo dice: i pulsanti si illuminano lo stesso, il
  // mixer lavora lo stesso, e dagli Altoparlanti non esce niente.
  const mute = stato.zone.filter((z) => z.scrittore !== 'attivo' && z.altoparlantiTotali > 0)
  if (mute.length > 0) {
    return {
      livello: 'grave',
      testo:
        `Flusso non attivo in ${mute.length === 1 ? `"${mute[0]!.nome}"` : `${mute.length} Zone`}` +
        ` (${mute[0]!.scrittore}): da li non esce audio.`,
    }
  }

  // Non "Flusso interrotto": il Flusso non ha buchi. Sta scorrendo piu lento
  // del tempo reale, e cio che l'Operatore sente sono i telefoni che tagliano
  // campioni per stare in pari. Dirgli "interrotto" gli farebbe cercare un
  // guasto di rete che non c'e.
  const indietro = stato.zone.filter((z) => z.ritardoMsAlSecondo >= SOGLIA_RITARDO_MS_AL_SECONDO)
  if (indietro.length > 0) {
    const peggiore = indietro.reduce((a, b) =>
      b.ritardoMsAlSecondo > a.ritardoMsAlSecondo ? b : a,
    )
    const dove =
      indietro.length === 1 ? `"${peggiore.nome}"` : `${indietro.length} Zone (peggio ${peggiore.nome})`
    return {
      livello: 'attenzione',
      testo:
        `Il Flusso di ${dove} non tiene il tempo reale ` +
        `(${Math.round(peggiore.ritardoMsAlSecondo)} ms al secondo): ` +
        'gli Altoparlanti compensano tagliando, e si sente.',
    }
  }
  if (stato.registrazione.sottoAvviso) {
    return {
      livello: 'attenzione',
      testo: `Restano ${stato.registrazione.spazioLiberoGb.toFixed(1)} GB di spazio su disco.`,
    }
  }
  const attenzione = stato.avvisi.find((a) => a.livello === 'attenzione')
  if (attenzione) return { livello: 'attenzione', testo: attenzione.testo }

  if (stato.server !== 'acceso') {
    return { livello: 'info', testo: `Server audio: ${stato.server}.` }
  }
  return {
    livello: 'info',
    testo:
      `${stato.zone.length} Zone, ` +
      `${stato.altoparlanti.filter((a) => a.collegato).length}/${stato.altoparlanti.length} Altoparlanti, ` +
      `${stato.telecamere.filter((t) => t.raggiungibile).length}/${stato.telecamere.length} Telecamere.`,
  }
}

/**
 * Le righe del primo passo del Setup: com'e messa questa macchina (§3.8).
 *
 * Sta qui e non nella schermata perche e la derivazione piu ramificata che
 * l'interfaccia abbia -- piattaforma per Sede per snapserver per versione -- ed
 * e anche quella in cui una riga sbagliata si paga peggio: chi la legge sta
 * decidendo cosa installare, e una frase falsa lo manda a installare la cosa
 * sbagliata. La schermata la stampa e basta.
 *
 * `piattaforma` viene dal motore e non da `navigator`: con `--rete`
 * l'interfaccia vera gira via HTTP, e il tablet della Fase 3 e un secondo
 * client che puo essere qualunque cosa mentre il motore e su Linux. Dedurre il
 * sistema dal proprio ambiente darebbe la risposta giusta solo per caso.
 */
export function righeAmbiente(stato: Stato): Salute[] {
  const a = stato.ambiente

  // Prima del primo controllo l'istantanea e ancora quella vuota: ffmpeg
  // `null`, nessuna porta, nessun indirizzo. Stamparne le righe direbbe
  // "ffmpeg non trovato" di una macchina che non e stata ancora guardata.
  if (a.sede === 'sconosciuta') {
    return [{ livello: 'info', testo: 'L\'ambiente non e ancora stato controllato.' }]
  }

  const righe: Salute[] = []

  if (a.sede === 'assente') {
    const motivo = a.sedeMotivo ?? `${a.sedeDescrizione} non e utilizzabile`
    // ⚠️ **Il rimedio arriva dal motore, e non si indovina qui.** Su Windows i
    // casi sono due e si somigliano soltanto da fuori: "WSL non c'e" si rimedia
    // con `wsl --install`, Virtual Machine Platform e un riavvio; "WSL c'e ma
    // non quella distro" -- che e il primo avvio piu comune -- si rimedia con
    // un menu a tendina in Impostazioni. Dedurlo dal testo del motivo voleva
    // dire dare il primo consiglio anche al secondo, cioe far riavviare il PC
    // per niente. Chi ha fatto la diagnosi sa qual e il rimedio, e lo manda.
    righe.push({
      livello: 'grave',
      testo: a.sedeRimedio ? `${motivo}. ${a.sedeRimedio}` : `${motivo}.`,
    })
  } else {
    righe.push({ livello: 'info', testo: `La Sede del server audio c'e: ${a.sedeDescrizione}.` })
  }

  // Dentro una Sede che non c'e non si e guardato: dire "snapserver non
  // trovato" sarebbe un secondo allarme per lo stesso guasto, e per giunta uno
  // che nessuno ha verificato.
  if (a.sede === 'ok') righe.push(rigaSnapserver(a))

  righe.push(
    a.ffmpeg
      ? { livello: a.ffmpeg.includes('PATH') ? 'attenzione' : 'info', testo: `ffmpeg: ${a.ffmpeg}` }
      : { livello: 'attenzione', testo: 'ffmpeg non trovato: la registrazione non funzionera.' },
  )

  if (a.porteOccupate.length > 0) {
    // Dove la Sede e locale il nostro stesso snapserver tiene le porte, e da
    // qui si vedono: a server acceso e la condizione normale, non un allarme.
    // Su Windows snapserver ascolta dentro la distro, ma il ponte di Regia
    // (ADR 0010) tiene le stesse porte da questa parte, quindi vale uguale.
    const nostre = stato.server === 'acceso'
    righe.push({
      livello: nostre ? 'info' : 'attenzione',
      testo:
        `Porte gia occupate: ${a.porteOccupate.join(', ')}. ` +
        (nostre
          ? 'Il server audio e acceso: sono quasi certamente le sue. Non c\'e niente da fare.'
          : 'Se e il server audio di una sessione precedente va bene; altrimenti qualcosa le sta usando' +
            // Su Linux il "qualcosa" ha quasi sempre un nome: il servizio
            // snapserver che molte distribuzioni installano e avviano da soli.
            // Regia lo nomina anche quando prova ad accendere il suo; qui lo
            // si anticipa, perche e la riga che l'Operatore legge per prima.
            (a.piattaforma === 'linux'
              ? ' -- su Linux di solito un servizio "snapserver" di sistema, che si toglie con ' +
                '"sudo systemctl disable --now snapserver".'
              : '.')),
    })
  }

  if (a.indirizzi.length > 0 && a.indirizzi.every((i) => i.senzaFili)) {
    righe.push({
      livello: 'attenzione',
      testo:
        'Il PC e collegato solo via Wi-Fi. Otto Altoparlanti in PCM stereo sono 11,3 Mbit/s ' +
        'continui, piu il video: collega il PC via cavo e tieni i telefoni sul 5 GHz.',
    })
  }
  return righe
}

/**
 * Snapserver: c'e, non c'e, o c'e ma non capisce il file che sappiamo scrivere.
 *
 * Il terzo caso e l'unico che non si vede da solo, ed e quello che il Setup
 * esiste per prendere: dalla 0.33 la sezione `[tcp]` si chiama `[tcp-control]`.
 * Una versione precedente legge la nostra configurazione, ignora in silenzio
 * meta delle sezioni, parte lo stesso e ascolta sulle porte sue -- nessun
 * errore nel log, e i telefoni che non si collegano si scoprono a meta serata.
 */
function rigaSnapserver(a: Stato['ambiente']): Salute {
  if (a.snapserver === null) {
    return {
      livello: 'grave',
      testo:
        `Snapserver non si trova dove deve girare (${a.sedeDescrizione}): senza, nessun ` +
        'telefono puo suonare. Se e installato altrove, indica il binario nella variabile ' +
        'd\'ambiente REGIA_SNAPSERVER.',
    }
  }
  if (a.snapserverVecchio) {
    return {
      livello: 'grave',
      testo:
        `Snapserver ${a.snapserver} (${a.sedeDescrizione}) e troppo vecchio: dalla 0.33 la ` +
        'sezione [tcp] si chiama [tcp-control]. Una versione precedente legge la nostra ' +
        'configurazione, ne ignora meta in silenzio, parte lo stesso e ascolta sulle porte ' +
        'sbagliate: nessun errore nel log, e la serata si rompe piu tardi. E la 0.27.0 che ' +
        'da l\'apt di Ubuntu 24.04: serve la 0.35, oppure indica un altro binario in ' +
        'REGIA_SNAPSERVER.',
    }
  }
  // La ricerca riporta il binario anche quando `-v` non dice una versione, e
  // `snapserverVecchio` in quel caso resta falso -- non si blocca su un
  // sospetto. Non sapere che numero e pero non e sapere che va bene: una 0.27
  // muta finirebbe esattamente qui, e passerebbe per buona senza questa riga.
  if (!/^\d/.test(a.snapserver)) {
    return {
      livello: 'attenzione',
      testo:
        `Snapserver c'e (${a.sedeDescrizione}) ma non dice la propria versione: non si puo ` +
        'escludere che sia precedente alla 0.33, che leggerebbe meta configurazione ' +
        'ignorando l\'altra meta senza dirlo.',
    }
  }
  return { livello: 'info', testo: `Snapserver ${a.snapserver} trovato (${a.sedeDescrizione}).` }
}

/**
 * Cosa manca perche il Setup sia finito (§3.8, passo 7).
 *
 * Non sono errori: sono le cose che a fine pomeriggio si vogliono aver
 * guardato. Una Zona senza Altoparlanti e legittima -- puo essere solo video --
 * ma se sono tutte cosi qualcuno si e dimenticato qualcosa.
 */
export function riepilogoSetup(stato: Stato): { livello: Livello; testo: string }[] {
  const fuori: { livello: Livello; testo: string }[] = []

  if (stato.zone.length === 0) {
    fuori.push({ livello: 'attenzione', testo: 'Non c\'e nessuna Zona: creane almeno una.' })
  }
  for (const z of stato.zone) {
    if (z.altoparlantiTotali === 0 && z.telecamereTotali === 0) {
      fuori.push({ livello: 'attenzione', testo: `La Zona "${z.nome}" non ha nessun dispositivo.` })
    } else if (z.altoparlantiTotali === 0) {
      fuori.push({ livello: 'info', testo: `La Zona "${z.nome}" e solo video.` })
    }
  }
  const nonAssegnati = stato.altoparlanti.filter((a) => !a.zonaId)
  if (nonAssegnati.length > 0) {
    fuori.push({
      livello: 'info',
      testo: `${nonAssegnati.length} Altoparlanti non assegnati. E lo stato normale a meta Setup.`,
    })
  }
  for (const t of stato.telecamere) {
    if (t.batteria !== null && t.batteria < 30) {
      fuori.push({
        livello: 'attenzione',
        testo: `"${t.nome}" e al ${t.batteria}% di batteria: mettila in carica.`,
      })
    }
    if (t.segnale !== null && t.segnale < 30) {
      fuori.push({ livello: 'attenzione', testo: `"${t.nome}" ha un segnale Wi-Fi debole.` })
    }
  }
  if (stato.suoni.length === 0) {
    fuori.push({ livello: 'attenzione', testo: 'La libreria e vuota: importa qualche Suono.' })
  }
  const senzaSottofondo = stato.zone.filter((z) => !z.sottofondoId)
  if (stato.zone.length > 0 && senzaSottofondo.length === stato.zone.length) {
    fuori.push({ livello: 'info', testo: 'Nessuna Zona ha un Sottofondo.' })
  }

  // La banda e il collo di bottiglia, non la CPU: otto Altoparlanti in PCM
  // stereo sono 11,3 Mbit/s continui anche a casa vuota.
  const senzaFili = stato.ambiente.indirizzi.filter((i) => i.senzaFili)
  if (senzaFili.length > 0 && stato.ambiente.indirizzi.every((i) => i.senzaFili)) {
    fuori.push({
      livello: 'attenzione',
      testo: 'Il PC e su Wi-Fi. Con questa banda serve il cavo: collegalo prima dell\'Evento.',
    })
  }
  return fuori
}

// ------------------------------------------------------------ formattazione

export function durata(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms} ms`
  const secondi = ms / 1000
  if (secondi < 60) return `${secondi.toFixed(1)} s`
  const m = Math.floor(secondi / 60)
  const s = Math.round(secondi % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function byte(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

export function ora(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function quandoCompleto(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('it-IT', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

/** Da quanto non si vede piu, in parole. Il §8.8 vuole "entro 10 s l'app lo segnala". */
export function daQuando(iso: string | null, adesso = Date.now()): string {
  if (!iso) return 'mai visto'
  const quanto = adesso - new Date(iso).getTime()
  if (Number.isNaN(quanto)) return 'mai visto'
  if (quanto < 10_000) return 'adesso'
  if (quanto < 60_000) return `${Math.round(quanto / 1000)} s fa`
  if (quanto < 3_600_000) return `${Math.round(quanto / 60_000)} min fa`
  return `${Math.round(quanto / 3_600_000)} h fa`
}
