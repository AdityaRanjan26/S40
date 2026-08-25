import { chromium } from "playwright"
import { writeFileSync } from "node:fs"
const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1200, height: 800 }, colorScheme: "dark" })
await p.goto("http://localhost:3000/", { waitUntil: "networkidle" })
await p.evaluate(() => document.fonts.ready)
await p.waitForTimeout(5000)
for (const key of ["front", "back"]) {
  const dataUrl = await p.evaluate((k) => {
    const f = window.__coinFaces
    return f && f[k] ? f[k].toDataURL("image/png") : null
  }, key)
  if (!dataUrl) { console.log(key, "MISSING"); continue }
  writeFileSync(`../../.impeccable/review/cinematic/_tex-${key}.png`,
    Buffer.from(dataUrl.split(",")[1], "base64"))
  console.log("wrote", key)
}
await b.close()
