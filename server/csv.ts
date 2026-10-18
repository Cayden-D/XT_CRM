import type { FastifyReply } from 'fastify'

export const csvCell = (value: unknown) => {
  let text = value == null ? '' : String(value)
  // Neutralise spreadsheet formulas (but keep plain negative numbers numeric).
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`
  return /[",\r\n']/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}
export function sendCsv(reply: FastifyReply, name: string, rows: unknown[][]) {
  // BOM so Excel opens UTF-8 Chinese correctly; cells starting with formula characters are neutralised.
  return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
    .send('﻿' + rows.map(row => row.map(csvCell).join(',')).join('\r\n'))
}
