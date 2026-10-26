// 各页面共用的顶部导航：<nav class="topnav" id="topnav"></nav>
const LINKS = [['/', '书库'], ['/review.html', '回顾'], ['/stats.html', '足迹'], ['/settings.html', '设置']]
const el = document.getElementById('topnav')
if (el) {
  const here = location.pathname === '/index.html' ? '/' : location.pathname
  el.innerHTML = LINKS.map(([href, label]) => `<a href="${href}"${href === here ? ' class="on"' : ''}>${label}</a>`).join('')
}
