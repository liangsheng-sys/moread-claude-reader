// 生成测试用的示例书：一本带图 PDF 教程（经 Chrome 打印）、一本带图 EPUB。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { zipSync, strToU8 } from 'fflate'
import { pathToFileURL } from 'node:url'

const out = process.argv[2]
const tmp = process.argv[3]
fs.mkdirSync(out, { recursive: true }); fs.mkdirSync(tmp, { recursive: true })

const chapters = [
  ['第1章 什么是 Git', '版本控制系统用来记录文件的每一次修改。Git 是分布式版本控制系统，每个开发者本地都有完整的仓库历史。与集中式系统不同，离线时也能提交、查看历史和创建分支。', 'commit'],
  ['第2章 工作区、暂存区与仓库', 'Git 有三个区域：工作区是你正在编辑的文件；暂存区（index）保存下一次提交的快照；仓库保存所有提交。git add 把修改放进暂存区，git commit 把暂存区写成一个新的提交。', 'areas'],
  ['第3章 分支与合并', '分支本质上是指向某个提交的可移动指针。创建分支几乎没有成本。git merge 会把另一条分支的修改合进来；如果两边修改了同一处，就会产生冲突，需要手动解决后再提交。', 'branch'],
  ['第4章 变基 rebase', '变基把一串提交“搬”到另一个基点上，让历史变成一条直线。黄金法则：不要对已经推送到公共仓库、别人可能基于其工作的提交执行变基，否则会让协作者的历史错乱。', 'rebase'],
  ['第5章 远程仓库协作', 'git fetch 下载远程的新提交但不修改你的工作区；git pull 等于 fetch 加 merge。推送前先拉取，可以减少冲突。Pull Request 是在代码托管平台上请求别人审阅并合并你的分支。', 'remote'],
]
const svg = kind => {
  const nodes = kind === 'areas' ? ['工作区', '暂存区', '仓库'] : kind === 'branch' ? ['main', 'feature', 'merge'] : ['C1', 'C2', 'C3']
  return `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="120" viewBox="0 0 420 120"><rect width="420" height="120" fill="#f6f3ea"/>${nodes.map((n, i) => `<rect x="${20 + i * 140}" y="40" width="100" height="40" rx="8" fill="#fff" stroke="#333"/><text x="${70 + i * 140}" y="66" font-size="16" text-anchor="middle" font-family="sans-serif">${n}</text>${i < 2 ? `<line x1="${120 + i * 140}" y1="60" x2="${160 + i * 140}" y2="60" stroke="#c33" stroke-width="3"/>` : ''}`).join('')}<text x="210" y="105" font-size="12" text-anchor="middle" fill="#666">图：${kind}</text></svg>`
}
const filler = i => Array.from({ length: 14 }, (_, k) => `<p>这是第${i + 1}章的第${k + 1}段练习说明。读者应当亲手在终端里执行示例命令，观察 git status 和 git log --oneline --graph 的输出变化，理解每一步对三个区域的影响。</p>`).join('')

// PDF
const html = `<!doctype html><meta charset="utf-8"><title>Git 图解入门</title><style>body{font-family:"Microsoft YaHei",sans-serif;font-size:14px;line-height:1.7;margin:40px} h1{page-break-before:always} h1:first-of-type{page-break-before:avoid} pre{background:#eee;padding:8px}</style>
<h1>第0章 前言</h1><p>本书用图解的方式讲 Git。每章配有示意图和练习。</p>` +
  chapters.map(([t, body, kind], i) => `<h1>${t}</h1><p>${body}</p><img src="data:image/svg+xml;base64,${Buffer.from(svg(kind)).toString('base64')}"><pre>$ git status\n$ git log --oneline --graph</pre>${filler(i)}`).join('')
fs.writeFileSync(path.join(tmp, 'git.html'), html)
const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
execFileSync(chrome, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--generate-pdf-document-outline', `--user-data-dir=${path.join(tmp, 'chrome')}`, `--print-to-pdf=${path.join(out, 'Git图解入门.pdf')}`, pathToFileURL(path.join(tmp, 'git.html')).href], { stdio: 'inherit' })

// EPUB
const files = {
  mimetype: strToU8('application/epub+zip'),
  'META-INF/container.xml': strToU8(`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`),
}
const items = chapters.map((c, i) => ({ id: `c${i}`, href: `ch${i}.xhtml`, title: c[0] }))
items.forEach(({ href, title }, i) => {
  files[`OEBPS/${href}`] = strToU8(`<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body><h1>${title}</h1><p>${chapters[i][1]}</p><p><img src="img/${chapters[i][2]}.svg" alt="示意图"/></p>${filler(i)}</body></html>`)
  files[`OEBPS/img/${chapters[i][2]}.svg`] = strToU8(svg(chapters[i][2]))
})
files['OEBPS/nav.xhtml'] = strToU8(`<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol>${items.map(i => `<li><a href="${i.href}">${i.title}</a></li>`).join('')}</ol></nav></body></html>`)
files['OEBPS/content.opf'] = strToU8(`<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">git-epub-sample</dc:identifier><dc:title>Git 图解入门（EPUB 版）</dc:title><dc:creator>墨知示例</dc:creator><dc:language>zh-CN</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${items.map(i => `<item id="${i.id}" href="${i.href}" media-type="application/xhtml+xml"/>`).join('')}${chapters.map(c => `<item id="img-${c[2]}" href="img/${c[2]}.svg" media-type="image/svg+xml"/>`).join('')}</manifest><spine>${items.map(i => `<itemref idref="${i.id}"/>`).join('')}</spine></package>`)
fs.writeFileSync(path.join(out, 'Git图解入门.epub'), zipSync(files, { level: 0 }))
console.log('done')
