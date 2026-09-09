/**
 * Il telaio dei fotogrammi video sul canale binario.
 *
 * Sta in un file suo, separato da `protocollo.ts`, per una ragione precisa:
 * questo modulo lo importa **anche l'interfaccia**, che gira in un browser.
 * `protocollo.ts` importa Zod e usa `Buffer`, e nessuno dei due ha senso li.
 * Qui dentro non c'e niente che non esista in tutti e due i mondi.
 *
 *   byte 0        1 = chunk video
 *   byte 1        1 = fotogramma chiave (IDR), 0 = differenziale
 *   byte 2-3      lunghezza dell'identificativo di Telecamera, big endian
 *   byte 4..      identificativo in UTF-8
 *   poi           H.264 Annex-B grezzo, cosi com'e arrivato dal telefono
 */

export const MARCA_VIDEO = 1

const codificatore = new TextEncoder()
const decodificatore = new TextDecoder()

export function impacchettaVideo(
  telecameraId: string,
  chiave: boolean,
  dati: Uint8Array,
): Uint8Array {
  const id = codificatore.encode(telecameraId)
  const fuori = new Uint8Array(4 + id.length + dati.length)
  fuori[0] = MARCA_VIDEO
  fuori[1] = chiave ? 1 : 0
  fuori[2] = (id.length >> 8) & 0xff
  fuori[3] = id.length & 0xff
  fuori.set(id, 4)
  fuori.set(dati, 4 + id.length)
  return fuori
}

export function spacchettaVideo(
  b: Uint8Array,
): { telecameraId: string; chiave: boolean; dati: Uint8Array } | null {
  if (b.length < 4 || b[0] !== MARCA_VIDEO) return null
  const lunghezza = (b[2]! << 8) | b[3]!
  if (b.length < 4 + lunghezza) return null
  return {
    telecameraId: decodificatore.decode(b.subarray(4, 4 + lunghezza)),
    chiave: b[1] === 1,
    dati: b.subarray(4 + lunghezza),
  }
}
