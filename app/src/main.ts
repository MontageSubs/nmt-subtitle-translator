import "./style.css";
import { extract, DEFAULT_SCENE_CHANGE_SECONDS, previewChapterCount, parseSrt } from "./core/srtExtract";
import { translateUnits } from "./core/translateClient";
import { merge } from "./core/bilingualMerge";
import { SOURCE_LANGUAGES, TARGET_LANGUAGES, AUTO_DETECT_CODE, defaultOutputMode, languageProfile } from "./core/languageProfiles";
import { OutputMode } from "./core/types";
import { handshake, bufferSuccess, detectLanguage } from "./core/workerClient";
import { setUiLogSink, uiLog } from "./core/uiLog";
import { loadBundledDictionary, entriesToGlossary, DictionaryEntry } from "./core/dictionary";
import { mountGlossaryEditor } from "./components/glossaryEditor";
import { openPreviewModal, PreviewCard } from "./components/previewModal";

const SUCCESS_COMPLETION_THRESHOLD = 0.95;

const app = document.getElementById("app")!;

app.innerHTML = `
  <main class="shell">
    <header class="shell__header">
      <h1>免费在线字幕翻译器</h1>
      <p class="brand-tag">字幕翻译工具（内测中） · MontageSubs</p>
      <p class="muted">本工具在 Google 神经翻译的基础上，通过优化模型推理逻辑，提升译文的连贯性与自然度，有效缓解机翻的生硬感。结合术语表机制保障专业词汇的翻译精准度，并针对字幕场景进行专项排版调优。</p>
      <p class="muted" id="stats-line"></p>
    </header>

    <section class="step">
      <div class="step__head"><span class="step__num">1</span><span class="step__title">上传字幕文件</span></div>
      <label class="dropzone" id="dropzone">
        <div class="dropzone__icon">↑</div>
        <div class="dropzone__title">拖拽 .srt 文件到此处，或点击选择</div>
        <div class="dropzone__hint">仅支持标准 SRT 字幕文件</div>
        <div class="dropzone__file" id="dropzone-file"></div>
        <input type="file" id="srt-file" accept=".srt" />
      </label>
    </section>

    <section class="step" id="lang-step" hidden>
      <div class="step__head"><span class="step__num">2</span><span class="step__title">语言与术语表</span></div>
      <div class="field-row">
        <label class="field">
          <span>源语言</span>
          <select id="source-lang"></select>
          <span class="detect-hint" id="detect-hint"></span>
        </label>
        <label class="field">
          <span>目标语言</span>
          <select id="target-lang"></select>
        </label>
      </div>
      <label class="field" id="output-mode-field" hidden>
        <span>输出格式</span>
        <select id="output-mode">
          <option value="bilingual">双语（原文 + 译文）</option>
          <option value="monolingual">仅译文</option>
        </select>
      </label>
      <div id="glossary-editor"></div>
    </section>

    <section class="step" id="options-step" hidden>
      <div class="step__head"><span class="step__num">3</span><span class="step__title">处理选项</span></div>
      <div class="toggle-row">
        <div>
          <div class="toggle-row__label">去除聋哑人辅助字幕（SDH）</div>
          <div class="toggle-row__desc">移除方括号内的音效/说话人描述，如 [笑声]、[BOB]：</div>
        </div>
        <label class="switch"><input type="checkbox" id="sdh-toggle" checked /><span class="switch__track"></span></label>
      </div>
      <div class="field slider-field">
        <div class="slider-field__row">
          <span>场景切分间隔</span>
          <span class="slider-field__value" id="scene-seconds-value">${DEFAULT_SCENE_CHANGE_SECONDS} 秒</span>
        </div>
        <input type="range" id="scene-seconds" min="5" max="120" step="5" value="${DEFAULT_SCENE_CHANGE_SECONDS}" />
        <div class="slider-field__hint" id="scene-preview-hint">间隔越短，场景切分越细，上下文一致性可能下降；间隔越长，单次翻译请求越大。</div>
      </div>
    </section>

    <section class="step" id="start-step" hidden>
      <button id="start" class="primary">开始翻译</button>
    </section>

    <section class="step" id="progress-card" hidden>
      <div class="progress-row">
        <span id="progress-label">准备中…</span>
        <span id="progress-count"></span>
      </div>
      <progress id="progress-bar" max="100" value="0"></progress>
      <pre class="log" id="log"></pre>
    </section>

    <section class="step" id="result-card" hidden>
      <p id="result-summary"></p>
      <div class="result-actions">
        <button id="preview-button" class="secondary">下载前预览</button>
        <a id="download-link" class="primary" download>下载字幕</a>
      </div>
    </section>
  </main>

  <div class="captcha-backdrop" id="captcha-backdrop" hidden>
    <div class="captcha-backdrop__text">需要完成一次人机验证才能继续翻译</div>
    <div class="captcha-backdrop__widget" id="captcha-widget"></div>
  </div>
`;

function fillSelect(select: HTMLSelectElement, langs: { code: string; label: string }[], selected: string, includeAuto = false) {
  const autoOption = includeAuto ? `<option value="${AUTO_DETECT_CODE}">自动检测</option>` : "";
  select.innerHTML = autoOption + langs.map((l) => `<option value="${l.code}">${l.label} (${l.code})</option>`).join("");
  select.value = selected;
}

const dropzone = document.getElementById("dropzone") as HTMLElement;
const dropzoneFile = document.getElementById("dropzone-file") as HTMLElement;
const srtInput = document.getElementById("srt-file") as HTMLInputElement;
const langStep = document.getElementById("lang-step") as HTMLElement;
const optionsStep = document.getElementById("options-step") as HTMLElement;
const startStep = document.getElementById("start-step") as HTMLElement;
const sourceSelect = document.getElementById("source-lang") as HTMLSelectElement;
const targetSelect = document.getElementById("target-lang") as HTMLSelectElement;
const detectHint = document.getElementById("detect-hint") as HTMLElement;
const outputModeField = document.getElementById("output-mode-field") as HTMLElement;
const outputModeSelect = document.getElementById("output-mode") as HTMLSelectElement;
const sdhToggle = document.getElementById("sdh-toggle") as HTMLInputElement;
const sceneSecondsInput = document.getElementById("scene-seconds") as HTMLInputElement;
const sceneSecondsValue = document.getElementById("scene-seconds-value") as HTMLElement;
const scenePreviewHint = document.getElementById("scene-preview-hint") as HTMLElement;
const startButton = document.getElementById("start") as HTMLButtonElement;
const progressCard = document.getElementById("progress-card") as HTMLElement;
const progressLabel = document.getElementById("progress-label") as HTMLElement;
const progressCount = document.getElementById("progress-count") as HTMLElement;
const progressBar = document.getElementById("progress-bar") as HTMLProgressElement;
const logEl = document.getElementById("log") as HTMLElement;
const resultCard = document.getElementById("result-card") as HTMLElement;
const resultSummary = document.getElementById("result-summary") as HTMLElement;
const downloadLink = document.getElementById("download-link") as HTMLAnchorElement;
const previewButton = document.getElementById("preview-button") as HTMLButtonElement;
const statsLine = document.getElementById("stats-line") as HTMLElement;
const glossaryEditorContainer = document.getElementById("glossary-editor") as HTMLElement;

fillSelect(sourceSelect, SOURCE_LANGUAGES, AUTO_DETECT_CODE, true);
fillSelect(targetSelect, TARGET_LANGUAGES, "zh");

let srtFile: File | null = null;
let srtContent = "";
let userPickedOutputMode = false;
let lastMergeResult: Awaited<ReturnType<typeof merge>> | null = null;
let lastCues: ReturnType<typeof extract>["cues"] = [];

const glossaryHandle = mountGlossaryEditor(glossaryEditorContainer, []);

async function loadDictionaryFor(languageCode: string) {
  if (languageCode === AUTO_DETECT_CODE) return;
  const entries = await loadBundledDictionary(languageCode);
  glossaryHandle.setEntries(entries);
}

function updateOutputModeVisibility() {
  const isZhTarget = targetSelect.value === "zh";
  outputModeField.hidden = !isZhTarget;
  if (isZhTarget && !userPickedOutputMode) {
    outputModeSelect.value = defaultOutputMode(sourceSelect.value === AUTO_DETECT_CODE ? "en" : sourceSelect.value, targetSelect.value);
  }
}

outputModeSelect.addEventListener("change", () => { userPickedOutputMode = true; });
targetSelect.addEventListener("change", updateOutputModeVisibility);
sourceSelect.addEventListener("change", () => {
  updateOutputModeVisibility();
  if (sourceSelect.value !== AUTO_DETECT_CODE) loadDictionaryFor(sourceSelect.value);
});

function updateScenePreview() {
  const seconds = Number(sceneSecondsInput.value);
  sceneSecondsValue.textContent = `${seconds} 秒`;
  if (!lastCues.length) return;
  const count = previewChapterCount(lastCues, seconds * 1000);
  scenePreviewHint.textContent = `当前设置将切分为约 ${count} 个场景。间隔越短切分越细、上下文一致性可能下降；间隔越长单次翻译请求越大。`;
}
sceneSecondsInput.addEventListener("input", updateScenePreview);

function appendLog(message: string) {
  logEl.textContent += `${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}
setUiLogSink(appendLog);

async function handleFile(file: File) {
  srtFile = file;
  srtContent = await file.text();
  dropzoneFile.textContent = `已选择：${file.name}`;
  langStep.hidden = false;
  optionsStep.hidden = false;
  startStep.hidden = false;

  const { cues } = parseSrt(srtContent, false, false, false);
  lastCues = cues;
  updateScenePreview();

  if (sourceSelect.value === AUTO_DETECT_CODE) {
    detectHint.textContent = "识别中…";
    detectHint.classList.remove("detect-hint--done");
    const sample = cues.slice(0, 20).map((c) => c.text).join(" ");
    const detected = await detectLanguage(sample);
    if (detected) {
      const known = SOURCE_LANGUAGES.some((l) => l.code === detected.split("-")[0]);
      detectHint.textContent = known
        ? `已识别为 ${languageProfile(detected).label}（${detected}），可手动更改`
        : `识别结果 ${detected} 暂无专属规则，按通用规则处理`;
      detectHint.classList.add("detect-hint--done");
      if (known) {
        sourceSelect.value = detected.split("-")[0];
        loadDictionaryFor(sourceSelect.value);
      }
    } else {
      detectHint.textContent = "自动识别暂不可用，请手动选择源语言";
    }
    updateOutputModeVisibility();
  }
}

dropzone.addEventListener("click", (e) => { if ((e.target as HTMLElement).tagName !== "INPUT") srtInput.click(); });
srtInput.addEventListener("change", () => { if (srtInput.files?.[0]) handleFile(srtInput.files[0]); });
["dragover", "dragenter"].forEach((evt) => dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add("dropzone--active"); }));
["dragleave", "drop"].forEach((evt) => dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove("dropzone--active"); }));
dropzone.addEventListener("drop", (e) => {
  const file = (e as DragEvent).dataTransfer?.files?.[0];
  if (file) handleFile(file);
});

handshake()
  .then(({ total, last24h }) => { statsLine.textContent = `累计翻译 ${total} 条字幕 · 近 24 小时 ${last24h} 条`; })
  .catch(() => { statsLine.textContent = ""; });

startButton.addEventListener("click", async () => {
  if (!srtFile) return;

  startButton.disabled = true;
  progressCard.hidden = false;
  resultCard.hidden = true;
  logEl.textContent = "";
  progressBar.value = 0;

  try {
    const sourceLang = sourceSelect.value === AUTO_DETECT_CODE ? "en" : sourceSelect.value;
    const targetLang = targetSelect.value;
    const outputMode = outputModeSelect.value as OutputMode;
    const sceneChangeSeconds = Number(sceneSecondsInput.value);
    const stripSdhEnabled = sdhToggle.checked;

    progressLabel.textContent = "解析字幕…";
    const glossary = entriesToGlossary(glossaryHandle.getEntries() as DictionaryEntry[]);

    const extracted = extract(srtContent, glossary, { sourceLang, stripSdhEnabled, sceneChangeSeconds });
    if (!extracted.success) {
      throw new Error("未能从文件中解析出任何字幕块，请确认文件是标准 SRT 格式。");
    }
    uiLog(`[extract] 解析完成：${extracted.cues.length} 条字幕，合并为 ${extracted.units.length} 个翻译单元，${extracted.chapters.length} 个场景。`);

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
    lastMergeResult = result;

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

previewButton.addEventListener("click", () => {
  if (!lastMergeResult) return;
  const cards: PreviewCard[] = lastMergeResult.cues.map((c) => ({
    id: c.id, start: c.start, end: c.end, source: c.text, target: c.translation || "（缺失）",
  }));
  openPreviewModal(lastMergeResult.srt, cards);
});
