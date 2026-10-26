// 主题：跟随系统 / 浅色 / 深色。同步脚本，放在 <head> 里，避免闪白。
// 结果写在 <html data-mode="light|dark">，CSS 只认这个属性。
(() => {
  const media = matchMedia('(prefers-color-scheme: dark)')
  const pref = () => { try { return localStorage.getItem('moread.theme') || 'system' } catch { return 'system' } }
  const apply = () => {
    const p = pref()
    const mode = p === 'system' ? (media.matches ? 'dark' : 'light') : p
    if (document.documentElement.dataset.mode !== mode) {
      document.documentElement.dataset.mode = mode
      dispatchEvent(new CustomEvent('moread-theme', { detail: mode }))
    }
  }
  window.moreadTheme = {
    get: pref,
    set: v => { try { localStorage.setItem('moread.theme', v) } catch {} apply() },
    mode: () => document.documentElement.dataset.mode,
  }
  media.addEventListener('change', apply)
  addEventListener('storage', e => e.key === 'moread.theme' && apply())
  apply()
})()
