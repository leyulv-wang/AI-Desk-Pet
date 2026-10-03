/**
 * 调试用：戳一下之后，手臂相关参数随时间怎么变。
 * 跑法：electron . --js-file=scripts/debug-tap-trace.js --js-delay=3000
 *
 * 要回答的问题：挥手之后手放不下来，到底是
 *   ① 动作没停（Param14/16/17 还停在挥手姿态）
 *   ② 表情钉住了（Param15 = 1，手出现的开关没归零）
 *   ③ 参数本来就该停在那个值（那就是模型设计如此，不是 bug）
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const IDS = ['Param14', 'Param15', 'Param16', 'Param17', 'ParamAngleZ', 'ParamBodyAngleZ']
const PM = window.petModel

const rows = []
const snap = (label) => {
  const o = { 时刻: label }
  for (const id of IDS) {
    const v = PM.getParam(id)
    o[id] = v === null ? '—' : Number(v.toFixed(3))
  }
  rows.push(o)
}

// 先确认这些参数在模型里到底存不存在 —— 不存在的话读数永远是 null，别误判
const all = PM.paramIds()
const has = { 时刻: '参数存在?' }
for (const id of IDS) has[id] = all ? (all.includes(id) ? '有' : '无') : '未知'
rows.push(has)

snap('未戳')

PM.tap()
const marks = [300, 900, 1600, 2200, 3000, 4500]
let prev = 0
for (const ms of marks) {
  await sleep(ms - prev)
  prev = ms
  snap(`戳后 ${(ms / 1000).toFixed(1)}s`)
}

return rows
