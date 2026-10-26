// 调试用：批注弹窗、选区工具条、伴读面板。node scripts/ui-flow2.mjs <bookId> <outDir>
import puppeteer from 'puppeteer-core'
const [bookId, outDir] = process.argv.slice(2)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, defaultViewport: { width: 1400, height: 860 } })
const page = await browser.newPage()
page.on('pageerror', e => console.log('[pageerror]', e.message))
await page.goto(`http://127.0.0.1:8848/reader.html?id=${bookId}`, { waitUntil: 'networkidle2' })
await sleep(3000)
// 1. 点击批注
const r = await page.evaluate(() => { const b = document.querySelector('.mo-hl')?.getBoundingClientRect(); return b && { x: b.left + b.width / 2, y: b.top + b.height / 2 } })
console.log('hl at', r)
if (r) { await page.mouse.click(r.x, r.y); await sleep(500) }
console.log('popover visible:', await page.evaluate(() => !document.querySelector('#popover').hidden))
await page.screenshot({ path: `${outDir}/flow-pop.png` })
await page.keyboard.press('Escape')
// 2. 选中文字（第4页文字层里的「git commit 把暂存区写成一个新的提交」）
await page.evaluate(() => {
  const layer = [...document.querySelectorAll('.page')].find(p => p.dataset.pageNumber === '4').querySelector('.textLayer')
  const spans = [...layer.querySelectorAll('span')].filter(s => s.textContent.includes('git commit'))
  const s = spans[0]
  const range = document.createRange()
  range.selectNodeContents(s)
  document.getSelection().removeAllRanges(); document.getSelection().addRange(range)
  s.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
})
await sleep(800)
console.log('selbar visible:', await page.evaluate(() => !document.querySelector('#selbar').hidden))
await page.evaluate(() => document.querySelector('#selbar [data-act=ask]').click())
await sleep(300)
await page.type('#askInput', '这里的「快照」具体是指什么？')
await page.screenshot({ path: `${outDir}/flow-sel.png` })
await page.evaluate(() => document.querySelector('#askSend').click())
await sleep(1200)
await page.evaluate(() => document.querySelector('[data-tab=chat]').click())
await sleep(500)
await page.screenshot({ path: `${outDir}/flow-chat.png` })
console.log('context:', await (await fetch('http://127.0.0.1:8848/api/context')).text())
await browser.close()
