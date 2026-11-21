// 调试用：端到端检查阅读器交互。node scripts/ui-flow.mjs <bookId> <section> <quote> <outDir>
import puppeteer from 'puppeteer-core'
const [bookId, section, quote, outDir, mode] = process.argv.slice(2)
const mcp = (name, args) => fetch('http://127.0.0.1:8848/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }).then(r => r.json()).then(r => r.result.content[0].text)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, defaultViewport: { width: 1400, height: 860 } })
const page = await browser.newPage()
page.on('pageerror', e => console.log('[pageerror]', e.message))
page.on('console', m => m.type() === 'error' && !m.text().includes('404') && console.log('[console]', m.text()))
await page.goto(`http://127.0.0.1:8848/reader.html?id=${bookId}`, { waitUntil: 'networkidle2' })
await sleep(2000)
// 通过目录跳转
await page.evaluate(s => [...document.querySelectorAll('.toc-item')].find(e => e.dataset.section === s)?.click(), section)
await sleep(2500)
console.log('progress:', await mcp('get_reading_progress', { book_id: bookId }).then(t => JSON.stringify(JSON.parse(t).current)))
console.log('add_annotation:', await mcp('add_annotation', { book_id: bookId, section: Number(section), quote, note: '**注意**：这就是 `git add` 和 `git commit` 分两步的原因——先挑选，再定稿。' }))
await sleep(1500)
console.log('pdf 划线元素:', await page.evaluate(() => document.querySelectorAll('.mo-hl').length))
console.log('annotation cfi:', await mcp('list_annotations', { book_id: bookId }))
console.log('say:', await mcp('say', { book_id: bookId, message: '第2章这张三区域图很关键，读完可以试着自己画一遍 😊' }))
await sleep(800)
await page.screenshot({ path: `${outDir}/flow-1.png` })
console.log('selection 写入后 context:', await page.evaluate(async () => {
  return 'n/a'
}))
await browser.close()
