/** 查一下硅基流动账户余额（看这把 Key 还有没有额度）*/
import { execFileSync } from 'node:child_process'
const KEY = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', 'EMBEDDING_API_KEY'], {
  encoding: 'utf8', windowsHide: true,
}).match(/REG_(?:SZ|EXPAND_SZ)\s+(.+)/)[1].trim()

const res = await fetch('https://api.siliconflow.cn/v1/user/info', {
  headers: { Authorization: `Bearer ${KEY}` },
})
console.log('HTTP', res.status)
const j = await res.json()
const d = j.data || j
const keys = ['balance', 'totalBalance', 'chargeBalance', 'status', 'name']
for (const k of keys) if (d[k] !== undefined) console.log(`  ${k}: ${d[k]}`)
if (!keys.some((k) => d[k] !== undefined)) console.log(JSON.stringify(j).slice(0, 400))
