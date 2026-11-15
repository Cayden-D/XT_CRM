import { IntegrationError } from './1688.js'

export function adjustedCollectorPrices(percent: number) {
  const factor = BigInt(10000 + Math.round(percent * 100))
  function price(value: number | null | undefined) {
    if (value == null || percent === 0) return value ?? null
    const tooLarge = () => new IntegrationError('COLLECTOR_PRICE_RANGE', '调价后的金额超出范围，请检查采集价格或百分比。', 400)
    if (!Number.isFinite(value) || value < 0 || value >= 1e14) throw tooLarge()
    // Amounts have up to four decimal places. Convert to cents with integer arithmetic and round half up.
    const units = BigInt(value.toFixed(4).replace('.', ''))
    const cents = (units * factor + 500000n) / 1000000n
    if (cents >= 10000000000000000n || (value > 0 && cents === 0n)) throw tooLarge()
    return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`
  }
  function attributes(original: Record<string, string>, min: ReturnType<typeof price>, max: ReturnType<typeof price>) {
    if (percent === 0) return original
    const adjusted = { ...original }
    if (original['阶梯价格']) {
      adjusted['阶梯价格'] = original['阶梯价格'].split(/\s*\/\s*/).map(tier =>
        tier.replace(/^(\s*(?:[A-Z]{2,3}\s*)?[$¥￥€£]?\s*)(\d[\d,]*(?:\.\d+)?)(?=\s*\()/, (_, prefix: string, amount: string) =>
          prefix + price(Number(amount.replace(/,/g, ''))))).join(' / ')
    }
    if (original['价格区间'] && (min != null || max != null)) {
      adjusted['价格区间'] = min != null && max != null && min !== max ? `${min} ~ ${max}` : String(min ?? max)
    }
    return adjusted
  }
  return { price, attributes }
}
