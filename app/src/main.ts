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
import { t, getLocale, setLocale, onLocaleChange, LocaleCode } from "./i18n";

const SUCCESS_COMPLETION_THRESHOLD = 0.95;
const SCENE_SECONDS_MIN = 1;
const SCENE_SECONDS_MAX = 99999;
const SCENE_SLIDER_MIN = 5;
const SCENE_SLIDER_MAX = 120;

const app = document.getElementById("app")!;

// 跨语言切换保留的用户状态：main.ts 采用一次性 innerHTML 渲染的既有架构，
// 切换 locale 时整体重渲染最简单可靠，但不能丢用户已经做的选择，所以状态提到渲染函数之外。
interface AppState {
  srtFile: File | null;
  srtContent: string;
  lastCues: ReturnType<typeof extract>["cues"];
  lastMergeResult: Awaited<ReturnType<typeof merge>> | null;
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
  srtContent: "",
  lastCues: [],
  lastMergeResult: null,
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
  setUiLogSink(appendLog);

  async function handleFile(file: File) {
    state.srtFile = file;
    state.srtContent = await file.text();
    dropzoneFile.textContent = t("dropzone.selected", { name: file.name });
    langStep.hidden = false;
    optionsStep.hidden = false;
    startStep.hidden = false;

    const { cues } = parseSrt(state.srtContent, false, false, false);
    state.lastCues = cues;
    updateScenePreview();

    if (sourceSelect.value === AUTO_DETECT_CODE) {
      detectHint.textContent = t("detect.detecting");
      detectHint.classList.remove("detect-hint--done");
      const sample = cues.slice(0, 20).map((c) => c.text).join(" ");
      const detected = await detectLanguage(sample);
      if (detected) {
        const known = SOURCE_LANGUAGES.some((l) => l.code === detected.split("-")[0]);
        detectHint.textContent = known
          ? t("detect.done", { label: languageProfile(detected).label, code: detected })
          : t("detect.unknown", { code: detected });
        detectHint.classList.add("detect-hint--done");
        if (known) {
          sourceSelect.value = detected.split("-")[0];
          state.sourceLang = sourceSelect.value;
          loadDictionaryFor(sourceSelect.value);
        }
      } else {
        detectHint.textContent = t("detect.unavailable");
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
    progressBar.value = 0;

    try {
      const sourceLang = sourceSelect.value === AUTO_DETECT_CODE ? "en" : sourceSelect.value;
      const targetLang = targetSelect.value;
      const outputMode = outputModeSelect.value as OutputMode;
      const sceneChangeSeconds = state.sceneSeconds;
      const stripSdhEnabled = sdhToggle.checked;

      progressLabel.textContent = t("progress.parsing");
      state.glossaryEntries = glossaryHandle.getEntries() as DictionaryEntry[];
      const glossary = entriesToGlossary(state.glossaryEntries);

      const extracted = extract(state.srtContent, glossary, { sourceLang, stripSdhEnabled, sceneChangeSeconds });
      if (!extracted.success) throw new Error(t("error.parseFailed"));
      uiLog(t("log.extractSummary", { cues: extracted.cues.length, units: extracted.units.length, chapters: extracted.chapters.length }));

      progressLabel.textContent = t("progress.translating");
      const { translations, skipped } = await translateUnits(
        extracted.units, extracted.chapters, extracted.cues, sourceLang, targetLang,
        {
          onProgress: (event) => {
            const percent = event.total ? Math.round((event.completed / event.total) * 100) : 0;
            progressBar.value = percent;
            progressCount.textContent = t("progress.batches", { completed: event.completed, total: event.total });
          },
        }
      );

      progressLabel.textContent = t("progress.merging");
      const result = await merge(extracted.cues, extracted.units, translations, sourceLang, targetLang, outputMode);
      state.lastMergeResult = result;

      const blob = new Blob([result.srt], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      downloadLink.href = url;
      downloadLink.download = state.srtFile.name.replace(/\.srt$/i, `.${targetLang}.srt`);

      resultSummary.textContent = t("result.summary", {
        cues: extracted.cues.length, missing: result.missing_count, splits: result.approx_splits.length, skipped: skipped.length,
      });
      resultCard.hidden = false;
      progressLabel.textContent = t("progress.done");

      const completionRatio = extracted.cues.length ? (extracted.cues.length - result.missing_count) / extracted.cues.length : 0;
      if (completionRatio >= SUCCESS_COMPLETION_THRESHOLD) {
        downloadLink.addEventListener("click", () => bufferSuccess(), { once: true });
      }
    } catch (e) {
      appendLog(t("error.prefix", { message: e instanceof Error ? e.message : String(e) }));
      progressLabel.textContent = t("progress.failed");
    } finally {
      startButton.disabled = false;
    }
  });

  previewButton.addEventListener("click", () => {
    if (!state.lastMergeResult) return;
    const cards: PreviewCard[] = state.lastMergeResult.cues.map((c) => ({
      id: c.id, start: c.start, end: c.end, source: c.text, target: c.translation || t("preview.missing"),
    }));
    openPreviewModal(state.lastMergeResult.srt, cards);
  });
}

onLocaleChange(() => renderApp());
renderApp();
