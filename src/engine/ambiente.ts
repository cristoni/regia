/**
 * La fotografia della macchina, per il Setup guidato (§3.8, passo 1).
 *
 * Si rifa su richiesta e all'avvio, mai in continuo: interrogare la Sede costa
 * qualche centinaio di millisecondi -- su Windows `wsl.exe -l -q` da solo li
 * costa tutti -- e mostrarne il risultato dieci volte al secondo non lo
 * renderebbe piu vero. Per questo `AmbienteVivo` porta con se `controllatoIl`:
 * una fotografia vecchia di mezz'ora presentata come attuale e peggio di
 * nessuna fotografia.
 *
 * Il controllo delle porte e volutamente grezzo -- si prova ad ascoltare, e si
 * guarda se `EADDRINUSE` -- perche e l'unica prova che conta: se Regia riesce
 * ad aprire quella porta, il server ci riuscira. Un'analisi di `netstat` direbbe
 * cose vere e inutili.
 *
 * ⚠️ **A server acceso le porte risultano occupate, ed e giusto cosi.** Su
 * Windows snapserver ascolta dentro la distro e da Windows quelle porte
 * sembrano libere; su Linux ascolta qui, e le tredici porte dei Flussi piu la
 * 1704/1705/1780 risultano tutte prese -- dal nostro stesso server. Il Setup
 * lo dice invece di allarmare: la riga cambia parole a seconda di chi le tiene.
 */
import { createServer } from 'node:net'
import * as os from 'node:os'

import type { AmbienteVivo } from './api/protocollo.js'
import type { ImpostazioniServer } from './dominio/progetto.js'
import { sedeDi, versioneTroppoVecchia } from './snapcast/sede.js'
import { trovaFfmpeg } from './media/ffmpeg.js'

/** Su cosa gira Regia. L'interfaccia non puo dedurlo: puo essere un tablet. */
export function piattaformaCorrente(): AmbienteVivo['piattaforma'] {
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'linux') return 'linux'
  return 'altro'
}

const VUOTO: AmbienteVivo = {
  piattaforma: piattaformaCorrente(),
  sede: 'sconosciuta',
  sedeDescrizione: '',
  sedeMotivo: null,
  sedeRimedio: null,
  distro: null,
  snapserver: null,
  snapserverVecchio: false,
  ffmpeg: null,
  porteOccupate: [],
  indirizzi: [],
  controllatoIl: null,
}

export class Ambiente {
  private fotografia: AmbienteVivo = VUOTO
  private inCorso: Promise<AmbienteVivo> | null = null

  ultimo(): AmbienteVivo {
    return this.fotografia
  }

  /** Un controllo per volta: due in parallelo direbbero la stessa cosa due volte. */
  controlla(server: ImpostazioniServer, porte: readonly number[]): Promise<AmbienteVivo> {
    this.inCorso ??= this.davvero(server, porte).finally(() => {
      this.inCorso = null
    })
    return this.inCorso
  }

  private async davvero(
    server: ImpostazioniServer,
    porte: readonly number[],
  ): Promise<AmbienteVivo> {
    const sede = sedeDi(server)
    const manca = await sede.indisponibile()
    const trovato = manca === null ? await sede.snapserver() : null

    const ff = trovaFfmpeg(true)
    const occupate: number[] = []
    for (const p of porte) if (await occupata(p)) occupate.push(p)

    this.fotografia = {
      piattaforma: piattaformaCorrente(),
      sede: manca === null ? 'ok' : 'assente',
      sedeDescrizione: sede.descrizione,
      sedeMotivo: manca?.motivo ?? null,
      // Il rimedio lo sa chi ha fatto la diagnosi, non l'interfaccia: "WSL non
      // c'e" e "WSL c'e ma non quella distro" si somigliano da fuori e si
      // rimediano in due modi che non hanno niente in comune.
      sedeRimedio: manca?.rimedio ?? null,
      // Su Linux non c'e nessuna distro, e dirne una sarebbe una bugia
      // innocua che pero fa cercare un'impostazione che non serve a niente.
      distro: sede.genere === 'wsl' && manca === null ? server.distro : null,
      snapserver: trovato ? trovato.versione || 'versione sconosciuta' : null,
      snapserverVecchio: versioneTroppoVecchia(trovato?.versione),
      ffmpeg: ff ? `${ff.versione}${ff.inBundle ? '' : ' (dal PATH, non in bundle)'}` : null,
      porteOccupate: occupate,
      indirizzi: indirizziLocali(),
      controllatoIl: new Date().toISOString(),
    }
    return this.fotografia
  }
}

/** Vero se la porta e gia presa: si prova ad ascoltarci sopra e basta. */
function occupata(porta: number): Promise<boolean> {
  return new Promise((risolvi) => {
    const s = createServer()
    s.once('error', () => risolvi(true))
    s.once('listening', () => s.close(() => risolvi(false)))
    s.listen(porta, '0.0.0.0')
  })
}

/**
 * Gli indirizzi IPv4 delle interfacce vere.
 *
 * Il §8.1 vuole che il Setup avvisi se il PC e su Wi-Fi invece che via cavo: la
 * banda e il collo di bottiglia, non la CPU -- otto Altoparlanti in PCM stereo
 * sono 11,3 Mbit/s continui a casa vuota. Ne Windows ne Linux espongono il tipo
 * di collegamento in `os.networkInterfaces()`, quindi lo si indovina dal nome;
 * una supposizione sbagliata produce un avviso di troppo, non un guasto.
 *
 * I nomi cambiano da un sistema all'altro -- `Wi-Fi` su Windows, `wlan0` o
 * `wlp3s0` su Linux -- e le interfacce da mandare in fondo pure: WSL e Hyper-V
 * su Windows, i ponti di Docker e le `veth` dei contenitori su Linux.
 */
export function indirizziLocali(): AmbienteVivo['indirizzi'] {
  const fuori: { interfaccia: string; ip: string; senzaFili: boolean }[] = []
  for (const [nome, elenco] of Object.entries(os.networkInterfaces())) {
    for (const i of elenco ?? []) {
      if (i.family !== 'IPv4' || i.internal) continue
      // Le interfacce virtuali hanno un IP vero e non servono a nessun
      // telefono: si mostrano comunque, ma in fondo.
      fuori.push({
        interfaccia: nome,
        ip: i.address,
        senzaFili: senzaFili(nome),
      })
    }
  }
  return fuori.sort((a, b) => Number(virtuale(a.interfaccia)) - Number(virtuale(b.interfaccia)))
}

/** `Wi-Fi` su Windows; `wlan0`, `wlp2s0`, `wlx…` su Linux. */
function senzaFili(nome: string): boolean {
  return /wi-?fi|wireless|^wl/i.test(nome)
}

export function virtuale(nome: string): boolean {
  return /wsl|hyper-v|vethernet|virtual|loopback|^docker|^br-|^veth|^virbr|^tun|^tap/i.test(nome)
}
