// Translate historical task diagnostics before showing them in image cards or the listing queue.
export function imageServiceMessage(message: string | null) {
  if (!message || !/gpt[\s_.-]*image|image[\s_.-]*2[.．]5|apimart/i.test(message)) return message
  return '图片生成服务未能完成任务，请重试。'
}
