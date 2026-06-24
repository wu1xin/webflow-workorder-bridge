// 一次性数据清除脚本：清空业务表内容，保留表结构、库文件与 meta.schemaVersion。
// 加 --with-config 时一并把 config.json 重置为「未配置」态（key 文件保留）。
// 路径逻辑与 src/config/paths.ts 的 appDataDir() 同源；跑前务必先停 server（VACUUM 需独占锁）。
import Database from 'better-sqlite3'
import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// 与 src/config/paths.ts appDataDir() 一致：Windows 取 LOCALAPPDATA，其余回退 ~/.local/share
const appDataDir = join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'), 'weflow-bridge')
const dbPath = join(appDataDir, 'bridge.db')

// 业务表全清；meta（仅 schemaVersion）保留——清掉会让下次启动误判版本并触发 DROP 重建。
const TABLES = ['queue', 'dedup', 'channel_state', 'audit', 'media_cache']

const db = new Database(dbPath)
const before = {}
for (const t of TABLES) before[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c

db.transaction(() => {
    for (const t of TABLES) db.exec(`DELETE FROM ${t}`)
    db.exec('DELETE FROM sqlite_sequence') // 重置 queue/audit 自增 id 从 1 起
})()
db.exec('VACUUM') // 回收磁盘空间，库文件缩回几十 KB

const ver = db.prepare('SELECT value FROM meta WHERE key = ?').get('schemaVersion')
db.close()

console.log('已清空业务表（清空前行数）:', before)
console.log('保留 meta.schemaVersion =', ver?.value)

if (process.argv.includes('--with-config')) {
    writeFileSync(join(appDataDir, 'config.json'), '{}\n')
    console.log('已重置 config.json → 未配置态（key 文件保留）')
}

console.log('done')
