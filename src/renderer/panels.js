/** 一张工具面板，三个互斥视图；收起面板不改变聊天、记忆和音乐的运行状态。 */
;(() => {
  const shell = document.getElementById('companion-panel')
  const panes = { chat: 'history-panel', memory: 'memory-view', sing: 'sing-panel' }
  let selected = 'chat'
  function open(tab = selected) {
    if (!panes[tab]) return
    selected = tab
    shell.hidden = false
    for (const [name, id] of Object.entries(panes)) {
      document.getElementById(id).hidden = name !== tab
      const button = document.getElementById('tab-' + name)
      button.setAttribute('aria-selected', String(name === tab))
      button.tabIndex = name === tab ? 0 : -1
    }
    for (const [id, name] of [['btn-history', 'chat'], ['btn-memory', 'memory'], ['btn-sing', 'sing']]) {
      document.getElementById(id).classList.toggle('active', name === tab)
    }
    document.getElementById('btn-history').setAttribute('aria-expanded', 'true')
    document.getElementById('more-menu').open = false
    window.pet.setUiState({ panelTab: tab }).catch(() => {})
    window.dispatchEvent(new CustomEvent('pet:panel', { detail: { tab } }))
  }
  function close() {
    shell.hidden = true
    document.getElementById('btn-history').setAttribute('aria-expanded', 'false')
    for (const id of ['btn-history', 'btn-memory', 'btn-sing']) document.getElementById(id).classList.remove('active')
  }
  function toggle(tab = selected) {
    if (!shell.hidden && tab === selected) close()
    else open(tab)
  }
  for (const name of Object.keys(panes)) {
    const button = document.getElementById('tab-' + name)
    button.addEventListener('click', () => open(name))
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const names = Object.keys(panes)
      let index = names.indexOf(selected)
      index = event.key === 'Home' ? 0 : event.key === 'End' ? names.length - 1 :
        (index + (event.key === 'ArrowRight' ? 1 : -1) + names.length) % names.length
      open(names[index])
      document.getElementById('tab-' + names[index]).focus()
    })
  }
  document.getElementById('btn-close-history').addEventListener('click', close)
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      close()
      document.getElementById('more-menu').open = false
    }
  })
  window.addEventListener('pointerdown', event => {
    if (!event.target.closest('#more-menu')) document.getElementById('more-menu').open = false
  })
  window.petPanels = { open, close, toggle, get selected() { return selected }, get visible() { return !shell.hidden } }
})()
