/**
 * Il muxer TS si collauda contro ffprobe: si danno in pasto fotogrammi H.264
 * veri, con un orologio finto a cadenza nota, e si verifica che ffmpeg legga la
 * traccia video con i PTS che ci aspettiamo -- vicini allo zero, monotoni,
 * spaziati come l'orologio. E' l'unico modo onesto di provare un muxer: che il
 * decodificatore vero lo capisca.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { SpezzatoreAnnexB } from '../telecamere/annexb.js'
import { MuxTs } from './ts.js'

const cartelle: string[] = []
let ffmpeg = ''
let ffprobe = ''

before(() => {
  if (spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0) ffmpeg = 'ffmpeg'
  if (spawnSync('ffprobe', ['-version'], { windowsHide: true }).status === 0) ffprobe = 'ffprobe'
})
after(async () => {
  for (const d of cartelle) await fs.rm(d, { recursive: true, force: true })
})

async function cartella(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'regia-ts-'))
  cartelle.push(d)
  return d
}

/**
 * Un H.264 grezzo vero: 60 fotogrammi a 30 fps, senza B-frame e **una sola
 * slice per fotogramma** -- come il telefono (annexb.ts). Con le slice multiple
 * di `ultrafast` lo spezzatore emetterebbe piu' unita per fotogramma, che non e'
 * il caso reale.
 */
function generaH264(dest: string): void {
  const e = spawnSync(
    ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
     '-i', 'testsrc2=rate=30:size=320x240:duration=2',
     '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '0', '-g', '15',
     '-x264-params', 'slices=1:sliced-threads=0',
     '-f', 'h264', '-y', dest],
    { windowsHide: true },
  )
  assert.equal(e.status, 0, `ffmpeg non ha generato l H.264: ${e.stderr}`)
}

describe('muxer MPEG-TS: da byte H.264 a TS con PTS nostri', { skip: undefined }, () => {
  it('ffmpeg legge la traccia video con i PTS dell orologio, dallo zero', async (t) => {
    if (!ffmpeg || !ffprobe) return t.skip('ffmpeg/ffprobe non disponibili')
    const dir = await cartella()
    const h264 = path.join(dir, 'ref.h264')
    generaH264(h264)
    const byte = new Uint8Array(await fs.readFile(h264))

    // Orologio finto: 33,333 ms per fotogramma, cioe 30 fps esatti. Parte da un
    // valore non nullo per verificare che il muxer riporti comunque a zero.
    let orologio = 5000
    const pezzi: Uint8Array[] = []
    const mux = new MuxTs({ scrivi: (ts) => pezzi.push(ts), adesso: () => (orologio += 1000 / 30) })
    // parte da 5000: la prima chiamata restituisce 5033,33; per avere il primo a
    // ~0 basta che t0 sia la prima lettura. Va bene: i PTS sono relativi a t0.

    // Si spinge a blocchi, come arriverebbe dalla rete.
    for (let i = 0; i < byte.length; i += 1500) mux.spingi(byte.subarray(i, i + 1500))
    mux.chiudi()

    const ts = Buffer.concat(pezzi.map((p) => Buffer.from(p)))
    assert.equal(ts.length % 188, 0, 'ogni pacchetto TS e 188 byte')
    const tsFile = path.join(dir, 'out.ts')
    await fs.writeFile(tsFile, ts)

    // ffprobe deve vedere una traccia H.264 e leggerne i PTS.
    const streams = execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', tsFile]).toString().trim()
    assert.match(streams, /h264/, 'la traccia deve essere H.264')

    const csv = execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', tsFile]).toString()
    const pts = csv.split(/\r?\n/).map((l) => parseFloat(l)).filter((x) => !Number.isNaN(x))

    assert.ok(pts.length >= 58, `attesi ~60 fotogrammi, letti ${pts.length}`)
    assert.ok(pts[0]! < 0.05, `il primo PTS deve essere ~0, era ${pts[0]}`)
    for (let i = 1; i < pts.length; i++) {
      assert.ok(pts[i]! > pts[i - 1]!, `PTS non monotono a ${i}: ${pts[i - 1]} -> ${pts[i]}`)
    }
    // Spaziatura mediana ~33 ms (30 fps), quella dell orologio.
    const d = pts.slice(1).map((x, i) => x - pts[i]!).sort((a, b) => a - b)
    const mediana = d[Math.floor(d.length / 2)]!
    assert.ok(Math.abs(mediana - 1 / 30) < 0.004, `spaziatura mediana ${(mediana * 1000).toFixed(1)} ms, attesa 33,3`)
  })

  it('preso a meta GOP, non esce niente prima del primo fotogramma chiave', async (t) => {
    if (!ffmpeg || !ffprobe) return t.skip('ffmpeg/ffprobe non disponibili')
    const dir = await cartella()
    const h264 = path.join(dir, 'ref.h264')
    generaH264(h264)
    const byte = new Uint8Array(await fs.readFile(h264))

    // Si taglia via ESATTAMENTE la prima unita (SPS+PPS+IDR): il confine lo
    // trova lo stesso spezzatore che usa il muxer. Il flusso che si da in pasto
    // comincia cosi con i P-frame del primo GOP -- come una registrazione
    // avviata a meta -- e il primo chiave e il fotogramma 15 (`-g 15`).
    let taglio = 0
    const sonda = new SpezzatoreAnnexB((u) => {
      if (taglio === 0) taglio = u.length
    })
    sonda.spingi(byte)
    assert.ok(taglio > 0, 'lo spezzatore deve trovare la prima unita')
    const daMeta = byte.subarray(taglio)

    let orologio = 0
    const pezzi: Uint8Array[] = []
    const mux = new MuxTs({ scrivi: (ts) => pezzi.push(ts), adesso: () => (orologio += 1000 / 30) })
    for (let i = 0; i < daMeta.length; i += 1500) mux.spingi(daMeta.subarray(i, i + 1500))
    mux.chiudi()

    const tsFile = path.join(dir, 'out.ts')
    await fs.writeFile(tsFile, Buffer.concat(pezzi.map((p) => Buffer.from(p))))

    const csv = execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', tsFile]).toString()
    const righe = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)

    // I 14 P-frame orfani sono stati trattenuti: restano i fotogrammi dal 15 in
    // poi (l'ultimo lo butta `chiudi`, che non puo sapere se e completo).
    assert.ok(righe.length >= 43 && righe.length <= 46,
      `attesi ~44 fotogrammi dal primo chiave in poi, letti ${righe.length}`)
    const [primoPts, primeFlag] = righe[0]!.split(',')
    assert.ok(parseFloat(primoPts!) < 0.05, `il primo PTS deve essere ~0, era ${primoPts}`)
    assert.match(primeFlag!, /K/, 'il primo fotogramma emesso deve essere quello chiave')
  })

  it('il video sopravvive a -c copy: framing e byte sono intatti', async (t) => {
    if (!ffmpeg || !ffprobe) return t.skip('ffmpeg/ffprobe non disponibili')
    const dir = await cartella()
    const h264 = path.join(dir, 'ref.h264')
    generaH264(h264)
    const byte = new Uint8Array(await fs.readFile(h264))

    let orologio = 0
    const pezzi: Uint8Array[] = []
    const mux = new MuxTs({ scrivi: (ts) => pezzi.push(ts), adesso: () => (orologio += 1000 / 30) })
    for (let i = 0; i < byte.length; i += 4096) mux.spingi(byte.subarray(i, i + 4096))
    mux.chiudi()
    const tsFile = path.join(dir, 'out.ts')
    await fs.writeFile(tsFile, Buffer.concat(pezzi.map((p) => Buffer.from(p))))

    // Copia in mp4 senza ricodifica: se il framing del muxer fosse rotto, qui
    // ffmpeg si lamenterebbe o perderebbe fotogrammi.
    const mp4 = path.join(dir, 'out.mp4')
    const e = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', tsFile,
      '-c:v', 'copy', '-fps_mode', 'passthrough', '-y', mp4], { windowsHide: true })
    assert.equal(e.status, 0, `-c copy fallito: ${e.stderr}`)

    const n = execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-count_packets',
      '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', mp4]).toString().trim()
    assert.ok(Number(n) >= 58, `l mp4 copiato deve avere ~60 fotogrammi, ne ha ${n}`)
  })
})
