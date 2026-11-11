/** How a 1688 buyer is named: the name the shop gave them, else the Taobao nick (or masked login), else the id tail. */
export type BuyerNaming = { buyer_name?: string | null; name?: string | null; buyer_nick?: string | null; buyer_tail?: string | null }
export function buyerLabel(row: BuyerNaming) {
  return row.buyer_name || row.name || row.buyer_nick || (row.buyer_tail ? `买家 …${row.buyer_tail}` : '—')
}
