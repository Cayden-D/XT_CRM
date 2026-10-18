// Re-applies the current chat-text rules to stored (masked) agent text after a rule change. Reads and writes the local
// database only; character counts and the "short" flag are kept as computed from the original text.
//   npx tsx scripts/reclassify-agent-text.ts [--dry-run]
import { db } from '../server/db.js'
import { analyzeAgentText } from '../server/integrations/chat-text.js'

const dry = process.argv.includes('--dry-run')
const rows = (await db.query<{ id: string; text_masked: string; message_types: string[]; flags: string[] }>(
  `SELECT id,text_masked,message_types,flags FROM perf_chat_messages WHERE direction=0 AND text_masked IS NOT NULL`)).rows
const changes: Record<string, number> = {}
let changed = 0
for (const row of rows) {
  const next = analyzeAgentText(row.text_masked === '[图片]' ? '' : row.text_masked, row.text_masked === '[图片]' ? ['其他消息'] : row.message_types).flags.filter(f => f !== 'short')
  const flags = [...new Set([...next, ...(row.flags.includes('short') ? ['short'] : [])])].sort()
  if (flags.join() === [...row.flags].sort().join()) continue
  changed++
  for (const f of row.flags) if (!flags.includes(f)) changes[`-${f}`] = (changes[`-${f}`] || 0) + 1
  for (const f of flags) if (!row.flags.includes(f)) changes[`+${f}`] = (changes[`+${f}`] || 0) + 1
  if (!dry) await db.query('UPDATE perf_chat_messages SET flags=$2 WHERE id=$1', [row.id, flags])
}
console.log(JSON.stringify({ scanned: rows.length, changed, changes, dryRun: dry }))
await db.end()
