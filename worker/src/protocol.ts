/**
 * NMT 字幕翻译服务 —— 新协议类型契约（架构蓝图 §2/§3/§5）
 *
 * 本文件只定义前端 ↔ Worker 之间的线上格式，不包含任何处理逻辑。
 * 处理链（extract/术语替换/merge/多级重试）在后续阶段实现时读取本文件的类型，
 * 不在此重复定义业务规则。
 */

export interface ProtocolCue {
  id: number;
  start_ms: number;
  end_ms: number;
  /** 保留内部换行；行内 <i><b><u> 原样透传，不在前端剥离 */
  text: string;
}

export interface TranslateStreamRequest {
  /** 语言码或 "auto"；一旦本次 job 内已确认具体语言，重试禁止再传 auto（见 §5） */
  source: string;
  target: string;
  glossary: Record<string, string>;
  cues: ProtocolCue[];
  /** 补译请求时携带，仅包含上次 failed_ids 对应的 cue；其余字段照常传 */
  retry_token?: string;
}

export type TranslateStreamEvent =
  | { type: "cue"; id: number; translation: string }
  | { type: "done"; success: boolean; resolved_source_lang: string; failed_ids: number[]; retry_token?: string };

export function isDoneEvent(event: TranslateStreamEvent): event is Extract<TranslateStreamEvent, { type: "done" }> {
  return event.type === "done";
}
