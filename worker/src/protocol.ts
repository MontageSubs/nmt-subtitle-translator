/**
 * NMT 字幕翻译服务 —— 前端 ↔ Worker 线上格式契约（架构蓝图 §2/§3/§5）
 *
 * Worker 不理解任何字幕文件语法，只消费结构化 cue；本文件是唯一的协议真源，
 * handler/pipeline 均从此处取类型，不得各自定义平行的请求体形状。
 */

export interface ProtocolCue {
  id: number;
  start_ms: number;
  end_ms: number;
  text: string;
}

export interface TranslateStreamRequest {
  source: string;
  target: string;
  glossary: Record<string, string>;
  cues: ProtocolCue[];
  sceneChangeSeconds?: number;
}

export type TranslateStreamEvent =
  | { type: "cue"; id: number; translation: string | null }
  | { type: "done"; success: boolean; resolved_source_lang: string; failed_ids: number[] };

export function isDoneEvent(event: TranslateStreamEvent): event is Extract<TranslateStreamEvent, { type: "done" }> {
  return event.type === "done";
}

const CUE_TEXT_SEPARATOR = "\u0000";

export function canonicalizeCues(cues: { text: string }[]): string {
  return cues.map((cue) => cue.text).join(CUE_TEXT_SEPARATOR);
}

export function isValidProtocolCue(value: unknown): value is ProtocolCue {
  if (!value || typeof value !== "object") return false;
  const cue = value as Record<string, unknown>;
  return (
    typeof cue.id === "number" &&
    typeof cue.start_ms === "number" &&
    typeof cue.end_ms === "number" &&
    typeof cue.text === "string"
  );
}
