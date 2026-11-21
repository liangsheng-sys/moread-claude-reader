// 调试用：用本机 Chrome 打开页面截图并收集控制台错误。node scripts/ui-check.mjs <path> <out.png> [waitMs]
import puppeteer from 'puppeteer-core'
const [p = '/', out = 'shot.png', wait = '2500'] = process.argv.slice(2)
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, defaultViewport: { width: 1400, height: 860 } })
const page = await browser.newPage()
page.on('console', m => ['error', 'warning'].includes(m.type()) && console.log(`[${m.type()}]`, m.text()))
page.on('pageerror', e => console.log('[pageerror]', e.message))
page.on('response', r => r.status() >= 400 && console.log('[http ' + r.status() + ']', r.url()))
page.on('requestfailed', r => console.log('[requestfailed]', r.url(), r.failure()?.errorText))
await page.goto(`http://127.0.0.1:${process.env.MOREAD_PORT || 8848}` + p, { waitUntil: 'networkidle2' })
await new Promise(r => setTimeout(r, Number(wait)))
await page.screenshot({ path: out })
await browser.close()
