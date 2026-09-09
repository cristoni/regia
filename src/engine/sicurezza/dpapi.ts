/**
 * Cifratura delle password delle Telecamere con DPAPI (§6).
 *
 * Il §6 chiede esplicitamente "le password delle telecamere vanno comunque
 * salvate cifrate con le API di Windows (DPAPI)". DPAPI non ha un legame
 * diretto in Node senza un modulo nativo, e aggiungere un modulo nativo a
 * Regia significa compilarlo per la versione di Node di ogni Electron: si passa
 * invece da PowerShell, che espone `System.Security.Cryptography.ProtectedData`
 * della libreria standard di .NET, gia presente su qualunque Windows 11.
 *
 * Costa circa mezzo secondo a chiamata. Va benissimo: si cifra quando
 * l'Operatore scrive una password in Setup, e si decifra quando si contatta
 * una Telecamera protetta. Nessuna delle due cose succede in un ciclo.
 *
 * **Se DPAPI non e disponibile, la password non si salva.** Non si ripiega su
 * base64 o su una cifratura fatta in casa: un file di progetto che sembra
 * contenere una password cifrata e non la contiene e peggio di uno che dice di
 * non averla.
 */
import { spawnSync } from 'node:child_process'

export class DpapiNonDisponibile extends Error {
  constructor(dettaglio: string) {
    super(
      `DPAPI non disponibile (${dettaglio}): la password non e stata salvata. ` +
        'La Telecamera funzionera finche Regia resta aperta.',
    )
    this.name = 'DpapiNonDisponibile'
  }
}

/** `CurrentUser`: solo chi ha fatto il Setup puo rileggerla, e solo su quel PC. */
const AMBITO = 'CurrentUser'
/** Entropia aggiuntiva: lega il segreto a Regia, non solo all'utente. */
const SALE = 'Regia:telecamera'

function powershell(script: string, ingresso: string): string {
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { input: ingresso, encoding: 'utf8', windowsHide: true, timeout: 20_000 },
  )
  if (r.error) throw new DpapiNonDisponibile(r.error.message)
  if (r.status !== 0) throw new DpapiNonDisponibile((r.stderr || '').trim().slice(0, 200))
  return (r.stdout ?? '').trim()
}

const PRELUDIO =
  'Add-Type -AssemblyName System.Security; ' +
  `$sale = [Text.Encoding]::UTF8.GetBytes('${SALE}'); ` +
  '$in = [Console]::In.ReadToEnd().Trim(); '

export function cifra(password: string): string {
  if (password === '') return ''
  const fuori = powershell(
    PRELUDIO +
      '$chiaro = [Text.Encoding]::UTF8.GetBytes($in); ' +
      `$c = [Security.Cryptography.ProtectedData]::Protect($chiaro, $sale, '${AMBITO}'); ` +
      '[Convert]::ToBase64String($c)',
    password,
  )
  if (!fuori) throw new DpapiNonDisponibile('nessuna uscita da PowerShell')
  return fuori
}

export function decifra(cifrata: string): string {
  if (cifrata === '') return ''
  return powershell(
    PRELUDIO +
      '$c = [Convert]::FromBase64String($in); ' +
      `$chiaro = [Security.Cryptography.ProtectedData]::Unprotect($c, $sale, '${AMBITO}'); ` +
      '[Text.Encoding]::UTF8.GetString($chiaro)',
    cifrata,
  )
}

/** Vero se su questa macchina DPAPI risponde davvero. Si prova una volta sola. */
let disponibile: boolean | undefined
export function dpapiDisponibile(): boolean {
  if (disponibile !== undefined) return disponibile
  try {
    disponibile = decifra(cifra('prova')) === 'prova'
  } catch {
    disponibile = false
  }
  return disponibile
}
