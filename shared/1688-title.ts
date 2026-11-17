// 1688 title units: ASCII counts as one, non-ASCII as two (not UTF-8 bytes).
const titleCharUnits = (char:string) => char.codePointAt(0)!>127?2:1

export function titleLength(title:string){
  return Array.from(title).reduce((length,char)=>length+titleCharUnits(char),0)
}
export function titleLimit(schema:Record<string,any>):number{
  const limit=schema.data?.title?.fields?.maxLength
  return typeof limit==='number'&&Number.isInteger(limit)&&limit>0?Math.min(limit,60):60
}

/** Keeps the leading product terms and clips only at a Unicode character boundary. */
export function truncateTitle(title:string, limit:number):string {
  let output='', remaining=limit
  for(const char of title){
    remaining-=titleCharUnits(char)
    if(remaining<0){
      // Avoid turning a partially clipped model number or measurement into a different one.
      const partial=/[A-Za-z0-9][A-Za-z0-9.%+/-]*$/.exec(output)
      if(/[A-Za-z0-9.%+/-]/.test(char)&&partial&&partial.index>0)output=output.slice(0,partial.index)
      break
    }
    output+=char
  }
  return output.replace(/[\s,，、;；/／|｜·:：-]+$/u,'')
}
