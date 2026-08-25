"use client"

import * as React from "react"

import { BlurChars, LetterReveal, WordReveal } from "@/components/cinematic/reveal"

/**
 * The editorial overlay: everything that sits on top of the WebGL stage.
 *
 * One fixed layer, one scroll signal. `useSmoothScroll` reads `window.scrollY`
 * once per frame and lerps it, so every consumer — sections, grid dots,
 * progress rail — moves off the same smoothed value the camera uses. Sections
 * are absolutely positioned and swapped by scroll range rather than stacked in
 * document flow; the 1500vh of body height is empty scroll distance, nothing
 * more.
 *
 * SECTION RANGES are the page's script. Each is roughly one screen of scroll
 * wide with a short gap between, so one section has fully resolved before the
 * next begins its blur-up. The reference used 900vh for four slides; this
 * carries thirteen, so the scroll height scales with the content rather than
 * cramming thirteen beats into eight screens.
 */

export const PAGE_SCROLL_VH = 1500

type Range = [number, number]

const S: Record<string, Range> = {
  hero: [-0.02, 0.055],
  signals: [0.068, 0.132],
  transaction: [0.145, 0.209],
  behaviour: [0.222, 0.286],
  device: [0.299, 0.363],
  voice: [0.376, 0.44],
  fusion: [0.453, 0.517],
  held: [0.53, 0.6],
  how: [0.613, 0.677],
  review: [0.69, 0.754],
  console: [0.767, 0.831],
  limits: [0.844, 0.908],
  final: [0.921, 1.03],
}

const ORDER = Object.keys(S)

/* ── scroll engine ──────────────────────────────────────────────────────── */

function useSmoothScroll() {
  const [scroll, setScroll] = React.useState(0)
  const value = React.useRef(0)

  React.useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    let raf = 0
    let last = -1

    const tick = () => {
      raf = requestAnimationFrame(tick)
      const max = document.documentElement.scrollHeight - window.innerHeight
      const top = window.scrollY || document.documentElement.scrollTop || 0
      const target = max > 0 ? top / max : 0
      value.current += (target - value.current) * (reduced ? 1 : 0.06)
      // Only re-render when the value actually moved a meaningful amount —
      // a rAF-driven setState on every frame would re-render the whole
      // narrative sixty times a second for sub-pixel changes.
      const rounded = Math.round(value.current * 2000) / 2000
      if (rounded !== last) {
        last = rounded
        setScroll(rounded)
      }
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [])

  return scroll
}

const within = (v: number, [a, b]: Range) => v >= a && v <= b

/* ── shared building blocks ─────────────────────────────────────────────── */

function Section({
  id,
  range,
  scroll,
  align = "left",
  children,
}: {
  id: string
  range: Range
  scroll: number
  align?: "left" | "center" | "wide"
  children: React.ReactNode
}) {
  const active = within(scroll, range)
  return (
    <section
      id={id}
      className={`slide slide--${align} ${active ? "is-active" : ""}`}
      aria-hidden={!active}
    >
      {children}
    </section>
  )
}

function Kicker({ index, label }: { index: string; label: string }) {
  return (
    <p className="kicker">
      <span className="kicker-index">{index}</span>
      <span className="kicker-rule" aria-hidden />
      {label}
    </p>
  )
}

function ScoreChip({
  label,
  value,
  token,
}: {
  label: string
  value: string
  token: string
}) {
  return (
    <div className="score-chip" style={{ ["--sig" as string]: token }}>
      <span className="score-chip-bar" aria-hidden />
      <span className="score-chip-label">{label}</span>
      <span className="score-chip-value">{value}</span>
    </div>
  )
}

/* ── data visualisations ────────────────────────────────────────────────── */

/**
 * ⚠ Every figure on this page is the SAME illustrative payment — the fixture
 * whose numbers come from a real `fuse()` run (risk 61.93, transaction 0.62,
 * behaviour 0.55, device 0.71, voice unavailable). Nothing is fetched and no
 * detector is running behind it. Each visual says so in its own caption.
 */
const EXAMPLE = "Example payment · not live data"

function TransactionChart({ active }: { active: boolean }) {
  const prior = [2400, 4100, 1900, 3750, 2200, 5200, 3100, 4400, 2000, 4800]
  const held = 45000
  const bars = [...prior, held]
  return (
    <figure className="viz">
      <svg viewBox="0 0 100 42" preserveAspectRatio="none" role="img"
        aria-label="Ten prior payments to known recipients, then the held payment at roughly twelve times the usual amount. Example data.">
        {bars.map((v, i) => {
          const isHeld = i === bars.length - 1
          // True proportion — the outlier dwarfing the history IS the claim,
          // so the scale is never compressed. The history gets a floor so it
          // still reads as bars rather than as a flat line.
          const h = Math.max((v / held) * 40, 3)
          const w = (100 - 2.6 * (bars.length - 1)) / bars.length
          return (
            <rect key={i} x={i * (w + 2.6)} y={42 - h} width={w} height={h} rx={0.8}
              className={isHeld ? "viz-bar viz-bar--flag" : "viz-bar"}
              style={{ transitionDelay: `${0.25 + i * 0.035}s`, transformOrigin: "bottom" }}
              data-on={active ? "1" : "0"} />
          )
        })}
      </svg>
      <figcaption className="viz-caption">
        <span>Your last 10 payments to known recipients</span>
        <span className="viz-flag">This one · 12×</span>
      </figcaption>
      <p className="viz-note">{EXAMPLE}</p>
    </figure>
  )
}

function BehaviourChart({ active }: { active: boolean }) {
  const sessions = [0.18, 0.24, 0.14, 0.28, 0.2, 0.26, 0.55, 0.47, 0.22, 0.16]
  const threshold = 0.4
  return (
    <figure className="viz">
      <svg viewBox="0 0 100 42" preserveAspectRatio="none" role="img"
        aria-label="Deviation from this account's own baseline across ten recent sessions; two sit above the normal range. Example data.">
        <line x1="0" x2="100" y1={42 - threshold * 38} y2={42 - threshold * 38}
          className="viz-baseline" vectorEffect="non-scaling-stroke" />
        {sessions.map((v, i) => {
          const h = v * 38
          const w = 4.4
          const step = (100 - w) / (sessions.length - 1)
          return (
            <rect key={i} x={i * step} y={42 - h} width={w} height={h}
              rx={Math.min(w, h) / 2}
              className={v >= threshold ? "viz-bar viz-bar--behaviour-hi" : "viz-bar viz-bar--behaviour"}
              style={{ transitionDelay: `${0.25 + i * 0.04}s`, transformOrigin: "bottom" }}
              data-on={active ? "1" : "0"} />
          )
        })}
      </svg>
      <figcaption className="viz-caption">
        <span>Deviation from <em>your</em> baseline</span>
        <span className="viz-flag">0.55</span>
      </figcaption>
      <p className="viz-note">{EXAMPLE}</p>
    </figure>
  )
}

function DeviceFacts({ active }: { active: boolean }) {
  const rows = [
    { k: "Handset", v: "Not seen before", tone: "warn" },
    { k: "App install age", v: "4 days", tone: "warn" },
    { k: "Location", v: "Usual city", tone: "ok" },
  ]
  return (
    <figure className="viz">
      <ul className="fact-list">
        {rows.map((r, i) => (
          <li key={r.k} className="fact-row" data-on={active ? "1" : "0"}
            style={{ transitionDelay: `${0.3 + i * 0.09}s` }}>
            <span className="fact-key">{r.k}</span>
            <span className={`fact-val fact-val--${r.tone}`}>{r.v}</span>
          </li>
        ))}
      </ul>
      <p className="viz-note">{EXAMPLE}</p>
    </figure>
  )
}

function VoiceEvidence({ active }: { active: boolean }) {
  const phrases = [
    "Do it right now",
    "Don't tell anyone",
    "Install this to fix it",
    "Stay on the line",
  ]
  return (
    <figure className="viz">
      <ul className="phrase-list">
        {phrases.map((p, i) => (
          <li key={p} className="phrase" data-on={active ? "1" : "0"}
            style={{ transitionDelay: `${0.28 + i * 0.1}s` }}>
            &ldquo;{p}&rdquo;
          </li>
        ))}
      </ul>
      <div className="unavailable-note" data-on={active ? "1" : "0"}
        style={{ transitionDelay: "0.72s" }}>
        <span className="unavailable-tag">Unavailable</span>
        <p>
          No call was active, so this signal is excluded from the score —{" "}
          <strong>not counted as safe.</strong>
        </p>
      </div>
      <p className="viz-note">{EXAMPLE}</p>
    </figure>
  )
}

function FusionMeter({ active }: { active: boolean }) {
  const rows = [
    { k: "Transaction", v: "0.62", token: "var(--sig-transaction)", w: 62 },
    { k: "Behaviour", v: "0.55", token: "var(--sig-behaviour)", w: 55 },
    { k: "Device", v: "0.71", token: "var(--sig-device)", w: 71 },
    { k: "Voice & call", v: "unavailable", token: "var(--sig-voice)", w: 0 },
  ]
  return (
    <figure className="viz">
      <ul className="fusion-list">
        {rows.map((r, i) => (
          <li key={r.k} className="fusion-row" data-on={active ? "1" : "0"}
            style={{ transitionDelay: `${0.24 + i * 0.08}s` }}>
            <span className="fusion-key">{r.k}</span>
            <span className="fusion-track">
              <span className="fusion-fill"
                style={{
                  width: active ? `${r.w}%` : "0%",
                  background: r.token,
                  transitionDelay: `${0.34 + i * 0.08}s`,
                }} />
            </span>
            <span className={`fusion-val ${r.w === 0 ? "is-na" : ""}`}>{r.v}</span>
          </li>
        ))}
      </ul>
      <div className="fusion-total" data-on={active ? "1" : "0"}
        style={{ transitionDelay: "0.68s" }}>
        <span className="fusion-score">62</span>
        <span className="fusion-outof">/ 100</span>
        <span className="band band--medium">Medium risk</span>
      </div>
      <p className="viz-note">
        Re-weighted across the three detectors that reported. {EXAMPLE}
      </p>
    </figure>
  )
}

/** The held-payment screen: the REAL risk card, embedded live. */
function HeldPaymentFrame({ active }: { active: boolean }) {
  return (
    <div className="phone" data-on={active ? "1" : "0"}>
      <div className="phone-bezel">
        <span className="phone-notch" aria-hidden />
        <div className="phone-screen">
          {/* Not a mockup and not a screenshot: this is the same
              <RiskDecisionCard /> the product route renders, loaded from
              /embed/risk-card so its own breakpoints resolve at true phone
              width. It cannot drift from the product, because there is only
              one implementation. `inert` keeps it out of the tab order. */}
          <iframe src="/embed/risk-card?y=0" title="Avaran held-payment screen"
            loading="lazy" tabIndex={-1} inert className="phone-viewport"
            scrolling="no" />
        </div>
      </div>
    </div>
  )
}

function ConsoleTable({ active }: { active: boolean }) {
  const cases = [
    { id: "TXN-4471", amt: "₹45,000", score: "62", band: "medium", cov: "3 / 4", st: "Held" },
    { id: "TXN-4468", amt: "₹1,200", score: "18", band: "low", cov: "4 / 4", st: "Cleared" },
    { id: "TXN-4462", amt: "₹92,500", score: "81", band: "high", cov: "4 / 4", st: "Held" },
    { id: "TXN-4455", amt: "₹6,400", score: "44", band: "medium", cov: "2 / 4", st: "Reviewed" },
  ]
  return (
    <div className="console" data-on={active ? "1" : "0"}>
      <div className="console-head">
        <span>Case</span><span>Amount</span><span>Score</span>
        <span>Coverage</span><span>Status</span>
      </div>
      {cases.map((c, i) => (
        <div key={c.id} className="console-row" data-on={active ? "1" : "0"}
          style={{ transitionDelay: `${0.3 + i * 0.07}s` }}>
          <span className="mono">{c.id}</span>
          <span className="mono">{c.amt}</span>
          <span className={`console-score band--${c.band}`}>{c.score}</span>
          <span className="mono dim">{c.cov}</span>
          <span className="console-status">{c.st}</span>
        </div>
      ))}
      <p className="viz-note">{EXAMPLE}</p>
    </div>
  )
}

/* ── header, grid, progress ─────────────────────────────────────────────── */

const NAV = [
  { label: "Signals", at: 0.1 },
  { label: "Held", at: 0.565 },
  { label: "Limits", at: 0.876 },
]

function Header() {
  const go = (t: number) => (e: React.MouseEvent) => {
    e.preventDefault()
    const max = document.documentElement.scrollHeight - window.innerHeight
    window.scrollTo({ top: max * t, behavior: "smooth" })
  }
  return (
    <header className="chrome-header">
      <a className="brand" href="#top" onClick={go(0)}>
        <span className="brand-name">Avaran</span>
        <span className="brand-rule" aria-hidden />
        <span className="brand-sub">UPI fraud-risk shield</span>
      </a>
      <nav className="chrome-nav">
        {NAV.map((n, i) => (
          <React.Fragment key={n.label}>
            {i > 0 ? <span className="nav-dot" aria-hidden /> : null}
            <a href="#" className="nav-link" onClick={go(n.at)}>{n.label}</a>
          </React.Fragment>
        ))}
      </nav>
      <a href="#" className="cta-pill" onClick={go(0.565)}>
        See a held payment
      </a>
    </header>
  )
}

function ProgressRail({ scroll }: { scroll: number }) {
  // Hidden on the opening frame, easing in over the first beat. The hero is
  // the one screen that has to be completely clean.
  const shown = Math.max(0, Math.min(1, (scroll - 0.012) / 0.045))
  return (
    <div className="progress-rail" aria-hidden style={{ opacity: shown }}>
      {ORDER.map((key, i) => {
        const [a, b] = S[key]
        const p = Math.max(0, Math.min(1, (scroll - a) / (b - a)))
        return (
          <span className="progress-dash" key={key}>
            <span className="progress-fill" style={{ height: `${p * 100}%` }} />
          </span>
        )
      })}
    </div>
  )
}

/* ── the narrative ──────────────────────────────────────────────────────── */

export function Narrative() {
  const scroll = useSmoothScroll()
  const on = (k: string) => within(scroll, S[k])

  // 1 at the very top and the very bottom, 0.09 through the middle.
  const plinth =
    scroll < 0.06
      ? 1
      : scroll > 0.9
        ? Math.min(1, 0.09 + (scroll - 0.9) * 10)
        : Math.max(0.09, 1 - (scroll - 0.06) * 14)

  return (
    <div className="overlay">
      <Header />
      <ProgressRail scroll={scroll} />

      <div className="stage-copy">
        {/* 01 ─ HERO */}
        <Section id="top" range={S.hero} scroll={scroll}>
          <p className="eyebrow">
            Real-time · before the payment completes
          </p>
          <WordReveal as="h1" className="display display--hero"
            text="Avaran holds the payment while you think." stagger={0.08} delay={0.15} />
          <WordReveal as="p" className="pull-quote"
            text="The moment before you tap confirm is the only moment that can still save the money."
            stagger={0.035} delay={0.75} />
          <div className="cta-row">
            <a href="#held" className="btn btn--solid" onClick={(e) => {
              e.preventDefault()
              const max = document.documentElement.scrollHeight - window.innerHeight
              window.scrollTo({ top: max * 0.565, behavior: "smooth" })
            }}>See a held payment</a>
            <a href="#signals" className="btn btn--ghost" onClick={(e) => {
              e.preventDefault()
              const max = document.documentElement.scrollHeight - window.innerHeight
              window.scrollTo({ top: max * 0.1, behavior: "smooth" })
            }}>Read the four signals</a>
          </div>
        </Section>

        {/* 02 ─ FOUR SIGNALS */}
        <Section id="signals" range={S.signals} scroll={scroll} align="wide">
          <Kicker index="02" label="Four signals" />
          <BlurChars className="display"
            text={"Four different kinds of evidence,\nnot four copies of the same one."} />
          <p className="body">
            Each one reads something the others can&rsquo;t see, scores it
            independently, and reports — or admits it has nothing to report.
          </p>
          <div className="signal-row">
            {[
              ["Transaction pattern", "var(--sig-transaction)"],
              ["Behaviour anomaly", "var(--sig-behaviour)"],
              ["Device trust", "var(--sig-device)"],
              ["Voice & call context", "var(--sig-voice)"],
            ].map(([label, token], i) => (
              <span className="signal-tag" key={label}
                data-on={on("signals") ? "1" : "0"}
                style={{ ["--sig" as string]: token, transitionDelay: `${0.4 + i * 0.08}s` }}>
                <span className="signal-tag-bar" aria-hidden />
                {label}
              </span>
            ))}
          </div>
        </Section>

        {/* 03 ─ TRANSACTION */}
        <Section id="transaction" range={S.transaction} scroll={scroll}>
          <Kicker index="03" label="Transaction pattern" />
          <BlurChars className="display display--sm"
            text={"It knows what your payments\nnormally look like."} />
          <p className="body">
            ₹45,000 at 11 PM to someone you have never paid is a different fact
            than ₹45,000 to your landlord on the 1st.
          </p>
          <TransactionChart active={on("transaction")} />
          <ScoreChip label="Transaction" value="0.62" token="var(--sig-transaction)" />
        </Section>

        {/* 04 ─ BEHAVIOUR */}
        <Section id="behaviour" range={S.behaviour} scroll={scroll}>
          <Kicker index="04" label="Behaviour anomaly" />
          <BlurChars className="display display--sm"
            text={"It learns your rhythm,\nnot a national average."} />
          <p className="body">
            Unsupervised, personal, and untrained until it has watched you. On
            day one it reports nothing at all — and says so.
          </p>
          <BehaviourChart active={on("behaviour")} />
          <ScoreChip label="Behaviour" value="0.55" token="var(--sig-behaviour)" />
        </Section>

        {/* 05 ─ DEVICE */}
        <Section id="device" range={S.device} scroll={scroll}>
          <Kicker index="05" label="Device trust" />
          <BlurChars className="display display--sm"
            text={"Is this the handset\nthat usually pays?"} />
          <p className="body">
            Handset, app install and location, checked against what is familiar
            for this account. Device identity is hashed before it is scored.
          </p>
          <DeviceFacts active={on("device")} />
          <ScoreChip label="Device" value="0.71" token="var(--sig-device)" />
        </Section>

        {/* 06 ─ VOICE */}
        <Section id="voice" range={S.voice} scroll={scroll}>
          <Kicker index="06" label="Voice & call context" />
          <BlurChars className="display display--sm"
            text={"The only signal that hears\nthe person pressuring you."} />
          <p className="body">
            If a call is live while you pay, Avaran listens for the shape of a
            scam call — urgency, secrecy, requests for remote control.
          </p>
          <VoiceEvidence active={on("voice")} />
        </Section>

        {/* 07 ─ RISK FUSION */}
        <Section id="fusion" range={S.fusion} scroll={scroll}>
          <Kicker index="07" label="Risk fusion" />
          <BlurChars className="display display--sm"
            text={"Whatever reported\nbecomes one score."} />
          <p className="body">
            A signal that did not run is marked unavailable and the score is
            re-weighted around the ones that did.{" "}
            <strong>Silence is never counted as safety.</strong>
          </p>
          <FusionMeter active={on("fusion")} />
        </Section>

        {/* 08 ─ HELD PAYMENT */}
        <Section id="held" range={S.held} scroll={scroll} align="wide">
          <div className="held-grid">
            <div>
              <Kicker index="08" label="The held payment" />
              <BlurChars className="display display--sm"
                text={"Nothing has been sent yet."} />
              <p className="body">
                ₹45,000 to Rohit Verma, a recipient you have not paid before.
                Held, scored, and explained — then handed back to you.
              </p>
              <div className="held-actions" data-on={on("held") ? "1" : "0"}>
                <span className="btn btn--solid btn--static">Cancel payment</span>
                <span className="btn btn--ghost btn--static">Confirm anyway</span>
              </div>
              <p className="micro">
                Urgent payments are never blocked for you. The choice stays yours.
              </p>
            </div>
            <HeldPaymentFrame active={on("held")} />
          </div>
        </Section>

        {/* 09 ─ HOW IT WORKS */}
        <Section id="how" range={S.how} scroll={scroll} align="wide">
          <Kicker index="09" label="How it works" />
          <BlurChars className="display display--sm"
            text={"Score. Explain.\nThen wait for you."} />
          <ol className="steps">
            {[
              ["01", "You start a UPI payment",
                "The four signals run in parallel on the payment as it stands."],
              ["02", "Whatever reported becomes one score",
                "0–100, banded low / medium / high, re-weighted around the signals that actually had something to say."],
              ["03", "You decide, in plain words",
                "You see the reasons, not a verdict handed down. Cancel, or confirm anyway."],
            ].map(([n, t, b], i) => (
              <li key={n} className="step" data-on={on("how") ? "1" : "0"}
                style={{ transitionDelay: `${0.35 + i * 0.12}s` }}>
                <span className="step-n">{n}</span>
                <span className="step-body">
                  <strong>{t}</strong>
                  <span>{b}</span>
                </span>
              </li>
            ))}
          </ol>
        </Section>

        {/* 10 ─ FALSE POSITIVE REVIEW */}
        <Section id="review" range={S.review} scroll={scroll}>
          <Kicker index="10" label="If we get it wrong" />
          <BlurChars className="display display--sm"
            text={"A false positive is a case\nto review, not a dead end."} />
          <p className="body">
            Every held payment keeps its score and the reasons behind it. If a
            legitimate payment was flagged, your bank can open the case, see
            which signals fired and which never reported, and mark it — so the
            same pattern stops costing you time.
          </p>
          <div className="case-strip" data-on={on("review") ? "1" : "0"}>
            <span className="case-tag">Case status</span>
            <span className="case-pill">Under review</span>
            <span className="case-meta">Score and signal breakdown attached</span>
          </div>
        </Section>

        {/* 11 ─ INSTITUTION CONSOLE */}
        <Section id="console" range={S.console} scroll={scroll} align="wide">
          <Kicker index="11" label="For banks & institutions" />
          <BlurChars className="display display--sm"
            text={"The same decision,\nwith the working shown."} />
          <ConsoleTable active={on("console")} />
        </Section>

        {/* 12 ─ HONEST LIMITS */}
        <Section id="limits" range={S.limits} scroll={scroll} align="wide">
          <Kicker index="12" label="Honest limits" />
          <BlurChars className="display display--sm" text={"What Avaran does not do."} />
          <div className="limits-grid">
            {[
              ["It does not block your payment",
                "It holds and explains. Confirming anyway is always available."],
              ["It does not identify voices",
                "No deepfake detection, no emotion reading. It looks for pressure patterns, nothing more."],
              ["It does not recover sent money",
                "Its whole value is in the seconds before a payment completes."],
              ["It does not verify who someone is",
                "It is not a KYC or identity check. It reads risk, not identity."],
            ].map(([t, b], i) => (
              <div key={t} className="limit" data-on={on("limits") ? "1" : "0"}
                style={{ transitionDelay: `${0.35 + i * 0.09}s` }}>
                <h3>{t}</h3>
                <p>{b}</p>
              </div>
            ))}
          </div>
        </Section>

        {/* 13 ─ FINAL */}
        <Section id="final" range={S.final} scroll={scroll} align="center">
          <BlurChars className="display display--final"
            text={"The payment can wait four seconds."} />
          <p className="pull-quote pull-quote--center">
            Your money, after it&rsquo;s gone, cannot.
          </p>
          <div className="cta-row cta-row--center">
            <a href="#" className="btn btn--solid" onClick={(e) => e.preventDefault()}>
              Add Avaran to your payments
            </a>
            <a href="#" className="btn btn--ghost" onClick={(e) => {
              e.preventDefault()
              const max = document.documentElement.scrollHeight - window.innerHeight
              window.scrollTo({ top: max * 0.1, behavior: "smooth" })
            }}>See the four signals again</a>
          </div>
        </Section>
      </div>

      {/* THE BRAND PLINTH — footer line plus the giant wordmark.
          Both are present for the whole page but only assert themselves at the
          two beats that are about the brand rather than the product: the
          opening and the close. In between they recede to a whisper, because
          at full strength a 17vw wordmark sits straight through the middle of
          every section's copy — which is exactly what it did on the first
          build. Driven by scroll, not by a hover or a timer. */}
      <div className="chrome-footer" style={{ opacity: plinth }}>
        {/* Lockup only. This carried a two-line note, which put a paragraph
            of footer chrome straight through the hero's call-to-action row.
            The footer's job here is the mark and the year. */}
        <span className="footer-lockup">
          Avaran <span lang="hi" className="footer-indic">आवरण</span>
        </span>
        <span className="footer-copy">© 2026 Avaran</span>
      </div>

      {/* The wordmark, letter-revealed on load. */}
      <div className="wordmark-wrap" aria-hidden style={{ opacity: plinth }}>
        <LetterReveal className="wordmark" text="AVARAN" stagger={0.09} delay={0.35} />
      </div>
    </div>
  )
}
