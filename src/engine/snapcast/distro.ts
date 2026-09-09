/**
 * Il poco che serve per parlare con la distro WSL.
 *
 * Snapserver non gira nativo su Windows (ADR 0002): il `CMakeLists.txt` definisce
 * `BUILD_SERVER` solo `if(NOT WIN32)`. Quindi ogni comando verso il server audio
 * passa da qui.
 *
 * Due cose che sembrano dettagli e non lo sono:
 *
 *  - **`setsid` e obbligatorio.** Snapserver muore con `Received signal 1: Hangup`
 *    appena esce il `wsl.exe` che l'ha lanciato: WSL termina il gruppo di processi
 *    della sessione, e `nohup` da solo non basta.
 *  - **`wsl.exe` risponde in UTF-16LE** quando fa da se (elenco distro, errori),
 *    e in UTF-8 quando l'output viene da un comando dentro la distro. Si legge
 *    grezzo e si decide.
 */
import { spawn, spawnSync } from 'node:child_process'

/** Dove Regia si aspetta di trovare snapserver dentro la distro. */
export const PREFISSO_SNAPSERVER = '/opt/snapserver-0.35'
export const BINARIO_SNAPSERVER = `${PREFISSO_SNAPSERVER}/usr/bin/snapserver`
/** Cartella di lavoro di Regia dentro la distro: conf, log, pid. */
export const CARTELLA_DISTRO = '/tmp/regia'

export interface EsitoDistro {
  readonly stato: number
  readonly uscita: string
  readonly errore: string
}

/**
 * `wsl.exe -l -q` e gli errori di `wsl.exe` stesso arrivano in UTF-16LE, senza
 * BOM affidabile. L'euristica che regge: se un byte su due e zero, e UTF-16.
 */
function decodifica(b: Buffer): string {
  if (b.length >= 4 && b[1] === 0 && b[3] === 0) return b.toString('utf16le').replace(/\0/g, '')
  return b.toString('utf8').replace(/\0/g, '')
}

export function eseguiNellaDistro(
  distro: string,
  comando: string,
  opzioni: { readonly timeoutMs?: number; readonly ingresso?: string } = {},
): EsitoDistro {
  const r = spawnSync('wsl', ['-d', distro, '-u', 'root', '-e', 'bash', '-lc', comando], {
    windowsHide: true,
    maxBuffer: 1 << 24,
    timeout: opzioni.timeoutMs ?? 15_000,
    ...(opzioni.ingresso === undefined ? {} : { input: opzioni.ingresso }),
  })
  return {
    stato: r.status ?? -1,
    uscita: decodifica(r.stdout ?? Buffer.alloc(0)).trim(),
    errore: decodifica(r.stderr ?? Buffer.alloc(0)).trim(),
  }
}

/**
 * Lo stesso, senza bloccare il thread principale.
 *
 * Serve per tutto cio che si fa durante l'Evento: un `spawnSync` da mezzo
 * secondo qui e mezzo secondo di interfaccia ferma, e il thread audio e in un
 * altro thread ma i comandi passano comunque da questo.
 */
export function eseguiNellaDistroAsync(
  distro: string,
  comando: string,
  opzioni: { readonly timeoutMs?: number; readonly ingresso?: string } = {},
): Promise<EsitoDistro> {
  return new Promise((risolvi) => {
    const p = spawn('wsl', ['-d', distro, '-u', 'root', '-e', 'bash', '-lc', comando], {
      windowsHide: true,
    })
    const fuori: Buffer[] = []
    const err: Buffer[] = []
    let finito = false

    const scadenza = setTimeout(() => {
      if (finito) return
      p.kill()
    }, opzioni.timeoutMs ?? 15_000)
    scadenza.unref?.()

    p.stdout.on('data', (d: Buffer) => fuori.push(d))
    p.stderr.on('data', (d: Buffer) => err.push(d))
    p.on('error', (e) => {
      if (finito) return
      finito = true
      clearTimeout(scadenza)
      risolvi({ stato: -1, uscita: '', errore: e.message })
    })
    p.on('close', (stato) => {
      if (finito) return
      finito = true
      clearTimeout(scadenza)
      risolvi({
        stato: stato ?? -1,
        uscita: decodifica(Buffer.concat(fuori)).trim(),
        errore: decodifica(Buffer.concat(err)).trim(),
      })
    })

    if (opzioni.ingresso !== undefined) p.stdin.end(opzioni.ingresso)
    else p.stdin.end()
  })
}

/** Le distro installate, o `null` se `wsl.exe` non c'e proprio. */
export function distroInstallate(): string[] | null {
  const r = spawnSync('wsl', ['-l', '-q'], { windowsHide: true, timeout: 15_000 })
  if (r.error || r.status !== 0) return null
  return decodifica(r.stdout ?? Buffer.alloc(0))
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * L'indirizzo IP della distro, visto da Windows.
 *
 * E l'indirizzo a cui bisogna parlare, e **non** `127.0.0.1`. In
 * `networkingMode=NAT` WSL mette in piedi un inoltro da `127.0.0.1:<porta>`
 * verso la distro per ogni porta in ascolto -- comodo, e pieno di fantasmi:
 * l'inoltro **sopravvive alla morte del processo** che ascoltava, quindi una
 * `connect()` su `127.0.0.1` riesce, i byte partono, e non li legge nessuno.
 * E indistinguibile da un server che accetta e non consuma. Parlando
 * direttamente alla distro quel tramite non esiste.
 */
export async function indirizzoDistro(distro: string): Promise<string | null> {
  const r = await eseguiNellaDistroAsync(distro, "hostname -I | awk '{print $1}'", {
    timeoutMs: 10_000,
  })
  const ip = r.uscita.trim()
  return r.stato === 0 && /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null
}

/**
 * Scrive un file dentro la distro senza passare da un heredoc.
 *
 * Il contenuto arriva sullo standard input di `cat`: qualunque cosa ci sia
 * dentro -- apici, backtick, `$(`, accenti -- non viene interpretata da bash.
 */
export function scriviNellaDistro(distro: string, percorso: string, contenuto: string): EsitoDistro {
  const cartella = percorso.slice(0, percorso.lastIndexOf('/')) || '/'
  return eseguiNellaDistro(distro, `mkdir -p '${cartella}' && cat > '${percorso}'`, {
    ingresso: contenuto,
  })
}
