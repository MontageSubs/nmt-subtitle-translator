import "./style.css";
import { extract, buildGlossaryFromMarkdown, Glossary } from "./core/srtExtract";
import { translateUnits } from "./core/translateClient";
import { merge } from "./core/bilingualMerge";
import { SOURCE_LANGUAGES, TARGET_LANGUAGES, isChineseTarget } from "./core/languageProfiles";
import { OutputMode } from "./core/types";
import { handshake, bufferSuccess } from "./core/workerClient";
import { setUiLogSink } from "./core/uiLog";

const SUCCESS_COMPLETION_THRESHOLD = 0.95;

const app = document.getElementById("app")!;

app.innerHTML = `
  <main class="shell">
    <header class="shell__header">
      <h1>免费在线字幕翻译器</h1>
      <p class="brand-tag">字幕翻译工具（内测中） · MontageSubs</p>
      <p class="muted">本工具在 Google 神经翻译的基础上，通过优化模型推理逻辑，提升译文的连贯性与自然度，有效缓解机翻的生硬感。结合术语表机制保障专业词汇的翻译精准度，并针对字幕场景进行专项排版调优，确保标点规范且不丢行、不错位，旨在提供一个稳定、可控的字幕翻译方案。</p>
      <p class="muted" id="stats-line"></p>
    </header>

    <section class="card">
      <label class="field">
        <span>字幕文件（.srt）</span>
        <input type="file" id="srt-file" accept=".srt" />
      </label>
      <label class="field">
        <span>术语表（可选，.md，含"人物与专有名词"表格）</span>
        <input type="file" id="glossary-file" accept=".md" />
      </label>
      <div class="field-row">
        <label class="field">
          <span>源语言</span>
          <select id="source-lang"></select>
        </label>
        <label class="field">
          <span>目标语言</span>
          <select id="target-lang"></select>
        </label>
      </div>
      <label class="field" id="output-mode-field" hidden>
        <span>中文输出格式</span>
        <select id="output-mode">
          <option value="bilingual">双语（原文 + 译文）</option>
          <option value="monolingual">仅译文</option>
        </select>
      </label>
      <button id="start" class="primary" disabled>开始翻译</button>
    </section>

    <section class="card" id="progress-card" hidden>
      <div class="progress-row">
        <span id="progress-label">准备中…</span>
        <span id="progress-count"></span>
      </div>
      <progress id="progress-bar" max="100" value="0"></progress>
      <pre id="log" class="log"></pre>
    </section>

    <section class="card" id="result-card" hidden>
      <p id="result-summary"></p>
      <a id="download-link" class="primary" download>下载字幕</a>
    </section>

    <div id="turnstile-container" hidden></div>
  </main>
`;

function fillSelect(select: HTMLSelectElement, langs: { code: string; label: string }[], selected: string) {
  select.innerHTML = langs.map((l) => `<option value="${l.code}">${l.label} (${l.code})</option>`).join("");
  select.value = selected;
}

const sourceSelect = document.getElementById("source-lang") as HTMLSelectElement;
const targetSelect = document.getElementById("target-lang") as HTMLSelectElement;
const outputModeField = document.getElementById("output-mode-field") as HTMLElement;
const outputModeSelect = document.getElementById("output-mode") as HTMLSelectElement;
const srtInput = document.getElementById("srt-file") as HTMLInputElement;
const glossaryInput = document.getElementById("glossary-file") as HTMLInputElement;
const startButton = document.getElementById("start") as HTMLButtonElement;
const progressCard = document.getElementById("progress-card") as HTMLElement;
const progressLabel = document.getElementById("progress-label") as HTMLElement;
const progressCount = document.getElementById("progress-count") as HTMLElement;
const progressBar = document.getElementById("progress-bar") as HTMLProgressElement;
const logEl = document.getElementById("log") as HTMLElement;
const resultCard = document.getElementById("result-card") as HTMLElement;
const resultSummary = document.getElementById("result-summary") as HTMLElement;
const downloadLink = document.getElementById("download-link") as HTMLAnchorElement;
const statsLine = document.getElementById("stats-line") as HTMLElement;

fillSelect(sourceSelect, SOURCE_LANGUAGES, "en");
fillSelect(targetSelect, TARGET_LANGUAGES, "zh");

function updateOutputModeVisibility() {
  outputModeField.hidden = !isChineseTarget(targetSelect.value);
}
targetSelect.addEventListener("change", updateOutputModeVisibility);
updateOutputModeVisibility();

function updateStartEnabled() {
  startButton.disabled = !srtInput.files?.length;
}
srtInput.addEventListener("change", updateStartEnabled);

function appendLog(message: string) {
  logEl.textContent += `${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

setUiLogSink(appendLog);

async function readFile(file: File): Promise<string> {
  return file.text();
}

handshake()
  .then(({ total, last24h }) => {
    statsLine.textContent = `累计翻译 ${total} 条字幕 · 近 24 小时 ${last24h} 条`;
  })
  .catch(() => {
    statsLine.textContent = "";
  });

startButton.addEventListener("click", async () => {
  const srtFile = srtInput.files?.[0];
  if (!srtFile) return;

  startButton.disabled = true;
  progressCard.hidden = false;
  resultCard.hidden = true;
  logEl.textContent = "";
  progressBar.value = 0;

  try {
    const sourceLang = sourceSelect.value;
    const targetLang = targetSelect.value;
    const outputMode = outputModeSelect.value as OutputMode;

    progressLabel.textContent = "解析字幕…";
    const srtContent = await readFile(srtFile);
    let glossary: Glossary = {};
    const glossaryFile = glossaryInput.files?.[0];
    if (glossaryFile) glossary = buildGlossaryFromMarkdown(await readFile(glossaryFile));

    const extracted = extract(srtContent, glossary, { sourceLang });
    if (!extracted.success) {
      throw new Error("未能从文件中解析出任何字幕块，请确认文件是标准 SRT 格式。");
    }
    appendLog(`解析完成：${extracted.cues.length} 条字幕，合并为 ${extracted.units.length} 个翻译单元，${extracted.chapters.length} 个场景。`);

    progressLabel.textContent = "翻译中…";
    const { translations, skipped } = await translateUnits(
      extracted.units, extracted.chapters, extracted.cues, sourceLang, targetLang,
      {
        onProgress: (event) => {
          const percent = event.total ? Math.round((event.completed / event.total) * 100) : 0;
          progressBar.value = percent;
          progressCount.textContent = `${event.completed}/${event.total} 批`;
        },
      }
    );

    progressLabel.textContent = "合并生成字幕…";
    const result = await merge(extracted.cues, extracted.units, translations, sourceLang, targetLang, outputMode);

    const blob = new Blob([result.srt], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    downloadLink.href = url;
    downloadLink.download = srtFile.name.replace(/\.srt$/i, `.${targetLang}.srt`);

    resultSummary.textContent = `完成：共 ${extracted.cues.length} 条字幕，缺失翻译 ${result.missing_count} 条，近似拆分 ${result.approx_splits.length} 处，跳过 ${skipped.length} 个单元（详情见上方日志）。`;
    resultCard.hidden = false;
    progressLabel.textContent = "完成";

    const completionRatio = extracted.cues.length ? (extracted.cues.length - result.missing_count) / extracted.cues.length : 0;
    if (completionRatio >= SUCCESS_COMPLETION_THRESHOLD) {
      downloadLink.addEventListener("click", () => bufferSuccess(), { once: true });
    }
  } catch (e) {
    appendLog(`错误：${e instanceof Error ? e.message : String(e)}`);
    progressLabel.textContent = "失败";
  } finally {
    startButton.disabled = false;
  }
});
