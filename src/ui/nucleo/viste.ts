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
 * a 25 ms al secondo (il caso misurato, orologio della distro storto) i client
 * tagliano una quarantina di volte al secondo.
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

export type Livello = 'info' | 'attenzione' | 'grave'

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
