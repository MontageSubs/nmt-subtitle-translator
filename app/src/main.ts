import "./style.css";
import { DEFAULT_SCENE_CHANGE_SECONDS, previewChapterCount, parseSrt } from "./core/srtParse";
import { renderSrt, msToSrtTime } from "./core/srtRender";
import { SOURCE_LANGUAGES, TARGET_LANGUAGES, AUTO_DETECT_CODE, defaultOutputMode, languageProfile } from "./core/languageProfiles";
import { Cue, OutputMode } from "./core/types";
import { handshake, postTranslateJob, TranslateJobResponse } from "./core/workerClient";
import { applySdhStripping } from "./core/sdh";
import { detectSourceLanguage, isKnownSourceLanguage } from "./core/detect";
import { loadBundledDictionary, entriesToGlossary, DictionaryEntry } from "./core/dictionary";
import { mountGlossaryEditor } from "./components/glossaryEditor";
import { openPreviewModal, PreviewCard } from "./components/previewModal";
import { t, getLocale, setLocale, onLocaleChange, LocaleCode } from "./i18n";

const SCENE_SECONDS_MIN = 1;
const SCENE_SECONDS_MAX = 99999;
const SCENE_SLIDER_MIN = 5;
const SCENE_SLIDER_MAX = 120;

const app = document.getElementById("app")!;

// 跨语言切换保留的用户状态：main.ts 采用一次性 innerHTML 渲染的既有架构，
// 切换 locale 时整体重渲染最简单可靠，但不能丢用户已经做的选择，所以状态提到渲染函数之外。
interface AppState {
  srtFile: File | null;
  lastCues: Cue[];
  lastJobResult: TranslateJobResponse | null;
  lastRenderMode: OutputMode;
  sourceLang: string;
  targetLang: string;
  outputMode: OutputMode;
  userPickedOutputMode: boolean;
  sdhEnabled: boolean;
  sceneSeconds: number;
  glossaryEntries: DictionaryEntry[];
}

const state: AppState = {
  srtFile: null,
  lastCues: [],
  lastJobResult: null,
  lastRenderMode: "monolingual",
  sourceLang: AUTO_DETECT_CODE,
  targetLang: "zh",
  outputMode: "monolingual",
  userPickedOutputMode: false,
  sdhEnabled: true,
  sceneSeconds: DEFAULT_SCENE_CHANGE_SECONDS,
  glossaryEntries: [],
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function renderApp() {
  app.innerHTML = `
    <main class="shell">
      <header class="shell__header">
        <div class="locale-switch">
          <button type="button" class="secondary" data-locale="zh">中文</button>
          <button type="button" class="secondary" data-locale="en">EN</button>
        </div>
        <h1>${t("app.title")}</h1>
        <p class="brand-tag">${t("app.tagline")}</p>
        <p class="muted">${t("app.description")}</p>
        <p class="muted" id="stats-line"></p>
      </header>

      <section class="step">
        <div class="step__head"><span class="step__num">1</span><span class="step__title">${t("step.upload.title")}</span></div>
        <label class="dropzone" id="dropzone">
          <div class="dropzone__icon">↑</div>
          <div class="dropzone__title">${t("dropzone.title")}</div>
          <div class="dropzone__hint">${t("dropzone.hint")}</div>
          <div class="dropzone__file" id="dropzone-file"></div>
          <input type="file" id="srt-file" accept=".srt" />
        </label>
      </section>

      <section class="step" id="lang-step" ${state.srtFile ? "" : "hidden"}>
        <div class="step__head"><span class="step__num">2</span><span class="step__title">${t("step.lang.title")}</span></div>
        <div class="field-row">
          <label class="field">
            <span>${t("field.sourceLang")}</span>
            <select id="source-lang"></select>
            <span class="detect-hint" id="detect-hint"></span>
          </label>
          <label class="field">
            <span>${t("field.targetLang")}</span>
            <select id="target-lang"></select>
          </label>
        </div>
        <label class="field" id="output-mode-field" ${state.targetLang === "zh" ? "" : "hidden"}>
          <span>${t("field.outputMode")}</span>
          <select id="output-mode">
            <option value="bilingual">${t("outputMode.bilingual")}</option>
            <option value="monolingual">${t("outputMode.monolingual")}</option>
          </select>
        </label>
        <div id="glossary-editor"></div>
      </section>

      <section class="step" id="options-step" ${state.srtFile ? "" : "hidden"}>
        <div class="step__head"><span class="step__num">3</span><span class="step__title">${t("step.options.title")}</span></div>
        <div class="toggle-row">
          <div>
            <div class="toggle-row__label">${t("sdh.label")}</div>
            <div class="toggle-row__desc">${t("sdh.desc")}</div>
          </div>
          <label class="switch"><input type="checkbox" id="sdh-toggle" ${state.sdhEnabled ? "checked" : ""} /><span class="switch__track"></span></label>
        </div>
        <div class="field slider-field">
          <div class="slider-field__row">
            <span>${t("scene.label")}</span>
            <input type="number" id="scene-seconds-number" class="slider-field__number" min="${SCENE_SECONDS_MIN}" max="${SCENE_SECONDS_MAX}" value="${state.sceneSeconds}" />
          </div>
          <input type="range" id="scene-seconds" min="${SCENE_SLIDER_MIN}" max="${SCENE_SLIDER_MAX}" step="1" value="${clamp(state.sceneSeconds, SCENE_SLIDER_MIN, SCENE_SLIDER_MAX)}" />
          <div class="slider-field__hint" id="scene-preview-hint">${t("scene.hint")}</div>
        </div>
      </section>

      <section class="step" id="start-step" ${state.srtFile ? "" : "hidden"}>
        <button id="start" class="primary">${t("start.button")}</button>
      </section>

      <section class="step" id="progress-card" hidden>
        <div class="progress-row">
          <span id="progress-label">${t("progress.preparing")}</span>
          <span id="progress-count"></span>
        </div>
        <progress id="progress-bar" max="100" value="0"></progress>
        <pre class="log" id="log"></pre>
      </section>

      <section class="step" id="result-card" hidden>
        <p id="result-summary"></p>
        <div class="result-actions">
          <button id="preview-button" class="secondary">${t("preview.button")}</button>
          <a id="download-link" class="primary" download>${t("download.button")}</a>
        </div>
      </section>
    </main>

    <div class="captcha-backdrop" id="captcha-backdrop" hidden>
      <div class="captcha-backdrop__text">${t("captcha.text")}</div>
      <div class="captcha-backdrop__widget" id="captcha-widget"></div>
    </div>
  `;

  wireApp();
}

function fillSelect(select: HTMLSelectElement, langs: { code: string; label: string }[], selected: string, includeAuto = false) {
  const autoOption = includeAuto ? `<option value="${AUTO_DETECT_CODE}">${t("lang.autoDetect")}</option>` : "";
  select.innerHTML = autoOption + langs.map((l) => `<option value="${l.code}">${l.label} (${l.code})</option>`).join("");
  select.value = selected;
}

function wireApp() {
  const localeButtons = app.querySelectorAll<HTMLButtonElement>("[data-locale]");
  localeButtons.forEach((btn) => {
    btn.classList.toggle("secondary--active", btn.dataset.locale === getLocale());
    btn.addEventListener("click", () => setLocale(btn.dataset.locale as LocaleCode));
  });

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
  const sceneSecondsNumber = document.getElementById("scene-seconds-number") as HTMLInputElement;
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

  fillSelect(sourceSelect, SOURCE_LANGUAGES, state.sourceLang, true);
  fillSelect(targetSelect, TARGET_LANGUAGES, state.targetLang);
  outputModeSelect.value = state.outputMode;
  if (state.srtFile) dropzoneFile.textContent = t("dropzone.selected", { name: state.srtFile.name });

  const glossaryHandle = mountGlossaryEditor(glossaryEditorContainer, state.glossaryEntries);

  async function loadDictionaryFor(languageCode: string) {
    if (languageCode === AUTO_DETECT_CODE) return;
    const entries = await loadBundledDictionary(languageCode);
    state.glossaryEntries = entries;
    glossaryHandle.setEntries(entries);
  }

  function updateOutputModeVisibility() {
    const isZhTarget = targetSelect.value === "zh";
    outputModeField.hidden = !isZhTarget;
    if (isZhTarget && !state.userPickedOutputMode) {
      state.outputMode = defaultOutputMode(sourceSelect.value === AUTO_DETECT_CODE ? "en" : sourceSelect.value, targetSelect.value);
      outputModeSelect.value = state.outputMode;
    }
  }

  outputModeSelect.addEventListener("change", () => {
    state.userPickedOutputMode = true;
    state.outputMode = outputModeSelect.value as OutputMode;
  });
  targetSelect.addEventListener("change", () => { state.targetLang = targetSelect.value; updateOutputModeVisibility(); });
  sourceSelect.addEventListener("change", () => {
    state.sourceLang = sourceSelect.value;
    updateOutputModeVisibility();
    detectHint.textContent = sourceSelect.value === AUTO_DETECT_CODE && state.srtFile ? t("detect.auto") : "";
    detectHint.classList.remove("detect-hint--done");
    if (sourceSelect.value !== AUTO_DETECT_CODE) loadDictionaryFor(sourceSelect.value);
  });

  function syncSceneSlider() {
    sceneSecondsInput.value = String(clamp(state.sceneSeconds, SCENE_SLIDER_MIN, SCENE_SLIDER_MAX));
  }

  function updateScenePreview() {
    if (!state.lastCues.length) return;
    const count = previewChapterCount(state.lastCues, state.sceneSeconds * 1000);
    scenePreviewHint.textContent = t("scene.preview", { count });
  }

  sceneSecondsInput.addEventListener("input", () => {
    state.sceneSeconds = Number(sceneSecondsInput.value);
    sceneSecondsNumber.value = String(state.sceneSeconds);
    updateScenePreview();
  });
  sceneSecondsNumber.addEventListener("input", () => {
    const parsed = Math.round(Number(sceneSecondsNumber.value));
    if (!Number.isFinite(parsed)) return;
    state.sceneSeconds = clamp(parsed, SCENE_SECONDS_MIN, SCENE_SECONDS_MAX);
    syncSceneSlider();
    updateScenePreview();
  });
  sceneSecondsNumber.addEventListener("blur", () => { sceneSecondsNumber.value = String(state.sceneSeconds); });
  sdhToggle.addEventListener("change", () => { state.sdhEnabled = sdhToggle.checked; });

  function appendLog(message: string) {
    logEl.textContent += `${message}\n`;
    logEl.scrollTop = logEl.scrollHeight;
  }

  async function handleFile(file: File) {
    state.srtFile = file;
    const content = await file.text();
    dropzoneFile.textContent = t("dropzone.selected", { name: file.name });
    langStep.hidden = false;
    optionsStep.hidden = false;
    startStep.hidden = false;

    state.lastCues = parseSrt(content);
    updateScenePreview();

    if (sourceSelect.value === AUTO_DETECT_CODE) {
      const detected = await detectSourceLanguage(state.lastCues);
      if (detected && detected.reliable && isKnownSourceLanguage(detected.code)) {
        sourceSelect.value = detected.code;
        state.sourceLang = detected.code;
        loadDictionaryFor(detected.code);
        detectHint.textContent = t("detect.done", { label: languageProfile(detected.code).label, code: detected.code });
        detectHint.classList.add("detect-hint--done");
      } else {
        detectHint.textContent = t("detect.auto");
        detectHint.classList.remove("detect-hint--done");
      }
      updateOutputModeVisibility();
    }
  }

  srtInput.addEventListener("change", () => { if (srtInput.files?.[0]) handleFile(srtInput.files[0]); });
  ["dragover", "dragenter"].forEach((evt) => dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add("dropzone--active"); }));
  ["dragleave", "drop"].forEach((evt) => dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove("dropzone--active"); }));
  dropzone.addEventListener("drop", (e) => {
    const file = (e as DragEvent).dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });

  handshake()
    .then(({ total, last24h }) => { statsLine.textContent = t("stats.line", { total, last24h }); })
    .catch(() => { statsLine.textContent = ""; });

  startButton.addEventListener("click", async () => {
    if (!state.srtFile) return;

    startButton.disabled = true;
    progressCard.hidden = false;
    resultCard.hidden = true;
    logEl.textContent = "";
    progressBar.removeAttribute("value");
    progressCount.textContent = "";

    try {
      const sourceLang = sourceSelect.value;
      const targetLang = targetSelect.value;
      const outputMode = outputModeSelect.value as OutputMode;
      const sceneChangeSeconds = state.sceneSeconds;
      const stripSdhEnabled = sdhToggle.checked;

      progressLabel.textContent = t("progress.translating");
      state.glossaryEntries = glossaryHandle.getEntries() as DictionaryEntry[];
      const glossary = entriesToGlossary(state.glossaryEntries);

      const { cues: wireCues } = applySdhStripping(state.lastCues, sourceLang, stripSdhEnabled);
      const job = await postTranslateJob({ cues: wireCues, glossary, source: sourceLang, target: targetLang, sceneChangeSeconds }, appendLog);
      if (!job.success) throw new Error(t("error.parseFailed"));
      state.lastJobResult = job;
      state.lastRenderMode = outputMode;

      if (sourceLang === AUTO_DETECT_CODE) {
        const known = SOURCE_LANGUAGES.some((l) => l.code === job.resolved_source_lang.split("-")[0]);
        detectHint.textContent = known
          ? t("detect.done", { label: languageProfile(job.resolved_source_lang).label, code: job.resolved_source_lang })
          : t("detect.unknown", { code: job.resolved_source_lang });
        detectHint.classList.add("detect-hint--done");
      }

      progressBar.value = 100;
      progressLabel.textContent = t("progress.merging");
      const originalById = new Map(state.lastCues.map((c) => [c.id, c]));
      const srt = renderSrt(job.cues, originalById, outputMode);

      const blob = new Blob([srt], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      downloadLink.href = url;
      downloadLink.download = state.srtFile.name.replace(/\.srt$/i, `.${targetLang}.srt`);

      resultSummary.textContent = t("result.summary", {
        cues: job.cues.length, missing: job.missing_count, splits: job.approx_splits.length, skipped: job.missing_cues.length,
      });
      resultCard.hidden = false;
      progressLabel.textContent = t("progress.done");
    } catch (e) {
      appendLog(t("error.prefix", { message: e instanceof Error ? e.message : String(e) }));
      progressLabel.textContent = t("progress.failed");
    } finally {
      startButton.disabled = false;
    }
  });

  previewButton.addEventListener("click", () => {
    if (!state.lastJobResult) return;
    const cards: PreviewCard[] = state.lastJobResult.cues.map((c) => ({
      id: c.id, start: msToSrtTime(c.start_ms), end: msToSrtTime(c.end_ms), source: c.text, target: c.translation || t("preview.missing"),
    }));
    const originalById = new Map(state.lastCues.map((c) => [c.id, c]));
    openPreviewModal(renderSrt(state.lastJobResult.cues, originalById, state.lastRenderMode), cards);
  });
}

onLocaleChange(() => renderApp());
renderApp();
