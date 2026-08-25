"use client"

import * as React from "react"
import * as THREE from "three"

import { COIN_RADIUS, createCoin } from "@/components/cinematic/coin"

/**
 * The cinematic stage: one ₹1 coin on a black field, orbited by a
 * scroll-driven camera, wrapped in a slow shader atmosphere and a drift of
 * telemetry particles.
 *
 * Everything is fixed-position and driven by `window.scrollY`. The page itself
 * is 900vh of empty scroll height; nothing in the DOM moves except the overlay
 * copy. Scroll is smoothed in JS with a lerp rather than by a smooth-scroll
 * library, so the camera has inertia without the page fighting native scrolling.
 */

/* ── atmosphere ─────────────────────────────────────────────────────────── */

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

/**
 * The background is a slow field of interfering waves — the same technique the
 * reference used for liquid bronze, re-scored for Avaran.
 *
 * The palette migrates from near-black charcoal at the top of the page to a
 * deep blue-black at the bottom, with a restrained cyan crest and one warm
 * metallic note lifted from the coin itself. It is deliberately dim: at no
 * scroll position does the background compete with the coin or the type. This
 * is atmosphere, not decoration — the page should read as a dark room with one
 * lit object in it.
 */
const FRAG = /* glsl */ `
  varying vec2 vUv;
  uniform float uTime;
  uniform vec2  uResolution;
  uniform vec2  uMouse;
  uniform float uScroll;

  void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution.xy) / uResolution.y;
    float aspect = uResolution.x / uResolution.y;

    // Very slow. The atmosphere should breathe, not animate.
    float time = uTime * 0.05;
    float scroll = uScroll;

    // Constant frequencies and angles: tying them to scroll would compress the
    // waves as you scroll, which reads as speed rather than calm.
    float freq1 = 2.1, freq2 = 2.9, freq3 = 3.7;
    float angle1 = 0.55, angle2 = -0.75, angle3 = 1.25;

    // Scroll bends the wave field instead of translating it, so the motion
    // stays gentle no matter how fast the user scrolls.
    float deform = scroll * 4.0;
    vec2 w = uv;
    w.x += sin(uv.y * 2.4 + time * 0.2 + deform) * 0.34;
    w.y += cos(uv.x * 2.4 - time * 0.15 - deform * 0.8) * 0.34;
    w.x += sin(uv.y * 1.15 - time * 0.1 - deform * 1.4) * 0.22;
    w.y += cos(uv.x * 1.15 + time * 0.17 + deform * 1.1) * 0.22;
    w += vec2(scroll * 0.035, -scroll * 0.018);
    w += vec2(uMouse.x * aspect * 0.04, uMouse.y * 0.04);

    vec2 d1 = vec2(cos(angle1), sin(angle1));
    vec2 d2 = vec2(cos(angle2), sin(angle2));
    vec2 d3 = vec2(cos(angle3), sin(angle3));

    float a = sin(dot(w, d1) * freq1 + time * 1.0);
    float b = cos(dot(w, d2) * freq2 - time * 1.3 + a * 0.4);
    float c = sin(dot(w, d3) * freq3 + time * 1.7 + b * 0.5);
    float field = a * 0.50 + b * 0.35 + c * 0.15;

    float sheen = pow(max(0.0, 1.0 - abs(field - 0.10)), 2.6);
    float spec  = pow(max(0.0, 1.0 - abs(field - 0.16)), 9.0);
    float crest = sheen * 0.42 + spec * 0.85;

    // Top of page: charcoal with a warm metallic crest borrowed from the coin.
    vec3 t0_shadow = vec3(0.0035, 0.0035, 0.0040);
    vec3 t0_body   = vec3(0.020,  0.021,  0.024);
    vec3 t0_wave   = vec3(0.038,  0.038,  0.042);
    vec3 t0_crest  = vec3(0.30,   0.28,   0.25);

    // Bottom of page: deep blue-black with a restrained cyan crest.
    vec3 t1_shadow = vec3(0.0020, 0.0032, 0.0048);
    vec3 t1_body   = vec3(0.010,  0.022,  0.034);
    vec3 t1_wave   = vec3(0.016,  0.038,  0.055);
    vec3 t1_crest  = vec3(0.12,   0.34,   0.40);

    float t = smoothstep(0.0, 1.0, scroll);
    vec3 colShadow = mix(t0_shadow, t1_shadow, t);
    vec3 colBody   = mix(t0_body,   t1_body,   t);
    vec3 colWave   = mix(t0_wave,   t1_wave,   t);
    vec3 colCrest  = mix(t0_crest,  t1_crest,  t);

    vec3 color = colShadow;
    color = mix(color, colBody, smoothstep(-0.6, 0.2, field));
    color = mix(color, colWave, smoothstep(0.0, 0.8, field));
    color += colCrest * crest * 1.1;

    // Heavy vignette — the coin sits in a pool of light, the edges fall away.
    float vig = 1.0 - dot(uv, uv) * 0.42;
    color *= vig;

    gl_FragColor = vec4(color, 1.0);
  }
`

/* ── reflection environment ─────────────────────────────────────────────── */

/**
 * Metal with nothing to reflect looks like plastic. Rather than ship an HDRI,
 * this paints a small equirectangular studio — a dark floor, a bright overhead
 * softbox, and two side panels — which is enough for the coin's relief to pick
 * up believable moving highlights as the camera orbits.
 */
function createStudioEnvironment(renderer: THREE.WebGLRenderer) {
  const c = document.createElement("canvas")
  c.width = 512
  c.height = 256
  const ctx = c.getContext("2d")!

  const sky = ctx.createLinearGradient(0, 0, 0, 256)
  sky.addColorStop(0.0, "#dcd8d2")
  sky.addColorStop(0.34, "#79767a")
  sky.addColorStop(0.52, "#242427")
  sky.addColorStop(1.0, "#0c0b09")
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, 512, 256)

  // Overhead softbox — the coin's principal highlight.
  const box = ctx.createRadialGradient(150, 40, 4, 150, 40, 170)
  box.addColorStop(0, "#fff6e8")
  box.addColorStop(0.4, "#cfcbc4")
  box.addColorStop(1, "rgba(0,0,0,0)")
  ctx.fillStyle = box
  ctx.fillRect(0, 0, 512, 160)

  // Cool side panel, matching the rim light. Deliberately weak: at full
  // strength it tinted the whole coin cyan and the metal stopped reading as
  // currency.
  const cool = ctx.createRadialGradient(400, 90, 4, 400, 90, 90)
  cool.addColorStop(0, "rgba(150,190,205,0.75)")
  cool.addColorStop(1, "rgba(0,0,0,0)")
  ctx.fillStyle = cool
  ctx.fillRect(240, 0, 272, 200)

  // Warm bounce from below-left, so the coin is not lit from one side only.
  ctx.fillStyle = "rgba(150,120,90,0.55)"
  ctx.beginPath()
  ctx.ellipse(60, 190, 90, 50, 0, 0, Math.PI * 2)
  ctx.fill()

  const tex = new THREE.CanvasTexture(c)
  tex.mapping = THREE.EquirectangularReflectionMapping
  tex.colorSpace = THREE.SRGBColorSpace

  const pmrem = new THREE.PMREMGenerator(renderer)
  const env = pmrem.fromEquirectangular(tex).texture
  pmrem.dispose()
  tex.dispose()
  return env
}

/* ── particles ──────────────────────────────────────────────────────────── */

const PARTICLE_COUNT_DESKTOP = 420
const PARTICLE_COUNT_MOBILE = 150

function createParticleTexture() {
  const c = document.createElement("canvas")
  c.width = c.height = 16
  const ctx = c.getContext("2d")!
  const g = ctx.createRadialGradient(8, 8, 0, 8, 8, 8)
  g.addColorStop(0, "rgba(255,255,255,1)")
  g.addColorStop(0.3, "rgba(255,255,255,0.7)")
  g.addColorStop(0.65, "rgba(255,255,255,0.22)")
  g.addColorStop(1, "rgba(0,0,0,0)")
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 16, 16)
  return new THREE.CanvasTexture(c)
}

type ParticleDatum = {
  vx: number
  vy: number
  vz: number
  swaySpeed: number
  swayRadius: number
  phase: number
}

export type CinematicSceneHandle = {
  setScrollTarget: (v: number) => void
}

export function CinematicScene() {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const [ready, setReady] = React.useState(false)

  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const isMobile = window.innerWidth < 768
    const particleCount = isMobile
      ? PARTICLE_COUNT_MOBILE
      : PARTICLE_COUNT_DESKTOP

    let disposed = false
    let raf = 0

    const sizes = { width: window.innerWidth, height: window.innerHeight }

    const scene = new THREE.Scene()
    scene.background = new THREE.Color("#000000")
    scene.fog = new THREE.FogExp2("#000000", 0.035)

    const camera = new THREE.PerspectiveCamera(
      42,
      sizes.width / sizes.height,
      0.1,
      100
    )
    camera.position.set(0, 0.15, 6.4)
    scene.add(camera)

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: !isMobile,
      alpha: false,
      powerPreference: "high-performance",
    })
    renderer.setSize(sizes.width, sizes.height)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.5 : 2))
    renderer.shadowMap.enabled = !isMobile
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.42

    /* -- atmosphere ------------------------------------------------------- */
    const uniforms = {
      uTime: { value: 0 },
      uResolution: {
        value: new THREE.Vector2(sizes.width, sizes.height),
      },
      uMouse: { value: new THREE.Vector2(0, 0) },
      uScroll: { value: 0 },
    }
    const bgMaterial = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms,
      depthWrite: false,
      depthTest: false,
    })
    const bgGeometry = new THREE.PlaneGeometry(30, 30)
    const bgMesh = new THREE.Mesh(bgGeometry, bgMaterial)
    bgMesh.position.set(0, 0, -8)
    bgMesh.renderOrder = -10
    camera.add(bgMesh)

    /* -- environment ------------------------------------------------------ */
    const envMap = createStudioEnvironment(renderer)
    scene.environment = envMap

    /* -- lighting rig ----------------------------------------------------- */
    // Deliberately restrained next to the reference's forge: this is a
    // product-photography rig, not a stage. One key, one cool rim, one warm
    // fill, and almost no ambient — the blacks have to stay black.
    scene.add(new THREE.AmbientLight("#ffffff", 0.14))

    const keyLight = new THREE.SpotLight("#fff4e2", 85, 0, Math.PI / 4.2, 0.78, 1.2)
    keyLight.position.set(2.6, 3.4, 2.4)
    if (!isMobile) {
      keyLight.castShadow = true
      keyLight.shadow.mapSize.set(1024, 1024)
      keyLight.shadow.camera.near = 1
      keyLight.shadow.camera.far = 12
      keyLight.shadow.bias = -0.0012
    }
    scene.add(keyLight)

    const rimLight = new THREE.DirectionalLight("#cfe6f0", 4.2)
    rimLight.position.set(-3.4, 1.6, -3.0)
    scene.add(rimLight)

    const fillLight = new THREE.DirectionalLight("#fff2e4", 1.1)
    fillLight.position.set(-1.8, -2.4, 1.6)
    scene.add(fillLight)

    // THE BOUNCE CARD. The coin's faces point at the camera, so the key light
    // — high and to one side — only grazes them; the face rendered as a dark
    // disc with a bright rim, nothing like the reference. This rides just off
    // the camera's shoulder and is repositioned every frame, so whichever face
    // is turned toward the viewer is always the lit one.
    const bounce = new THREE.DirectionalLight("#fff1dd", 3.4)
    scene.add(bounce)

    // Grounding pool: a soft warm ellipse of light on the floor beneath the
    // coin. Without it the coin floats in a void — the reference sits on a
    // surface, and that contact is most of what makes it feel physical.
    const poolCanvas = document.createElement("canvas")
    poolCanvas.width = poolCanvas.height = 256
    const pctx = poolCanvas.getContext("2d")!
    const pool = pctx.createRadialGradient(128, 128, 0, 128, 128, 128)
    pool.addColorStop(0, "rgba(255,226,186,0.85)")
    pool.addColorStop(0.35, "rgba(210,175,132,0.34)")
    pool.addColorStop(1, "rgba(0,0,0,0)")
    pctx.fillStyle = pool
    pctx.fillRect(0, 0, 256, 256)
    const poolTex = new THREE.CanvasTexture(poolCanvas)
    const poolMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(5.2, 5.2),
      new THREE.MeshBasicMaterial({
        map: poolTex,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    )
    poolMesh.rotation.x = -Math.PI / 2
    poolMesh.position.y = -1.02
    poolMesh.renderOrder = -5
    scene.add(poolMesh)

    /* -- the coin --------------------------------------------------------- */
    const coinPivot = new THREE.Group()
    scene.add(coinPivot)
    let coinDispose: (() => void) | null = null

    // Fonts must be resolved before the emblem is rasterised, or the legend
    // renders in a fallback face and the coin stops reading as Indian.
    const fontsReady = document.fonts?.ready ?? Promise.resolve()
    fontsReady.then(() => {
      if (disposed) return
      const coin = createCoin()
      coinDispose = coin.dispose
      coinPivot.add(coin.mesh)
      setReady(true)
    })

    /* -- grounding shadow --------------------------------------------------
       A coin lit this hard with nothing beneath it reads as floating. This is
       a soft radial darkening on a floor plane — not a real shadow catcher,
       which would cost a second shadow pass for one ellipse. It sits just
       under the coin and always faces up, so it holds from every orbit angle
       the camera actually reaches. */
    const shadowCanvas = document.createElement("canvas")
    shadowCanvas.width = shadowCanvas.height = 128
    {
      const sctx = shadowCanvas.getContext("2d")!
      const g = sctx.createRadialGradient(64, 64, 0, 64, 64, 64)
      g.addColorStop(0, "rgba(0,0,0,0.85)")
      g.addColorStop(0.45, "rgba(0,0,0,0.42)")
      g.addColorStop(1, "rgba(0,0,0,0)")
      sctx.fillStyle = g
      sctx.fillRect(0, 0, 128, 128)
    }
    const shadowTexture = new THREE.CanvasTexture(shadowCanvas)
    const shadowMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(3.6, 3.6),
      new THREE.MeshBasicMaterial({
        map: shadowTexture,
        transparent: true,
        depthWrite: false,
        opacity: 0.9,
      })
    )
    shadowMesh.rotation.x = -Math.PI / 2
    shadowMesh.position.y = -1.06
    shadowMesh.scale.set(1, 0.62, 1)
    shadowMesh.renderOrder = -1
    scene.add(shadowMesh)

    /* -- telemetry particles ---------------------------------------------- */
    // Not sparks. These read as transactions moving through a network: cool,
    // sparse, slow, and mostly white — financial telemetry, not embers.
    const pGeometry = new THREE.BufferGeometry()
    const pPositions = new Float32Array(particleCount * 3)
    const pColors = new Float32Array(particleCount * 3)
    const pData: ParticleDatum[] = []

    for (let i = 0; i < particleCount; i++) {
      pPositions[i * 3] = (Math.random() - 0.5) * 7
      pPositions[i * 3 + 1] = (Math.random() - 0.5) * 5.5
      pPositions[i * 3 + 2] = (Math.random() - 0.5) * 7

      const roll = Math.random()
      if (roll < 0.55) {
        // neutral white — the majority, so the field stays calm
        pColors[i * 3] = 0.85
        pColors[i * 3 + 1] = 0.88
        pColors[i * 3 + 2] = 0.92
      } else if (roll < 0.85) {
        // restrained cyan
        pColors[i * 3] = 0.42
        pColors[i * 3 + 1] = 0.76
        pColors[i * 3 + 2] = 0.88
      } else {
        // a rare mint note, matching the live-status accent
        pColors[i * 3] = 0.45
        pColors[i * 3 + 1] = 0.9
        pColors[i * 3 + 2] = 0.6
      }

      pData.push({
        vx: (Math.random() - 0.5) * 0.12,
        vy: 0.05 + Math.random() * 0.14,
        vz: (Math.random() - 0.5) * 0.12,
        swaySpeed: 0.3 + Math.random() * 0.9,
        swayRadius: 0.03 + Math.random() * 0.1,
        phase: Math.random() * Math.PI * 2,
      })
    }

    pGeometry.setAttribute("position", new THREE.BufferAttribute(pPositions, 3))
    pGeometry.setAttribute("color", new THREE.BufferAttribute(pColors, 3))

    const particleTexture = createParticleTexture()
    const pMaterial = new THREE.PointsMaterial({
      size: 0.018,
      vertexColors: true,
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      map: particleTexture,
    })
    const particles = new THREE.Points(pGeometry, pMaterial)
    scene.add(particles)

    /* -- input ------------------------------------------------------------ */
    let targetMouseX = 0
    let targetMouseY = 0
    let mouseX = 0
    let mouseY = 0
    let currentScroll = 0

    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return
      targetMouseX = (e.clientX / window.innerWidth) * 2 - 1
      targetMouseY = (e.clientY / window.innerHeight) * 2 - 1
    }
    window.addEventListener("pointermove", onMove, { passive: true })

    const onResize = () => {
      sizes.width = window.innerWidth
      sizes.height = window.innerHeight
      camera.aspect = sizes.width / sizes.height
      camera.updateProjectionMatrix()
      renderer.setSize(sizes.width, sizes.height)
      renderer.setPixelRatio(
        Math.min(window.devicePixelRatio, window.innerWidth < 768 ? 1.5 : 2)
      )
      uniforms.uResolution.value.set(sizes.width, sizes.height)
    }
    window.addEventListener("resize", onResize)

    /* -- loop ------------------------------------------------------------- */
    const clock = new THREE.Clock()
    const targetPos = new THREE.Vector3()
    const lookAt = new THREE.Vector3()
    const viewDir = new THREE.Vector3()
    const camRight = new THREE.Vector3()
    const ORIGIN = new THREE.Vector3(0, 0, 0)
    const UP = new THREE.Vector3(0, 1, 0)

    const tick = () => {
      raf = requestAnimationFrame(tick)
      const dt = Math.min(clock.getDelta(), 0.05)
      const elapsed = clock.getElapsedTime()

      const maxScroll =
        document.documentElement.scrollHeight - window.innerHeight
      const scrollTop = window.scrollY || document.documentElement.scrollTop || 0
      const targetScroll = maxScroll > 0 ? scrollTop / maxScroll : 0

      const scrollVelocity = Math.abs(targetScroll - currentScroll)
      // Reduced motion still tracks scroll — it just does so without inertia,
      // so nothing keeps moving after the user stops.
      currentScroll += (targetScroll - currentScroll) * (reduced ? 1 : 0.045)
      mouseX += (targetMouseX - mouseX) * (reduced ? 0 : 0.05)
      mouseY += (targetMouseY - mouseY) * (reduced ? 0 : 0.05)

      /* particles */
      const posArr = pGeometry.attributes.position.array as Float32Array
      const speed = 1 + scrollVelocity * 7
      const turbulence = scrollVelocity * 0.7
      for (let i = 0; i < particleCount; i++) {
        const k = i * 3
        const d = pData[i]
        posArr[k] += d.vx * dt * speed
        posArr[k + 1] += d.vy * dt * speed
        posArr[k + 2] += d.vz * dt * speed
        const sway = d.swayRadius * (1 + turbulence * 3)
        posArr[k] += Math.sin(elapsed * d.swaySpeed + d.phase) * sway * dt
        posArr[k + 2] += Math.cos(elapsed * d.swaySpeed + d.phase) * sway * dt
        if (
          posArr[k + 1] > 3.2 ||
          Math.abs(posArr[k]) > 3.8 ||
          Math.abs(posArr[k + 2]) > 3.8
        ) {
          posArr[k + 1] = -2.8
          posArr[k] = (Math.random() - 0.5) * 3.2
          posArr[k + 2] = (Math.random() - 0.5) * 3.2
        }
      }
      pGeometry.attributes.position.needsUpdate = true

      /* camera — one full orbit across the page, with four macro dips.
         The dips are what stop this feeling like a turntable product demo:
         the camera comes in close at the moments the copy is making a
         specific claim, then drifts back out. */
      const s = currentScroll
      const phi = s * Math.PI * 2
      // Four macro dips across the page: the camera comes in at the moments
      // the copy is making a specific claim, then drifts back out. Without
      // them a 360 orbit is just a turntable.
      const macro = Math.sin(s * Math.PI * 4)
      // Further back on phones: the coin has to share a 390px frame with a
      // full-width column of copy.
      const near = sizes.width >= 1024 ? 0 : 2.1
      const radius = 6.3 + near - Math.sin(s * Math.PI) * 0.7 - macro * 0.75
      const height = 0.1 + Math.sin(s * Math.PI * 2) * 0.55
      targetPos.set(radius * Math.sin(phi), height, radius * Math.cos(phi))

      // The copy owns the left column on wide screens, so the coin is framed
      // right of centre — and it has to STAY right of centre through the whole
      // orbit. A fixed world-space offset does not do that: once the camera
      // swings behind the coin the same offset pushes it the other way, and at
      // scroll 0.5 the coin walked clean off the left edge of the frame.
      //
      // So the offset is computed in SCREEN space. The camera's own right
      // vector is derived per frame and the look-at target is pushed along it,
      // which keeps the coin pinned to the same side of the composition from
      // any angle. On narrow screens the copy sits below the coin instead, so
      // the offset goes to zero and the coin stays centred.
      const wide = sizes.width >= 1024
      viewDir.subVectors(ORIGIN, targetPos).normalize()
      camRight.crossVectors(viewDir, UP).normalize()
      lookAt.copy(camRight).multiplyScalar(wide ? -0.95 : 0)
      // On narrow screens the copy occupies a full-width band at the foot of
      // the screen, so the coin is aimed at instead — looking BELOW it lifts
      // it into the upper third, clear of the words. Text over the coin is the
      // one collision this layout must never produce.
      lookAt.y += wide ? -0.02 : -1.85

      camera.position.lerp(targetPos, reduced ? 1 : 0.03)
      camera.lookAt(lookAt)

      /* the coin barely moves — the camera does the work. A slow drift plus a
         little pointer tilt is enough to prove it is a physical object. */
      if (coinPivot) {
        // RESTING TILT. At -0.16 the coin was still effectively face-on and
        // read as a disc with a picture on it. Turned to -0.42 the milled
        // edge and the coin's thickness come into view on the right, which is
        // what makes it an object rather than an illustration — and matches
        // the three-quarter presentation in the reference. Pointer parallax
        // and the slow drift deflect around this angle, never back to flat.
        coinPivot.rotation.y = -0.42 + mouseX * 0.18 + Math.sin(elapsed * 0.12) * 0.05
        coinPivot.rotation.x = 0.09 + mouseY * 0.12 + Math.cos(elapsed * 0.1) * 0.03
        coinPivot.rotation.z = -0.06
        coinPivot.position.y = Math.sin(elapsed * 0.35) * 0.02
      }

      /* the key light tracks the camera a little, so the coin's relief always
         catches light no matter which side you are looking at */
      keyLight.position.set(
        targetPos.x * 0.55 + 2.2,
        4.4,
        targetPos.z * 0.55 + 1.8
      )
      // The bounce sits just off the camera's shoulder, so the face turned
      // toward the viewer is always the face being lit.
      bounce.position.set(
        targetPos.x * 0.85 - camRight.x * 1.4,
        targetPos.y * 0.6 + 0.8,
        targetPos.z * 0.85 - camRight.z * 1.4
      )

      uniforms.uTime.value = elapsed
      uniforms.uMouse.value.set(mouseX, -mouseY)
      uniforms.uScroll.value = currentScroll

      renderer.render(scene, camera)
    }
    tick()

    /* -- teardown --------------------------------------------------------- */
    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("resize", onResize)
      coinDispose?.()
      shadowMesh.geometry.dispose()
      ;(shadowMesh.material as THREE.Material).dispose()
      shadowTexture.dispose()
      pGeometry.dispose()
      pMaterial.dispose()
      particleTexture.dispose()
      bgGeometry.dispose()
      bgMaterial.dispose()
      poolMesh.geometry.dispose()
      ;(poolMesh.material as THREE.Material).dispose()
      poolTex.dispose()
      envMap.dispose()
      renderer.dispose()
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      id="stage"
      aria-hidden
      data-ready={ready ? "true" : "false"}
    />
  )
}

export { COIN_RADIUS }
