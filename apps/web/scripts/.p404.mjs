import { chromium } from "playwright"
const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 390, height: 844 }, colorScheme: "dark" })
const bad = []
p.on("response", (r) => {
  if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`)
})
await p.goto("http://localhost:3000/", { waitUntil: "networkidle" })
await p.evaluate(() => document.fonts.ready)
// Scroll to the held-payment beat where the phone frame lives.
await p.evaluate(() => {
  const max = document.documentElement.scrollHeight - window.innerHeight
  window.scrollTo({ top: max * 0.565, behavior: "instant" })
})
await p.waitForTimeout(6000)
const info = await p.evaluate(() => {
  const f = document.querySelector("iframe.phone-viewport")
  if (!f) return { iframe: "absent" }
  const d = f.contentDocument
  return {
    src: f.getAttribute("src"),
    resolved: f.src,
    title: d?.title,
    body: (d?.body?.innerText || "").trim().slice(0, 120),
  }
})
console.log(JSON.stringify(info, null, 1))
console.log("failed requests:", bad.length ? bad.slice(0, 6) : "none")
await b.close()
