import { config } from '../config.js'

export const QWEN_MODELS=['qwen3.8-flash','qwen3.7-flash','qwen3.7-plus','qwen3.6-plus'] as const
export type QwenModel=typeof QWEN_MODELS[number]
export type LlmToolCall={id:string;type:'function';function:{name:string;arguments:string}}
export type LlmTool={type:'function';function:{name:string;description:string;parameters:Record<string,unknown>}}
export type LlmMessage={role:'system'|'user'|'assistant';content:string|Array<{type:'text';text:string}|{type:'image_url';image_url:{url:string}}>}
  |{role:'assistant';content:string|null;tool_calls:LlmToolCall[]}|{role:'tool';tool_call_id:string;content:string}
export type LlmResult={content:string;model:string;inputTokens:number|null;outputTokens:number|null;finishReason:string|null}
export type LlmChatResult=Omit<LlmResult,'content'>&{content:string|null;toolCalls:LlmToolCall[]}

export class LlmConfigurationError extends Error{}
export class LlmRequestError extends Error{constructor(message:string,public status:number,public details?:unknown){super(message)}}

export function isQwenModel(value:string):value is QwenModel{return QWEN_MODELS.includes(value as QwenModel)}

export async function generateQwenText(input:{messages:LlmMessage[];model?:QwenModel;temperature?:number;maxTokens?:number;json?:boolean}):Promise<LlmResult>{
  const result=await chatQwen(input)
  if(!result.content)throw new LlmRequestError('千问接口没有返回可用内容。',502)
  return{...result,content:result.content}
}

/** One chat completion; with `tools` the model may answer with tool calls instead of text. */
export async function chatQwen(input:{messages:LlmMessage[];model?:QwenModel;temperature?:number;maxTokens?:number;json?:boolean;tools?:LlmTool[];timeoutMs?:number}):Promise<LlmChatResult>{
  if(!config.DASHSCOPE_API_KEY)throw new LlmConfigurationError('尚未配置 DASHSCOPE_API_KEY。')
  const model=input.model??config.QWEN_DEFAULT_MODEL
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),input.timeoutMs??config.QWEN_TIMEOUT_MS)
  try{
    const response=await fetch(`${config.DASHSCOPE_BASE_URL.replace(/\/$/,'')}/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${config.DASHSCOPE_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model,messages:input.messages,temperature:input.temperature??0.4,max_tokens:input.maxTokens??2000,...(input.json?{response_format:{type:'json_object'},enable_thinking:false}:{}),...(input.tools?.length?{tools:input.tools,tool_choice:'auto',parallel_tool_calls:true}:{})}),signal:controller.signal})
    const body=await response.json().catch(()=>({})) as {message?:string;error?:{message?:string;code?:string};choices?:Array<{message?:{content?:string|null;tool_calls?:LlmToolCall[]};finish_reason?:string}>;model?:string;usage?:{prompt_tokens?:number;completion_tokens?:number}}
    if(!response.ok)throw new LlmRequestError(body.error?.message||body.message||`千问接口返回 HTTP ${response.status}`,response.status,body.error)
    const content=body.choices?.[0]?.message?.content?.trim()||null,toolCalls=body.choices?.[0]?.message?.tool_calls??[]
    if(!content&&!toolCalls.length)throw new LlmRequestError('千问接口没有返回可用内容。',502,body)
    return{content,toolCalls,model:body.model||model,inputTokens:body.usage?.prompt_tokens??null,outputTokens:body.usage?.completion_tokens??null,finishReason:body.choices?.[0]?.finish_reason??null}
  }catch(error){if(error instanceof LlmRequestError||error instanceof LlmConfigurationError)throw error;if(error instanceof Error&&error.name==='AbortError')throw new LlmRequestError('千问响应超时，请稍后重试。',504);throw new LlmRequestError(error instanceof Error?error.message:'无法连接千问服务。',502)}finally{clearTimeout(timeout)}
}

/**
 * The same completion as chatQwen, streamed: `onText` receives the answer as it is generated. Tool calls arrive in
 * fragments (keyed by index) and are reassembled; the resolved result has the same shape as chatQwen's. Thinking is
 * off as in non-streamed calls: streamed Qwen3 models otherwise reason first (~6 s live) before writing the answer.
 */
export async function streamQwen(input:{messages:LlmMessage[];model?:QwenModel;temperature?:number;maxTokens?:number;tools?:LlmTool[];timeoutMs?:number;onText:(text:string)=>void}):Promise<LlmChatResult>{
  if(!config.DASHSCOPE_API_KEY)throw new LlmConfigurationError('尚未配置 DASHSCOPE_API_KEY。')
  const model=input.model??config.QWEN_DEFAULT_MODEL
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),input.timeoutMs??config.QWEN_TIMEOUT_MS)
  try{
    const response=await fetch(`${config.DASHSCOPE_BASE_URL.replace(/\/$/,'')}/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${config.DASHSCOPE_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model,messages:input.messages,temperature:input.temperature??0.4,max_tokens:input.maxTokens??2000,stream:true,stream_options:{include_usage:true},enable_thinking:false,...(input.tools?.length?{tools:input.tools,tool_choice:'auto',parallel_tool_calls:true}:{})}),signal:controller.signal})
    if(!response.ok||!response.body){const body=await response.json().catch(()=>({})) as {message?:string;error?:{message?:string}};throw new LlmRequestError(body.error?.message||body.message||`千问接口返回 HTTP ${response.status}`,response.status,body.error)}
    type Chunk={model?:string;error?:{message?:string};usage?:{prompt_tokens?:number;completion_tokens?:number}|null;choices?:Array<{delta?:{content?:string|null;tool_calls?:Array<{index?:number;id?:string;function?:{name?:string;arguments?:string}}>};finish_reason?:string|null}>}
    let content='',buffer='',finishReason=null as string|null,answeredModel:string=model
    const usage={input:null as number|null,output:null as number|null}
    const calls:LlmToolCall[]=[]
    const handle=(line:string)=>{
      if(!line.startsWith('data:'))return
      const data=line.slice(5).trim();if(!data||data==='[DONE]')return
      const chunk=JSON.parse(data) as Chunk
      if(chunk.error)throw new LlmRequestError(chunk.error.message||'千问接口返回错误。',502,chunk.error)
      if(chunk.model)answeredModel=chunk.model
      if(chunk.usage){usage.input=chunk.usage.prompt_tokens??null;usage.output=chunk.usage.completion_tokens??null}
      for(const choice of chunk.choices??[]){
        if(choice.finish_reason)finishReason=choice.finish_reason
        const text=choice.delta?.content;if(text){content+=text;input.onText(text)}
        for(const part of choice.delta?.tool_calls??[]){
          const call=calls[part.index??0]??=({id:'',type:'function',function:{name:'',arguments:''}})
          if(part.id)call.id=part.id
          if(part.function?.name)call.function.name+=part.function.name
          if(part.function?.arguments)call.function.arguments+=part.function.arguments
        }
      }
    }
    const decoder=new TextDecoder()
    for await(const bytes of response.body as unknown as AsyncIterable<Uint8Array>){
      buffer+=decoder.decode(bytes,{stream:true})
      let end;while((end=buffer.indexOf('\n'))>=0){handle(buffer.slice(0,end).trim());buffer=buffer.slice(end+1)}
    }
    handle(buffer.trim())
    const toolCalls=calls.filter(c=>c?.function.name)
    if(!content.trim()&&!toolCalls.length)throw new LlmRequestError('千问接口没有返回可用内容。',502)
    return{content:content.trim()||null,toolCalls,model:answeredModel,inputTokens:usage.input,outputTokens:usage.output,finishReason}
  }catch(error){if(error instanceof LlmRequestError||error instanceof LlmConfigurationError)throw error;if(error instanceof Error&&error.name==='AbortError')throw new LlmRequestError('千问响应超时，请稍后重试。',504);throw new LlmRequestError(error instanceof Error?error.message:'无法连接千问服务。',502)}finally{clearTimeout(timeout)}
}
