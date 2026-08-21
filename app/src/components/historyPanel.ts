import { HistoryEntry, listHistoryEntries, deleteHistoryEntry, clearHistory } from "../core/history";
import { t, getLocale } from "../i18n";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatDate(ms: number): string {
  const locale = getLocale() === "zh" ? "zh-CN" : "en-US";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));
}

function mimeFor(format: HistoryEntry["format"]): string {
  return format === "vtt" ? "text/vtt;charset=utf-8" : "text/plain;charset=utf-8";
}

function downloadEntry(entry: HistoryEntry): void {
  const blob = new Blob([entry.content], { type: mimeFor(entry.format) });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = entry.filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function openHistoryPanel(): void {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal">
      <div class="modal__head">
        <span class="modal__title">${t("history.title")}</span>
        <div class="modal__head-actions">
          <button type="button" class="secondary" id="history-clear">${t("history.clearAll")}</button>
          <button type="button" class="modal__close" aria-label="${t("preview.close")}">✕</button>
        </div>
      </div>
      <div class="modal__body">
        <div class="history-list" id="history-list"></div>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  document.body.style.overflow = "hidden";

  const listEl = backdrop.querySelector<HTMLElement>("#history-list")!;

  function close() {
    document.body.style.overflow = "";
    backdrop.remove();
  }

  async function render() {
    const entries = await listHistoryEntries();
    if (!entries.length) {
      listEl.innerHTML = `<p class="muted history-empty">${t("history.empty")}</p>`;
      return;
    }
    listEl.innerHTML = entries.map((entry) => `
      <div class="history-row">
        <div class="history-row__info">
          <div class="history-row__name">${escapeHtml(entry.filename)}</div>
          <div class="history-row__meta">${escapeHtml(entry.sourceLang)} → ${escapeHtml(entry.targetLang)} · ${entry.cueCount} ${t("history.cues")} · ${formatDate(entry.createdAt)}</div>
        </div>
        <div class="history-row__actions">
          <button type="button" class="secondary" data-download="${entry.id}">${t("history.download")}</button>
          <button type="button" class="secondary" data-delete="${entry.id}">${t("history.delete")}</button>
        </div>
      </div>`).join("");

    listEl.querySelectorAll<HTMLButtonElement>("[data-download]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const entry = entries.find((e) => e.id === btn.dataset.download);
        if (entry) downloadEntry(entry);
      });
    });
    listEl.querySelectorAll<HTMLButtonElement>("[data-delete]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await deleteHistoryEntry(btn.dataset.delete!);
        render();
      });
    });
  }

  backdrop.querySelector(".modal__close")!.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector("#history-clear")!.addEventListener("click", async () => {
    await clearHistory();
    render();
  });

  render();
}
