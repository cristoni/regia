/**
 * La fotografia della macchina, per il Setup guidato (§3.8, passo 1).
 *
 * Si rifa su richiesta e all'avvio, mai in continuo: `wsl.exe -l -q` costa
 * qualche centinaio di millisecondi, e mostrarne il risultato dieci volte al
 * secondo non lo renderebbe piu vero. Per questo `AmbienteVivo` porta con se
 * `controllatoIl`: una fotografia vecchia di mezz'ora presentata come attuale
 * e peggio di nessuna fotografia.
 *
 * Il controllo delle porte e volutamente grezzo -- si prova ad ascoltare, e si
 * guarda se `EADDRINUSE` -- perche e l'unica prova che conta: se Regia riesce
 * ad aprire quella porta, il server ci riuscira. Un'analisi di `netstat` direbbe
 * cose vere e inutili.
 */
import { createServer } from 'node:net'
import * as os from 'node:os'

import type { AmbienteVivo } from './api/protocollo.js'
import { BINARIO_SNAPSERVER, distroInstallate, eseguiNellaDistroAsync } from './snapcast/distro.js'
import { trovaFfmpeg } from './media/ffmpeg.js'

const VUOTO: AmbienteVivo = {
  wsl: 'sconosciuto',
  distro: null,
  snapserver: null,
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
  controlla(distro: string, porte: readonly number[]): Promise<AmbienteVivo> {
    this.inCorso ??= this.davvero(distro, porte).finally(() => {
      this.inCorso = null
    })
    return this.inCorso
  }

  private async davvero(distro: string, porte: readonly number[]): Promise<AmbienteVivo> {
    const distroDisponibili = distroInstallate()
    let wsl: AmbienteVivo['wsl']
    let snapserver: string | null = null

    if (distroDisponibili === null) {
      wsl = 'assente'
    } else if (!distroDisponibili.includes(distro)) {
      wsl = 'senza distro'
    } else {
      wsl = 'ok'
      const r = await eseguiNellaDistroAsync(distro, `${BINARIO_SNAPSERVER} -v 2>&1 || true`, {
        timeoutMs: 20_000,
      })
      const v = /v?(\d+\.\d+\.\d+)/.exec(r.uscita)
      snapserver = v ? v[1]! : null
    }

    const ff = trovaFfmpeg(true)
    const occupate: number[] = []
    for (const p of porte) if (await occupata(p)) occupate.push(p)

    this.fotografia = {
      wsl,
      distro: distroDisponibili === null ? null : distro,
      snapserver,
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
 * sono 11,3 Mbit/s continui a casa vuota. Windows non espone il tipo di
 * collegamento in `os.networkInterfaces()`, quindi lo si indovina dal nome; una
 * supposizione sbagliata produce un avviso di troppo, non un guasto.
 */
export function indirizziLocali(): AmbienteVivo['indirizzi'] {
  const fuori: { interfaccia: string; ip: string; senzaFili: boolean }[] = []
  for (const [nome, elenco] of Object.entries(os.networkInterfaces())) {
    for (const i of elenco ?? []) {
      if (i.family !== 'IPv4' || i.internal) continue
      // Le interfacce di WSL e di Hyper-V hanno un IP vero e non servono a
      // nessun telefono: si mostrano comunque, ma in fondo.
      fuori.push({
        interfaccia: nome,
        ip: i.address,
        senzaFili: /wi-?fi|wireless|wlan/i.test(nome),
      })
    }
  }
  return fuori.sort((a, b) => Number(virtuale(a.interfaccia)) - Number(virtuale(b.interfaccia)))
}

function virtuale(nome: string): boolean {
  return /wsl|hyper-v|vethernet|virtual|loopback/i.test(nome)
}
