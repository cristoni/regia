/**
 * Le derivazioni dell'interfaccia, provate senza un DOM.
 *
 * E l'unico posto dell'interfaccia in cui si puo davvero sbagliare qualcosa che
 * si nota solo la sera: quale pulsante e acceso, quali Suoni sono ammessi in
 * una Zona, cosa dice la barra di stato quando le cose vanno male insieme.
 * Il codice che tocca il DOM, sopra a queste, e sottile abbastanza da non
 * avere bisogno di prove.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type {
  AmbienteVivo,
  Stato,
  SuonoVivo,
  TelecameraViva,
  ZonaViva,
} from '../../engine/api/protocollo'
import {
  FINESTRA_ROTAZIONE_MS,
  celleVideo,
  colonneGriglia,
  daQuando,
  descriviGeometria,
  effettiDellaZona,
  inCorso,
  passoDelFlusso,
  riepilogoSetup,
  righeAmbiente,
  ruotataDaPoco,
  ruotateDiRecente,
  salute,
  scorciatoie,
} from './viste'

function suono(id: string, extra: Partial<SuonoVivo> = {}): SuonoVivo {
  return {
    id, nome: id, colore: '#ff0000', categoria: null, durataMs: 1000,
    tastoRapido: null, pronto: true, guadagno: 1, ...extra,
  }
}

function zona(id: string, extra: Partial<ZonaViva> = {}): ZonaViva {
  return {
    id, nome: id, colore: '#112233', volume: 1, sottofondoId: null,
    effettiInCorso: [], altoparlantiCollegati: 1, altoparlantiTotali: 1,
    telecamereCollegate: 0, telecamereTotali: 0, ritardoMsAlSecondo: 0,
    suoniAbilitati: null, flusso: id, scrittore: 'attivo', scartoMs: 200, ...extra,
  }
}

/**
 * La macchina come la vede il Setup. Il caso base e Windows con tutto a posto,
 * perche e quello su cui Regia e nata; le prove sulla Sede locale cambiano
 * `piattaforma`, `sede` e `distro` e lasciano stare il resto.
 */
function ambiente(extra: Partial<AmbienteVivo> = {}): AmbienteVivo {
  return {
    piattaforma: 'windows',
    sede: 'ok',
    sedeDescrizione: 'la distro "Regia"',
    sedeMotivo: null,
    sedeRimedio: null,
    distro: 'Regia',
    snapserver: '0.35.0',
    snapserverVecchio: false,
    ffmpeg: '7.1',
    porteOccupate: [],
    indirizzi: [],
    controllatoIl: '2026-09-09T18:00:00Z',
    ...extra,
  }
}

function stato(extra: Partial<Stato> = {}): Stato {
  return {
    progettoNome: 'Casa', server: 'acceso', zone: [], altoparlanti: [], telecamere: [],
    suoni: [], registrazione: { attive: 0, spazioLiberoGb: 100, sottoAvviso: false, bloccata: false, cartella: 'C:/Video' },
    audio: { bufferMs: 2000, codec: 'pcm', bandaMbit: 11.3 },
    impostazioni: {
      audio: {
        bufferMs: 2000, codec: 'pcm', frequenza: 44100, canali: 2, portaBaseFlussi: 4953,
        bloccoMs: 20, dissolvenzaMs: 15, anticipoMs: 200, idleThresholdMs: 2000,
      },
      server: { distro: 'Regia', portaControllo: 1705, portaHttp: 1780, portaFlussoClient: 1704 },
      registrazione: { cartella: 'C:/Video', minutiSegmento: 10, conAudio: false, avvisoSpazioGb: 20, bloccoSpazioGb: 5 },
    },
    ambiente: ambiente(),
    latenzaAttesaMs: 2200,
    avvisi: [],
    ...extra,
  }
}

describe('Suoni ammessi in una Zona', () => {
  const s = stato({ suoni: [suono('s1'), suono('s2'), suono('s3')] })

  it('null significa tutta la libreria, e non "nessuno"', () => {
    assert.deepEqual(
      effettiDellaZona(s, zona('z1', { suoniAbilitati: null })).map((x) => x.id),
      ['s1', 's2', 's3'],
    )
  })

  it('un elenco vuoto e una scelta: quella Zona non ha Effetti', () => {
    assert.deepEqual(effettiDellaZona(s, zona('z1', { suoniAbilitati: [] })), [])
  })

  it('tiene l ordine della libreria, non quello dell elenco abilitati', () => {
    assert.deepEqual(
      effettiDellaZona(s, zona('z1', { suoniAbilitati: ['s3', 's1'] })).map((x) => x.id),
      ['s1', 's3'],
    )
  })

  it('ignora un Suono abilitato che non esiste piu', () => {
    assert.deepEqual(
      effettiDellaZona(s, zona('z1', { suoniAbilitati: ['s1', 'sparito'] })).map((x) => x.id),
      ['s1'],
    )
  })
})

describe('il pulsante che si illumina', () => {
  it('e acceso finche l Effetto e in corso in quella Zona', () => {
    const z = zona('z1', { effettiInCorso: [{ suonoId: 's1', istanza: 3 }] })
    assert.equal(inCorso(z, 's1'), true)
    assert.equal(inCorso(z, 's2'), false)
  })

  it('resta acceso con piu istanze dello stesso Suono sovrapposte', () => {
    const z = zona('z1', {
      effettiInCorso: [
        { suonoId: 's1', istanza: 1 },
        { suonoId: 's1', istanza: 2 },
      ],
    })
    assert.equal(inCorso(z, 's1'), true)
  })
})

describe('tasti rapidi', () => {
  it('trova i doppioni invece di lasciarli scoprire premendo', () => {
    const s = stato({
      suoni: [
        suono('s1', { nome: 'Urlo', tastoRapido: 'F1' }),
        suono('s2', { nome: 'Botto', tastoRapido: 'f1' }),
        suono('s3', { nome: 'Risata', tastoRapido: 'F2' }),
      ],
    })
    const { perTasto, conflitti } = scorciatoie(s)
    assert.equal(perTasto.get('F1'), 's1')
    assert.equal(perTasto.get('F2'), 's3')
    assert.equal(conflitti.length, 1)
    assert.deepEqual(conflitti[0], { tasto: 'F1', suoni: ['Urlo', 'Botto'] })
  })
})

describe('la griglia video', () => {
  it('raggruppa per Zona nell ordine delle Zone, non in ordine alfabetico', () => {
    const s = stato({
      zone: [zona('z1', { nome: 'Ingresso' }), zona('z2', { nome: 'Cantina' })],
      telecamere: [
        telecamera('t1', 'Zeta', 'z2'),
        telecamera('t2', 'Alfa', 'z1'),
        telecamera('t3', 'Beta', null),
      ],
    })
    assert.deepEqual(
      celleVideo(s).map((c) => c.telecamera.id),
      ['t2', 't1', 't3'],
    )
    assert.equal(celleVideo(s)[2]!.zona, null)
  })

  it('sceglie le colonne come chiede il §3.6', () => {
    assert.deepEqual([1, 2, 4, 6, 9, 12].map(colonneGriglia), [1, 2, 2, 3, 3, 4])
  })

  it('descrive il fotogramma misurato, non la risoluzione chiesta al telefono', () => {
    // `dettagli.risoluzione` e la preferenza sul telefono e puo dire "auto".
    // E non si scrive "verticale"/"orizzontale": quella parola prometterebbe
    // di sapere come sta l'immagine dentro il fotogramma, e da un SPS non si
    // vede -- il telefono puo impaginarne una verticale dentro un fotogramma
    // orizzontale fra due bande nere (ADR 0013, correzione).
    const t = telecamera('t1', 'Ingresso', null, {
      geometria: '720x1280', orientamento: 'verticale',
      dettagli: {
        torcia: false, haFlash: true, risoluzione: 'auto', fps: 20,
        obiettivo: '0', obiettiviDisponibili: [], risoluzioniDisponibili: [],
      },
    })
    assert.equal(descriviGeometria(t), '720×1280')
    assert.equal(descriviGeometria(telecamera('t2', 'Cantina', null)), null)
  })

  it('una Telecamera e "ruotata da poco" per un minuto, poi no', () => {
    const adesso = Date.parse('2026-09-19T21:00:00Z')
    const t = telecamera('t1', 'Ingresso', null, {
      orientamento: 'orizzontale', orientamentoCambiatoIl: '2026-09-19T20:59:30Z',
    })
    assert.equal(ruotataDaPoco(t, adesso), true)
    assert.equal(ruotataDaPoco(t, adesso + FINESTRA_ROTAZIONE_MS), false)
    assert.equal(ruotataDaPoco(telecamera('t2', 'Cantina', null), adesso), false)
    // Una data rotta non deve ne lanciare ne restare accesa per sempre.
    assert.equal(ruotataDaPoco(telecamera('t3', 'Bagno', null, { orientamentoCambiatoIl: 'ieri' }), adesso), false)
  })

  it('un client con l orologio indietro non tiene acceso l avviso per lo sfasamento', () => {
    // L'istante lo scrive il motore, il confronto lo fa il client -- e il
    // tablet della Fase 3 non e la macchina del motore. Senza il `>= 0` un
    // client indietro di dieci minuti avrebbe tenuto l'avviso acceso per dieci
    // minuti e un secondo su una Telecamera ferma.
    const cambiato = '2026-09-19T21:00:00Z'
    const t = telecamera('t1', 'Ingresso', null, { orientamento: 'verticale', orientamentoCambiatoIl: cambiato })
    const indietro = Date.parse(cambiato) - 10 * 60_000
    assert.equal(ruotataDaPoco(t, indietro), false)
    assert.equal(ruotataDaPoco(t, Date.parse(cambiato)), true)
  })

  it('le ruotate di recente vengono con l ultima per prima', () => {
    const adesso = Date.parse('2026-09-19T21:00:00Z')
    const s = stato({
      telecamere: [
        telecamera('t1', 'Ingresso', null, { orientamento: 'orizzontale', orientamentoCambiatoIl: '2026-09-19T20:59:10Z' }),
        telecamera('t2', 'Cantina', null, { orientamento: 'verticale', orientamentoCambiatoIl: '2026-09-19T20:59:40Z' }),
        telecamera('t3', 'Bagno', null, { orientamento: 'verticale', orientamentoCambiatoIl: '2026-09-19T20:50:00Z' }),
      ],
    })
    assert.deepEqual(ruotateDiRecente(s, adesso).map((t) => t.id), ['t2', 't1'])
  })
})

describe('la barra di stato', () => {
  it('dice la cosa peggiore, non la prima', () => {
    const s = stato({
      server: 'caduto',
      zone: [zona('z1', { ritardoMsAlSecondo: 40 })],
      registrazione: { attive: 0, spazioLiberoGb: 1, sottoAvviso: true, bloccata: true, cartella: 'C:/V' },
    })
    assert.equal(salute(s).livello, 'grave')
    assert.match(salute(s).testo, /server audio/)
  })

  it('tace su un Flusso che tiene il tempo reale', () => {
    // Zero e la condizione normale, e prima qui usciva "Flusso interrotto"
    // acceso fisso: un allarme falso durante uno spettacolo.
    const s = stato({ zone: [zona('z1', { ritardoMsAlSecondo: 0 })] })
    assert.equal(salute(s).livello, 'info')
    assert.equal(passoDelFlusso(zona('z1', { ritardoMsAlSecondo: 0 })), null)
  })

  it('tace anche su un ritardo sotto la soglia: non si allarma per un intoppo', () => {
    const s = stato({ zone: [zona('z1', { ritardoMsAlSecondo: 4 })] })
    assert.equal(salute(s).livello, 'info')
    assert.equal(passoDelFlusso(zona('z1', { ritardoMsAlSecondo: 4 })), null)
  })

  it('dice che il Flusso non tiene il tempo reale, non che e interrotto', () => {
    const s = stato({ zone: [zona('z1', { ritardoMsAlSecondo: 25 })] })
    const v = salute(s)
    assert.equal(v.livello, 'attenzione')
    assert.match(v.testo, /non tiene il tempo reale/)
    assert.match(v.testo, /25 ms al secondo/)
    assert.doesNotMatch(v.testo, /interrott|pers/i, 'non deve promettere audio mancante')
    // 25 ms al secondo sono il 2,5% del tempo reale: il caso misurato.
    assert.equal(passoDelFlusso(zona('z1', { ritardoMsAlSecondo: 25 })), 98)
  })

  it('con piu Zone indietro nomina la peggiore', () => {
    const s = stato({
      zone: [
        zona('z1', { ritardoMsAlSecondo: 8 }),
        zona('z2', { ritardoMsAlSecondo: 40 }),
        zona('z3', { ritardoMsAlSecondo: 0 }),
      ],
    })
    const v = salute(s)
    assert.match(v.testo, /2 Zone/)
    assert.match(v.testo, /peggio z2/)
    assert.match(v.testo, /40 ms al secondo/)
  })

  it('non si lamenta di un Altoparlante non assegnato: e lo stato normale', () => {
    const s = stato({
      altoparlanti: [
        { id: 'a1', nome: 'Cassa', zonaId: null, collegato: false, volume: 1, muto: false, latenzaMs: 0, indirizzo: null, vistoIl: '', inIdentificazione: false },
      ],
    })
    assert.equal(salute(s).livello, 'info')
  })

  it('segnala un Altoparlante assegnato che non c e piu', () => {
    const s = stato({
      zone: [zona('z1')],
      altoparlanti: [
        { id: 'a1', nome: 'Cucina', zonaId: 'z1', collegato: false, volume: 1, muto: false, latenzaMs: 0, indirizzo: null, vistoIl: '', inIdentificazione: false },
      ],
    })
    assert.equal(salute(s).livello, 'attenzione')
    assert.match(salute(s).testo, /Cucina/)
  })

  it('segnala per un minuto una Telecamera che ha cambiato verso, poi tace', () => {
    // Un telefono girato durante l'Evento e quasi sempre un telefono che
    // qualcuno ha toccato: si dice, ma e un evento, non una condizione.
    const adesso = Date.parse('2026-09-19T21:00:00Z')
    const s = stato({
      zone: [zona('z1', { nome: 'Ingresso' })],
      telecamere: [
        telecamera('t1', 'Occhio', 'z1', {
          geometria: '1280x720', orientamento: 'orizzontale',
          orientamentoCambiatoIl: '2026-09-19T20:59:30Z',
        }),
      ],
    })
    const v = salute(s, adesso)
    assert.equal(v.livello, 'attenzione')
    assert.match(v.testo, /Occhio/)
    assert.match(v.testo, /ha ruotato/)
    assert.match(v.testo, /1280x720/)
    // Non promette di sapere come sta l'immagine: quella parola era la bugia
    // vista sul telefono vero (ADR 0013, correzione).
    assert.doesNotMatch(v.testo, /verticale|orizzontale/)
    assert.equal(salute(s, adesso + FINESTRA_ROTAZIONE_MS).livello, 'info')
  })

  it('con piu Telecamere ruotate le conta e nomina l ultima', () => {
    const adesso = Date.parse('2026-09-19T21:00:00Z')
    const s = stato({
      telecamere: [
        telecamera('t1', 'Ingresso', null, { orientamento: 'orizzontale', orientamentoCambiatoIl: '2026-09-19T20:59:10Z' }),
        telecamera('t2', 'Cantina', null, { orientamento: 'verticale', orientamentoCambiatoIl: '2026-09-19T20:59:40Z' }),
      ],
    })
    const v = salute(s, adesso)
    assert.match(v.testo, /2 Telecamere hanno ruotato/)
    assert.match(v.testo, /Cantina/)
  })

  it('una Telecamera ruotata non copre un Flusso muto, ma passa avanti al disco quasi pieno', () => {
    const adesso = Date.parse('2026-09-19T21:00:00Z')
    const ruotata = telecamera('t1', 'Occhio', null, {
      orientamento: 'verticale', orientamentoCambiatoIl: '2026-09-19T20:59:50Z',
    })
    const muta = stato({ zone: [zona('z1', { scrittore: 'caduto' })], telecamere: [ruotata] })
    assert.equal(salute(muta, adesso).livello, 'grave')
    assert.match(salute(muta, adesso).testo, /Flusso non attivo/)

    const disco = stato({
      telecamere: [ruotata],
      registrazione: { attive: 0, spazioLiberoGb: 3, sottoAvviso: true, bloccata: false, cartella: 'C:/V' },
    })
    assert.match(salute(disco, adesso).testo, /ha ruotato/)
    assert.match(salute(disco, adesso + FINESTRA_ROTAZIONE_MS).testo, /GB di spazio/)
  })
})

describe('il riepilogo del Setup', () => {
  it('distingue una Zona solo video da una Zona vuota', () => {
    const s = stato({
      suoni: [suono('s1')],
      zone: [
        zona('z1', { nome: 'Solo video', altoparlantiTotali: 0, telecamereTotali: 2, sottofondoId: 's1' }),
        zona('z2', { nome: 'Vuota', altoparlantiTotali: 0, telecamereTotali: 0, sottofondoId: 's1' }),
      ],
    })
    const righe = riepilogoSetup(s)
    assert.ok(righe.some((r) => r.livello === 'info' && /Solo video/.test(r.testo)))
    assert.ok(righe.some((r) => r.livello === 'attenzione' && /Vuota/.test(r.testo)))
  })

  it('avvisa quando il PC ha solo il Wi-Fi: la banda e il collo di bottiglia', () => {
    const s = stato({
      suoni: [suono('s1')],
      zone: [zona('z1', { sottofondoId: 's1' })],
      ambiente: ambiente({
        indirizzi: [{ interfaccia: 'Wi-Fi', ip: '192.168.1.4', senzaFili: true }],
      }),
    })
    assert.ok(riepilogoSetup(s).some((r) => /cavo/.test(r.testo)))
  })
})

describe('il primo passo del Setup: com e messa la macchina', () => {
  const testi = (s: Stato): string => righeAmbiente(s).map((r) => r.testo).join(' | ')

  it('prima del primo controllo non dichiara niente rotto', () => {
    // L'istantanea vuota ha ffmpeg `null` e nessun indirizzo: stampandola si
    // accuserebbe di guasti una macchina che nessuno ha ancora guardato.
    const righe = righeAmbiente(stato({ ambiente: ambiente({ sede: 'sconosciuta', ffmpeg: null }) }))
    assert.equal(righe.length, 1)
    assert.equal(righe[0]!.livello, 'info')
    assert.doesNotMatch(righe[0]!.testo, /ffmpeg/)
  })

  it('su Windows senza WSL dice anche come installarlo', () => {
    const s = stato({
      ambiente: ambiente({
        sede: 'assente',
        sedeMotivo: 'WSL non e installato: il server audio non puo partire (ADR 0002)',
        sedeRimedio:
          'Apri PowerShell come amministratore, lancia "wsl --install", poi riavvia. ' +
          'Serve anche Virtual Machine Platform, e la virtualizzazione abilitata da BIOS.',
        snapserver: null,
      }),
    })
    const righe = righeAmbiente(s)
    assert.equal(righe[0]!.livello, 'grave')
    assert.match(righe[0]!.testo, /WSL non e installato/)
    assert.match(righe[0]!.testo, /wsl --install/)
    assert.match(righe[0]!.testo, /riavvia/)
  })

  /**
   * Il caso che si era rotto, ed e il primo avvio piu comune su Windows: WSL
   * c'e gia -- lo hanno quasi tutti -- e manca solo la distro di Regia. Il
   * rimedio e un menu a tendina in Impostazioni; mandare qui l'Operatore a
   * fare `wsl --install` e a riavviare il PC vuol dire fargli perdere mezz'ora
   * per un guasto che si risolve in tre secondi. Il rimedio arriva dal motore
   * proprio perche di qui i due casi non si distinguono.
   */
  it('su Windows con WSL ma senza la distro non fa riavviare il PC per niente', () => {
    const s = stato({
      ambiente: ambiente({
        sede: 'assente',
        sedeMotivo: 'la distro "Regia" non c\'e. Distro disponibili: Ubuntu, Debian',
        sedeRimedio:
          "WSL c'e: scegli una delle distro disponibili in Impostazioni, oppure installa questa.",
        distro: null,
        snapserver: null,
      }),
    })
    const righe = righeAmbiente(s)
    assert.equal(righe[0]!.livello, 'grave')
    assert.match(righe[0]!.testo, /Distro disponibili: Ubuntu, Debian/)
    assert.match(righe[0]!.testo, /Impostazioni/)
    assert.doesNotMatch(testi(s), /wsl --install|riavvia|Virtual Machine Platform/i)
  })

  it('fuori da Windows non manda nessuno a lanciare wsl --install', () => {
    // La Sede locale non puo mancare, ma se il motivo arrivasse lo stesso il
    // rimedio di Windows sarebbe la frase che fa perdere la serata.
    const s = stato({
      ambiente: ambiente({
        piattaforma: 'linux',
        sede: 'assente',
        sedeDescrizione: 'questo PC',
        sedeMotivo: 'qualcosa non va',
        distro: null,
        snapserver: null,
      }),
    })
    assert.equal(righeAmbiente(s)[0]!.livello, 'grave')
    assert.doesNotMatch(testi(s), /wsl --install|PowerShell|Virtual Machine Platform/i)
  })

  it('senza Sede non si lamenta anche di snapserver: non e stato guardato', () => {
    // Un secondo allarme grave per lo stesso guasto, per giunta su una cosa
    // che nessuno ha potuto verificare: dentro una Sede che non c'e non si
    // guarda. Resta la riga della Sede, e quella di ffmpeg che vive a parte.
    const s = stato({
      ambiente: ambiente({ sede: 'assente', sedeMotivo: 'niente WSL', snapserver: null }),
    })
    assert.equal(righeAmbiente(s).filter((r) => r.livello === 'grave').length, 1)
    assert.doesNotMatch(testi(s), /non si trova dove deve girare|REGIA_SNAPSERVER/)
  })

  it('con la Sede locale nomina questo PC e non parla di distro', () => {
    const s = stato({
      ambiente: ambiente({ piattaforma: 'linux', sedeDescrizione: 'questo PC', distro: null }),
    })
    assert.match(testi(s), /questo PC/)
    assert.doesNotMatch(testi(s), /distro|WSL/i)
  })

  it('snapserver mancante dice dove non si trova e come indicarlo', () => {
    const s = stato({
      ambiente: ambiente({ piattaforma: 'linux', sedeDescrizione: 'questo PC', distro: null, snapserver: null }),
    })
    const riga = righeAmbiente(s).find((r) => /napserver/.test(r.testo))!
    assert.equal(riga.livello, 'grave')
    assert.match(riga.testo, /questo PC/)
    assert.match(riga.testo, /REGIA_SNAPSERVER/)
  })

  it('una 0.27 e grave, e la riga dice perche invece di dire solo "vecchia"', () => {
    // E il caso che il Setup esiste per prendere: parte, non da errori, e
    // ascolta sulle porte sue. Chi legge deve capire cosa sostituire.
    const s = stato({
      ambiente: ambiente({
        piattaforma: 'linux', sedeDescrizione: 'questo PC', distro: null,
        snapserver: '0.27.0', snapserverVecchio: true,
      }),
    })
    const riga = righeAmbiente(s).find((r) => /napserver/.test(r.testo))!
    assert.equal(riga.livello, 'grave')
    assert.match(riga.testo, /0\.33/)
    assert.match(riga.testo, /tcp-control/)
    assert.match(riga.testo, /0\.35/)
  })

  it('un binario che non dice la versione non passa per buono', () => {
    const s = stato({ ambiente: ambiente({ snapserver: 'versione sconosciuta' }) })
    const riga = righeAmbiente(s).find((r) => /napserver/.test(r.testo))!
    assert.equal(riga.livello, 'attenzione')
  })

  it('a server acceso le porte prese sono le nostre, non un allarme', () => {
    // Dove la Sede e locale il nostro snapserver tiene davvero quelle porte, e
    // da qui si vedono occupate a ogni Ricontrolla.
    const acceso = stato({
      server: 'acceso',
      ambiente: ambiente({ piattaforma: 'linux', sedeDescrizione: 'questo PC', distro: null, porteOccupate: [1704, 1705] }),
    })
    const spento = stato({
      server: 'spento',
      ambiente: ambiente({ piattaforma: 'linux', sedeDescrizione: 'questo PC', distro: null, porteOccupate: [1704, 1705] }),
    })
    assert.equal(righeAmbiente(acceso).find((r) => /Porte/.test(r.testo))!.livello, 'info')
    assert.equal(righeAmbiente(spento).find((r) => /Porte/.test(r.testo))!.livello, 'attenzione')
  })
})

describe('da quando non si vede', () => {
  const adesso = Date.parse('2026-09-09T21:00:00Z')
  it('dice "adesso" dentro i dieci secondi che il §8.8 concede', () => {
    assert.equal(daQuando('2026-09-09T20:59:55Z', adesso), 'adesso')
  })
  it('conta i secondi appena si supera la soglia', () => {
    assert.equal(daQuando('2026-09-09T20:59:45Z', adesso), '15 s fa')
  })
  it('regge una data che non c e', () => {
    assert.equal(daQuando(null, adesso), 'mai visto')
  })
})

function telecamera(
  id: string,
  nome: string,
  zonaId: string | null,
  extra: Partial<TelecameraViva> = {},
): TelecameraViva {
  return {
    id, nome, zonaId, host: '192.168.1.7', porta: 4444, raggiungibile: true,
    batteria: 80, segnale: 70, inRegistrazione: false, fpsAnteprima: 20,
    vistoIl: null, https: false, utente: null, conPassword: false,
    dettagli: null, geometria: null, orientamento: null, orientamentoCambiatoIl: null,
    rotazione: 0, inIdentificazione: false, ...extra,
  }
}
