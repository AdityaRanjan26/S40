import { chromium } from "playwright"
const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark" })
await p.goto("http://localhost:3000/", { waitUntil: "networkidle" })
await p.evaluate(() => document.fonts.ready)
await p.waitForTimeout(4000)
// Park the camera where it faces the coin's obverse.
await p.evaluate(() => {
  const max = document.documentElement.scrollHeight - window.innerHeight
  window.scrollTo({ top: max * 0.435, behavior: "instant" })
})
await p.waitForTimeout(11000)
await p.screenshot({ path: "../../.impeccable/review/cinematic/_lion.png", clip: { x: 820, y: 180, width: 700, height: 700 } })
console.log("ok")
await b.close()
