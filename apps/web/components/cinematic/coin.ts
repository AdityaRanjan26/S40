import * as THREE from "three"

/**
 * A procedural Indian ₹1 coin.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY PROCEDURAL, AND WHY A HEIGHT MAP
 *
 * A coin is not a printed disc — it is a *struck* disc. Everything you read on
 * a real coin you read because light rakes across relief: raised metal catches
 * the key light, recessed field stays dark. So the designs below are drawn in
 * GREYSCALE as height fields (mid-grey = the flat field, lighter = raised
 * relief) and fed to `bumpMap`, not to `map`. The coin's colour comes from one
 * uniform nickel-steel base; the imagery comes entirely from light.
 *
 * Painting the emblem as a colour texture would have produced a sticker on a
 * cylinder, which is exactly the "generic gold token" failure mode this has to
 * avoid.
 *
 * WHAT IS DEPICTED
 * The current (2011– ) Indian one-rupee circulation coin:
 *   obverse — Lion Capital of Ashoka, सत्यमेव जयते beneath, भारत / INDIA flanking
 *   reverse — the ₹ symbol, the numeral 1, and the mint year
 * It is a stylised rendering, not a scan: enough to read unmistakably as an
 * Indian one-rupee coin, drawn from primitives rather than traced from a
 * photograph of legal tender.
 *
 * Physical proportions follow the real coin: 21.93mm diameter, 1.45mm thick —
 * a ratio of about 15:1, which is what makes it read as a coin rather than a
 * medallion or a crypto token.
 * ─────────────────────────────────────────────────────────────────────────
 */

const TEXTURE_SIZE = 1024
/** Real ₹1: 21.93mm across, 1.45mm thick. Kept as a ratio, not a scale. */
export const COIN_RADIUS = 1.0
export const COIN_THICKNESS = (1.45 / 21.93) * 2 * COIN_RADIUS

/** Height-field convention. Mid-grey is the untouched field of the coin. */
const FIELD = "#808080"
const RAISED = "#f2f2f2"
const RAISED_SOFT = "#c8c8c8"
const RECESSED = "#4a4a4a"

function newCanvas() {
  const c = document.createElement("canvas")
  c.width = TEXTURE_SIZE
  c.height = TEXTURE_SIZE
  return c
}

/** Sprinkle micro-imperfections: a circulated coin is never optically clean. */
function addWear(ctx: CanvasRenderingContext2D) {
  const n = TEXTURE_SIZE

  // Fine radial die-polish lines.
  ctx.save()
  ctx.globalAlpha = 0.05
  ctx.strokeStyle = "#ffffff"
  ctx.lineWidth = 1
  for (let i = 0; i < 220; i++) {
    const a = Math.random() * Math.PI * 2
    const r0 = n * (0.1 + Math.random() * 0.2)
    const r1 = r0 + n * (0.04 + Math.random() * 0.14)
    ctx.beginPath()
    ctx.moveTo(n / 2 + Math.cos(a) * r0, n / 2 + Math.sin(a) * r0)
    ctx.lineTo(n / 2 + Math.cos(a) * r1, n / 2 + Math.sin(a) * r1)
    ctx.stroke()
  }
  ctx.restore()

  // Scattered nicks and contact marks.
  ctx.save()
  ctx.globalAlpha = 0.07
  for (let i = 0; i < 90; i++) {
    const a = Math.random() * Math.PI * 2
    const r = Math.random() * n * 0.44
    const x = n / 2 + Math.cos(a) * r
    const y = n / 2 + Math.sin(a) * r
    ctx.fillStyle = Math.random() > 0.5 ? "#ffffff" : "#000000"
    ctx.beginPath()
    ctx.ellipse(
      x,
      y,
      1 + Math.random() * 3,
      1 + Math.random() * 1.5,
      Math.random() * Math.PI,
      0,
      Math.PI * 2
    )
    ctx.fill()
  }
  ctx.restore()
}

/** The raised rim every struck coin carries, plus a denticled inner ring. */
function drawRim(ctx: CanvasRenderingContext2D) {
  const n = TEXTURE_SIZE
  const c = n / 2

  ctx.fillStyle = FIELD
  ctx.fillRect(0, 0, n, n)

  // Outside the coin's circle is pure black so the bump never bleeds past it.
  ctx.save()
  ctx.beginPath()
  ctx.arc(c, c, n * 0.5, 0, Math.PI * 2)
  ctx.closePath()
  ctx.rect(n, 0, -n, n)
  ctx.fillStyle = "#000000"
  ctx.fill("evenodd")
  ctx.restore()

  // Raised outer rim.
  ctx.strokeStyle = RAISED
  ctx.lineWidth = n * 0.035
  ctx.beginPath()
  ctx.arc(c, c, n * 0.472, 0, Math.PI * 2)
  ctx.stroke()

  // Shallow trough just inside the rim.
  ctx.strokeStyle = RECESSED
  ctx.lineWidth = n * 0.012
  ctx.beginPath()
  ctx.arc(c, c, n * 0.446, 0, Math.PI * 2)
  ctx.stroke()
}

/**
 * The Lion Capital of Ashoka — the State Emblem, as struck on the coin's
 * obverse.
 *
 * Three of the four lions are visible: one facing the viewer, two in profile
 * either side. They stand on a circular abacus carrying the Dharma Chakra,
 * which sits on an inverted bell-shaped lotus.
 *
 * The earlier pass drew the lions as soft blobs — a rounded body with a
 * circle for a head — which read as a bear or a sheep, not a lion. What makes
 * a lion legible at this size is the MANE: a wide, deeply-notched collar much
 * broader than the skull, with the muzzle set low inside it. That, the square
 * shoulders and the straight forelegs are what the shape needs, far more than
 * fine detail that vanishes at coin scale.
 */
function drawLionCapital(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  s: number
) {
  ctx.save()
  ctx.translate(cx, cy)
  ctx.lineJoin = "round"
  ctx.lineCap = "round"
  ctx.fillStyle = RAISED
  ctx.strokeStyle = RAISED

  /* ── the bell/lotus base ─────────────────────────────────────────────── */
  ctx.fillStyle = RAISED_SOFT
  ctx.beginPath()
  ctx.moveTo(-s * 0.46, s * 0.52)
  ctx.bezierCurveTo(-s * 0.34, s * 0.74, -s * 0.26, s * 0.86, -s * 0.22, s * 0.94)
  ctx.lineTo(s * 0.22, s * 0.94)
  ctx.bezierCurveTo(s * 0.26, s * 0.86, s * 0.34, s * 0.74, s * 0.46, s * 0.52)
  ctx.closePath()
  ctx.fill()
  // Lotus petal flutes.
  ctx.strokeStyle = RECESSED
  ctx.lineWidth = s * 0.016
  for (let i = -3; i <= 3; i++) {
    ctx.beginPath()
    ctx.moveTo(i * s * 0.115, s * 0.56)
    ctx.lineTo(i * s * 0.062, s * 0.92)
    ctx.stroke()
  }

  /* ── the abacus ──────────────────────────────────────────────────────── */
  ctx.fillStyle = RAISED
  ctx.beginPath()
  ctx.moveTo(-s * 0.58, s * 0.26)
  ctx.lineTo(s * 0.58, s * 0.26)
  ctx.lineTo(s * 0.50, s * 0.52)
  ctx.lineTo(-s * 0.50, s * 0.52)
  ctx.closePath()
  ctx.fill()

  /* ── Dharma Chakra, centred on the abacus ────────────────────────────── */
  ctx.save()
  ctx.translate(0, s * 0.39)
  ctx.strokeStyle = RECESSED
  ctx.lineWidth = s * 0.020
  ctx.beginPath()
  ctx.arc(0, 0, s * 0.105, 0, Math.PI * 2)
  ctx.stroke()
  ctx.lineWidth = s * 0.011
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2
    ctx.beginPath()
    ctx.moveTo(Math.cos(a) * s * 0.026, Math.sin(a) * s * 0.026)
    ctx.lineTo(Math.cos(a) * s * 0.096, Math.sin(a) * s * 0.096)
    ctx.stroke()
  }
  ctx.fillStyle = RECESSED
  ctx.beginPath()
  ctx.arc(0, 0, s * 0.024, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  /* ── the two profile lions ───────────────────────────────────────────── */
  const profileLion = (dir: number) => {
    ctx.save()
    ctx.scale(dir, 1)
    ctx.fillStyle = RAISED

    // Body: square shoulder, level back, haunch down to the abacus.
    ctx.beginPath()
    ctx.moveTo(s * 0.15, s * 0.26)
    ctx.lineTo(s * 0.15, -s * 0.10)
    ctx.quadraticCurveTo(s * 0.20, -s * 0.30, s * 0.36, -s * 0.34)
    ctx.quadraticCurveTo(s * 0.54, -s * 0.36, s * 0.58, -s * 0.16)
    ctx.quadraticCurveTo(s * 0.61, s * 0.06, s * 0.55, s * 0.26)
    ctx.closePath()
    ctx.fill()

    // Foreleg, straight and vertical, as on the capital.
    ctx.lineWidth = s * 0.072
    ctx.beginPath()
    ctx.moveTo(s * 0.50, -s * 0.06)
    ctx.lineTo(s * 0.52, s * 0.24)
    ctx.stroke()

    // Mane: a broad notched collar, wider than the skull.
    ctx.beginPath()
    ctx.ellipse(s * 0.44, -s * 0.30, s * 0.19, s * 0.17, 0.12, 0, Math.PI * 2)
    ctx.fill()
    ctx.lineWidth = s * 0.026
    for (let i = 0; i < 9; i++) {
      const a = -Math.PI * 0.15 + (i / 8) * Math.PI * 1.25
      ctx.beginPath()
      ctx.moveTo(s * 0.44 + Math.cos(a) * s * 0.15, -s * 0.30 + Math.sin(a) * s * 0.14)
      ctx.lineTo(s * 0.44 + Math.cos(a) * s * 0.235, -s * 0.30 + Math.sin(a) * s * 0.215)
      ctx.stroke()
    }

    // Muzzle, set low and forward inside the mane.
    ctx.beginPath()
    ctx.moveTo(s * 0.52, -s * 0.36)
    ctx.quadraticCurveTo(s * 0.68, -s * 0.34, s * 0.66, -s * 0.21)
    ctx.quadraticCurveTo(s * 0.58, -s * 0.17, s * 0.51, -s * 0.22)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = RECESSED
    ctx.beginPath()
    ctx.ellipse(s * 0.61, -s * 0.30, s * 0.019, s * 0.014, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
  profileLion(1)
  profileLion(-1)

  /* ── the facing lion ─────────────────────────────────────────────────── */
  ctx.fillStyle = RAISED
  // Chest and shoulders.
  ctx.beginPath()
  ctx.moveTo(-s * 0.21, s * 0.26)
  ctx.quadraticCurveTo(-s * 0.25, -s * 0.02, -s * 0.17, -s * 0.16)
  ctx.lineTo(s * 0.17, -s * 0.16)
  ctx.quadraticCurveTo(s * 0.25, -s * 0.02, s * 0.21, s * 0.26)
  ctx.closePath()
  ctx.fill()
  // Forelegs.
  ctx.lineWidth = s * 0.062
  ctx.beginPath()
  ctx.moveTo(-s * 0.11, s * 0.02)
  ctx.lineTo(-s * 0.13, s * 0.24)
  ctx.moveTo(s * 0.11, s * 0.02)
  ctx.lineTo(s * 0.13, s * 0.24)
  ctx.stroke()

  // Mane: the widest element of the whole emblem.
  ctx.beginPath()
  ctx.ellipse(0, -s * 0.30, s * 0.235, s * 0.205, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.lineWidth = s * 0.030
  for (let i = 0; i < 20; i++) {
    const a = (i / 19) * Math.PI * 2
    const r0x = s * 0.20, r0y = s * 0.175
    const r1x = s * 0.295, r1y = s * 0.265
    ctx.beginPath()
    ctx.moveTo(Math.cos(a) * r0x, -s * 0.30 + Math.sin(a) * r0y)
    ctx.lineTo(Math.cos(a) * r1x, -s * 0.30 + Math.sin(a) * r1y)
    ctx.stroke()
  }

  // Face: muzzle box, eyes, nose.
  ctx.beginPath()
  ctx.ellipse(0, -s * 0.26, s * 0.115, s * 0.098, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = RECESSED
  ctx.beginPath()
  ctx.ellipse(-s * 0.062, -s * 0.345, s * 0.022, s * 0.016, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.beginPath()
  ctx.ellipse(s * 0.062, -s * 0.345, s * 0.022, s * 0.016, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.beginPath()
  ctx.moveTo(-s * 0.030, -s * 0.275)
  ctx.lineTo(s * 0.030, -s * 0.275)
  ctx.lineTo(0, -s * 0.232)
  ctx.closePath()
  ctx.fill()
  // Mouth.
  ctx.strokeStyle = RECESSED
  ctx.lineWidth = s * 0.014
  ctx.beginPath()
  ctx.moveTo(0, -s * 0.232)
  ctx.lineTo(0, -s * 0.205)
  ctx.moveTo(-s * 0.048, -s * 0.196)
  ctx.quadraticCurveTo(0, -s * 0.172, s * 0.048, -s * 0.196)
  ctx.stroke()

  ctx.restore()
}

function drawEmblem(ctx: CanvasRenderingContext2D) {
  const n = TEXTURE_SIZE
  const c = n / 2
  drawRim(ctx)

  drawLionCapital(ctx, c, c - n * 0.055, n * 0.30)

  ctx.save()
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.fillStyle = RAISED

  // सत्यमेव जयते, beneath the capital, as on the emblem.
  ctx.font = `600 ${Math.round(n * 0.062)}px "Noto Sans Devanagari", serif`
  ctx.fillText("सत्यमेव जयते", c, c + n * 0.205)

  // भारत left, INDIA right, curving with the rim.
  ctx.font = `600 ${Math.round(n * 0.058)}px "Noto Sans Devanagari", serif`
  ctx.fillText("भारत", c - n * 0.245, c + n * 0.325)
  ctx.font = `600 ${Math.round(n * 0.052)}px Outfit, sans-serif`
  ctx.letterSpacing = `${n * 0.006}px`
  ctx.fillText("INDIA", c + n * 0.245, c + n * 0.325)
  ctx.letterSpacing = "0px"
  ctx.restore()

  addWear(ctx)
}

/**
 * Text set along an arc, letters upright and radiating from the centre.
 *
 * The legend on the real coin curves with the rim; setting it on a straight
 * baseline is the single clearest tell that a coin face was drawn rather than
 * struck. Each glyph is measured, the run is centred on `centerAngle`, and
 * every letter is rotated to stand normal to the circle.
 */
function arcText(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  radius: number,
  centerAngle: number,
  spacing = 1
) {
  // Devanagari must be segmented by GRAPHEME, not by code point. `[...text]`
  // splits र + ु + प + य + ा into five independent glyphs, so the vowel signs
  // detach from their consonants and रुपया renders as broken shapes. Grapheme
  // clusters keep each syllable intact and correctly shaped.
  const chars =
    typeof Intl !== "undefined" && "Segmenter" in Intl
      ? [...new Intl.Segmenter("hi", { granularity: "grapheme" }).segment(text)]
          .map((g) => g.segment)
      : [...text]
  const widths = chars.map((ch) => ctx.measureText(ch).width * spacing)
  const total = widths.reduce((t, w) => t + w, 0)
  // Arc length -> angle.
  let angle = centerAngle - total / radius / 2

  ctx.save()
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  chars.forEach((ch, i) => {
    const step = widths[i] / radius
    const a = angle + step / 2
    ctx.save()
    ctx.translate(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius)
    ctx.rotate(a + Math.PI / 2)
    ctx.fillText(ch, 0, 0)
    ctx.restore()
    angle += step
  })
  ctx.restore()
}

/**
 * The numeral, drawn as a path rather than set in a typeface.
 *
 * The struck 1 on this coin has a long angled flag off the top-left, a stem of
 * near-constant width, and a wide flat foot — a shape no UI sans has. Setting
 * it in Outfit gave a thin geometric 1 that read as a label, not as minted
 * relief.
 */
function drawNumeralOne(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  h: number
) {
  const w = h * 0.075 // stem half-width
  ctx.save()
  ctx.translate(cx, cy)
  ctx.fillStyle = RAISED
  ctx.beginPath()
  // foot, left edge
  ctx.moveTo(-h * 0.30, h * 0.5)
  ctx.lineTo(-h * 0.30, h * 0.5 - h * 0.055)
  ctx.lineTo(-w, h * 0.5 - h * 0.055)
  // up the left of the stem
  ctx.lineTo(-w, -h * 0.30)
  // the flag, angled down-left
  ctx.lineTo(-h * 0.235, -h * 0.175)
  ctx.lineTo(-h * 0.285, -h * 0.275)
  ctx.lineTo(-w * 0.2, -h * 0.5)
  ctx.lineTo(w, -h * 0.5)
  // down the right of the stem to the foot
  ctx.lineTo(w, h * 0.5 - h * 0.055)
  ctx.lineTo(h * 0.30, h * 0.5 - h * 0.055)
  ctx.lineTo(h * 0.30, h * 0.5)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

/**
 * One side of the wheat motif: two long curved blades on the outside, and a
 * grain ear of overlapping teardrop kernels between them.
 *
 * The grains are TEARDROPS, not chevrons. Two earlier passes drew them as
 * V-strokes stepping up a stem, which renders as a fir tree — and once you
 * see the fir you cannot unsee it. On the coin each kernel is a plump, blunt
 * lozenge lying at a shallow angle, overlapping its neighbour, with the ear
 * fattest at the middle and tapering to a point.
 */
function drawWheat(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  s: number,
  dir: number
) {
  ctx.save()
  ctx.translate(cx, cy)
  ctx.scale(dir, 1)
  ctx.fillStyle = RAISED
  ctx.strokeStyle = RAISED
  ctx.lineCap = "round"
  ctx.lineJoin = "round"

  // Two long outer blades, sweeping out and up like leaves off the stalk.
  const blade = (
    x0: number, y0: number, x1: number, y1: number,
    bow: number, width: number
  ) => {
    ctx.beginPath()
    ctx.moveTo(x0, y0)
    ctx.quadraticCurveTo(x0 + bow + width, (y0 + y1) / 2, x1, y1)
    ctx.quadraticCurveTo(x0 + bow - width, (y0 + y1) / 2, x0, y0)
    ctx.closePath()
    ctx.fill()
  }
  blade(s * 0.06, s * 0.56, s * 0.52, -s * 0.40, s * 0.44, s * 0.10)
  blade(s * 0.02, s * 0.58, s * 0.30, -s * 0.06, s * 0.40, s * 0.075)

  // The stalk.
  ctx.lineWidth = s * 0.036
  ctx.beginPath()
  ctx.moveTo(-s * 0.02, s * 0.56)
  ctx.quadraticCurveTo(s * 0.06, s * 0.12, s * 0.10, -s * 0.44)
  ctx.stroke()

  // Kernels: plump lozenges in opposed pairs, overlapping up the stalk.
  const rows = 6
  for (let i = 0; i < rows; i++) {
    const t = i / (rows - 1)
    const x = -s * 0.02 + s * 0.12 * t
    const y = s * 0.44 - t * s * 0.80
    // Fattest through the middle of the ear, tapering at both ends.
    const k = 0.55 + 0.45 * Math.sin(Math.PI * (0.18 + t * 0.72))
    for (const side of [-1, 1]) {
      ctx.save()
      ctx.translate(x + side * s * 0.075 * k, y)
      ctx.rotate(side * -0.62)
      ctx.beginPath()
      ctx.ellipse(0, 0, s * 0.115 * k, s * 0.056 * k, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
  }
  // Terminal kernel closing the ear.
  ctx.save()
  ctx.translate(s * 0.10, -s * 0.44)
  ctx.rotate(-0.16)
  ctx.beginPath()
  ctx.ellipse(0, 0, s * 0.048, s * 0.098, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  ctx.restore()
}

/**
 * The denomination face — the side the hero shows, drawn against the
 * reference model's own render.
 *
 * रुपया arcs with the rim, an outlined numeral 1 fills the field, wheat
 * flanks it either side, then RUPEE, the mint year, and the small Noida mint
 * mark beneath. Set in a serif, because the coin is: a geometric sans reads
 * as a label printed on a disc rather than as metal struck in a die.
 */
function drawDenomination(ctx: CanvasRenderingContext2D) {
  const n = TEXTURE_SIZE
  const c = n / 2
  drawRim(ctx)

  const SERIF = 'Georgia, "Times New Roman", serif'

  ctx.save()
  ctx.fillStyle = RAISED
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"

  // रुपया, arced along the top inside the rim.
  ctx.font = `700 ${Math.round(n * 0.098)}px "Noto Sans Devanagari", serif`
  arcText(ctx, "रुपया", c, c, n * 0.335, -Math.PI / 2, 1.04)

  // RUPEE and the year, on straight baselines low in the field.
  ctx.font = `400 ${Math.round(n * 0.092)}px ${SERIF}`
  ctx.letterSpacing = `${n * 0.014}px`
  ctx.fillText("RUPEE", c, c + n * 0.205)
  ctx.font = `400 ${Math.round(n * 0.082)}px ${SERIF}`
  ctx.letterSpacing = `${n * 0.006}px`
  ctx.fillText("2000", c, c + n * 0.315)
  ctx.letterSpacing = "0px"
  ctx.restore()

  // Numeral and wheat.
  drawNumeralOne(ctx, c, c - n * 0.045, n * 0.38)
  drawWheat(ctx, c - n * 0.145, c - n * 0.02, n * 0.30, -1)
  drawWheat(ctx, c + n * 0.145, c - n * 0.02, n * 0.30, 1)

  // Noida mint mark: a small solid dot inside a ring, under the year.
  ctx.save()
  ctx.strokeStyle = RAISED
  ctx.fillStyle = RAISED
  ctx.lineWidth = n * 0.006
  ctx.beginPath()
  ctx.arc(c, c + n * 0.395, n * 0.017, 0, Math.PI * 2)
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(c, c + n * 0.395, n * 0.006, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  addWear(ctx)
}

/** Reeded (milled) edge — fine vertical flutes around the cylinder wall. */
function drawEdge(ctx: CanvasRenderingContext2D) {
  const w = TEXTURE_SIZE
  const h = 128
  ctx.canvas.width = w
  ctx.canvas.height = h
  ctx.fillStyle = FIELD
  ctx.fillRect(0, 0, w, h)

  const reeds = 132
  for (let i = 0; i < reeds; i++) {
    const x = (i / reeds) * w
    const grad = ctx.createLinearGradient(x, 0, x + w / reeds, 0)
    grad.addColorStop(0, RECESSED)
    grad.addColorStop(0.5, RAISED)
    grad.addColorStop(1, RECESSED)
    ctx.fillStyle = grad
    ctx.fillRect(x, 0, w / reeds, h)
  }

  // Bevel the two lips so the edge does not read as a razor-sharp extrusion.
  const bevel = ctx.createLinearGradient(0, 0, 0, h)
  bevel.addColorStop(0, "rgba(0,0,0,0.55)")
  bevel.addColorStop(0.16, "rgba(0,0,0,0)")
  bevel.addColorStop(0.84, "rgba(0,0,0,0)")
  bevel.addColorStop(1, "rgba(0,0,0,0.55)")
  ctx.fillStyle = bevel
  ctx.fillRect(0, 0, w, h)
}

function toTexture(canvas: HTMLCanvasElement, repeatX = 1) {
  const t = new THREE.CanvasTexture(canvas)
  t.anisotropy = 8
  t.wrapS = THREE.RepeatWrapping
  t.wrapT = THREE.ClampToEdgeWrapping
  t.repeat.set(repeatX, 1)
  t.needsUpdate = true
  return t
}

/**
 * A cap texture, turned upright.
 *
 * A CylinderGeometry lays its cap UVs out in the XZ plane, so once the coin is
 * stood up to face the camera the artwork arrives rotated a quarter turn. The
 * two caps also disagree about handedness — the bottom cap is seen from behind
 * — so they need opposite corrections. Doing this per-texture keeps the
 * geometry untouched and the mesh's own rotation free for the pointer tilt.
 */
function faceTexture(canvas: HTMLCanvasElement, face: "obverse" | "reverse") {
  const t = toTexture(canvas)
  t.center.set(0.5, 0.5)
  // Determined by rendering rather than by reasoning about UV handedness,
  // over two passes: the quarter-turn alone left both faces mirrored and
  // inverted; repeat.y = -1 fixed the inversion and left a pure horizontal
  // mirror, which repeat.x = -1 clears. The two caps are seen from opposite
  // sides, hence the opposite quarter-turns.
  t.rotation = face === "obverse" ? -Math.PI / 2 : Math.PI / 2
  // The caps are viewed from opposite sides, so their corrections differ on
  // BOTH axes, not just one. Obverse (-1,-1) and reverse (1,1) are the pair
  // that renders each legend upright and the right way round; anything else
  // left "2024" reading backwards or upside down.
  t.repeat.set(face === "obverse" ? -1 : 1, face === "obverse" ? -1 : 1)
  t.needsUpdate = true
  return t
}

export type CoinBundle = {
  mesh: THREE.Mesh
  dispose: () => void
}

/**
 * Build the coin. Call after `document.fonts.ready` so the Devanagari and
 * Outfit faces are available to the 2D canvas — otherwise the emblem legend
 * silently renders in a fallback face.
 */
export function createCoin(): CoinBundle {
  // FRONT is the denomination face. The hero frames the coin from the +Z
  // side, and the side worth showing there is the one that says what the coin
  // is worth — the numeral, the wheat, RUPEE. The state emblem is the back.
  const frontCanvas = newCanvas()
  drawDenomination(frontCanvas.getContext("2d")!)
  const backCanvas = newCanvas()
  drawEmblem(backCanvas.getContext("2d")!)
  const edgeCanvas = newCanvas()
  drawEdge(edgeCanvas.getContext("2d")!)

  // Dev-only hook so the struck faces can be inspected at full resolution
  // without hunting for the camera angle that happens to show them.
  if (process.env.NODE_ENV !== "production") {
    ;(window as unknown as Record<string, unknown>).__coinFaces = {
      front: frontCanvas,
      back: backCanvas,
    }
  }

  const frontBump = faceTexture(frontCanvas, "obverse")
  const backBump = faceTexture(backCanvas, "reverse")
  const edgeBump = toTexture(edgeCanvas, 1)

  /**
   * One nickel-steel base for all three surfaces. Real ₹1 coins are
   * ferritic stainless — bright but not yellow, and closer to matte than to a
   * mirror. `metalness` stays at 1 (it is metal) and the character comes from
   * roughness, which is deliberately high enough to keep it out of
   * chrome-ball territory.
   */
  const base = {
    // Ferritic stainless, not silver and emphatically not gold. A touch warm
    // so it never reads as chrome, but desaturated enough to stay currency.
    color: new THREE.Color("#e8e2d6"),
    metalness: 1.0,
    // Slightly under 1 keeps a little diffuse response, which is what stops
    // the coin going to a black silhouette in a room this dark.
    roughness: 0.3,
    envMapIntensity: 2.6,
  }

  const faceMaterial = (bump: THREE.Texture) =>
    new THREE.MeshStandardMaterial({
      ...base,
      bumpMap: bump,
      bumpScale: 0.009,
      roughnessMap: bump,
      // Raised relief polishes with handling; the field stays duller.
      roughness: 0.3,
    })

  const materials = [
    new THREE.MeshStandardMaterial({
      ...base,
      bumpMap: edgeBump,
      bumpScale: 0.012,
      // The reeded edge catches the key light across its whole length; at the
      // faces' roughness it flared into a chrome band brighter than the coin.
      roughness: 0.34,
    }),
    faceMaterial(frontBump),
    faceMaterial(backBump),
  ]

  const geometry = new THREE.CylinderGeometry(
    COIN_RADIUS,
    COIN_RADIUS,
    COIN_THICKNESS,
    160,
    1
  )

  // Stand the coin up. The cap textures are oriented separately, on the
  // textures themselves — see `faceTexture`. Rotating the geometry to fix the
  // legend seemed simpler and was wrong: spinning about the cylinder's own
  // axis mirrors one cap relative to the other, which rendered INDIA
  // backwards. A texture rotation turns each face independently.
  geometry.rotateX(Math.PI / 2)

  const mesh = new THREE.Mesh(geometry, materials)
  mesh.castShadow = true
  mesh.receiveShadow = true

  return {
    mesh,
    dispose: () => {
      geometry.dispose()
      materials.forEach((m) => m.dispose())
      frontBump.dispose()
      backBump.dispose()
      edgeBump.dispose()
    },
  }
}
