import { t } from "../i18n";

export interface PreviewCard {
  id: number;
  start: string;
  end: string;
  source: string;
  target: string;
}

const CARD_BASE_HEIGHT = 58;
const CARD_CHARS_PER_LINE = 42;
const CARD_LINE_HEIGHT = 20;
const RENDER_BUFFER_PX = 400;

function estimateCardHeight(card: PreviewCard): number {
  const lines = Math.max(1, Math.ceil((card.source.length || 1) / CARD_CHARS_PER_LINE)) +
    Math.max(1, Math.ceil((card.target.length || 1) / CARD_CHARS_PER_LINE));
  return CARD_BASE_HEIGHT + lines * CARD_LINE_HEIGHT;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderVirtualCards(scrollHost: HTMLElement, cards: PreviewCard[]): void {
  const heights = cards.map(estimateCardHeight);
  const offsets: number[] = [0];
  for (const h of heights) offsets.push(offsets[offsets.length - 1] + h);
  const totalHeight = offsets[offsets.length - 1];

  scrollHost.innerHTML = `<div class="preview-cards"><div class="preview-cards__spacer" style="height:${totalHeight}px"></div></div>`;
  const spacer = scrollHost.querySelector<HTMLElement>(".preview-cards__spacer")!;

  function findIndexAtOffset(target: number): number {
    let lo = 0, hi = offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid + 1] < target) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function renderWindow() {
    const viewTop = scrollHost.scrollTop - RENDER_BUFFER_PX;
    const viewBottom = scrollHost.scrollTop + scrollHost.clientHeight + RENDER_BUFFER_PX;
    const startIndex = findIndexAtOffset(Math.max(0, viewTop));
    const endIndex = Math.min(cards.length, findIndexAtOffset(viewBottom) + 1);

    let html = "";
    for (let i = startIndex; i < endIndex; i++) {
      const c = cards[i];
      html += `<div class="preview-card" style="top:${offsets[i]}px">
        <div class="preview-card__id">#${c.id} · ${c.start} → ${c.end}</div>
        <div class="preview-card__src">${escapeHtml(c.source)}</div>
        <div class="preview-card__dst">${escapeHtml(c.target)}</div>
      </div>`;
    }
    spacer.innerHTML = html;
  }

  scrollHost.addEventListener("scroll", renderWindow, { passive: true });
  renderWindow();
}

export interface PreviewModalHandle {
  close(): void;
}

export function openPreviewModal(rawSrt: string, cards: PreviewCard[]): PreviewModalHandle {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal">
      <div class="modal__head">
        <div class="modal__tabs">
          <button type="button" class="modal__tab modal__tab--active" data-tab="raw">${t("preview.tabRaw")}</button>
          <button type="button" class="modal__tab" data-tab="cards">${t("preview.tabCards")}</button>
        </div>
        <button type="button" class="modal__close" aria-label="${t("preview.close")}">✕</button>
      </div>
      <div class="modal__body">
        <pre class="preview-raw"></pre>
        <div class="preview-cards-host" style="height:60vh; overflow-y:auto; display:none"></div>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  document.body.style.overflow = "hidden";

  const rawPre = backdrop.querySelector<HTMLElement>(".preview-raw")!;
  rawPre.textContent = rawSrt;
  const cardsHost = backdrop.querySelector<HTMLElement>(".preview-cards-host")!;
  let cardsRendered = false;

  function close() {
    document.body.style.overflow = "";
    backdrop.remove();
  }

  backdrop.querySelector(".modal__close")!.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });

  backdrop.querySelectorAll<HTMLButtonElement>(".modal__tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      backdrop.querySelectorAll(".modal__tab").forEach((t) => t.classList.remove("modal__tab--active"));
      tab.classList.add("modal__tab--active");
      const isCards = tab.dataset.tab === "cards";
      rawPre.style.display = isCards ? "none" : "block";
      cardsHost.style.display = isCards ? "block" : "none";
      if (isCards && !cardsRendered) {
        renderVirtualCards(cardsHost, cards);
        cardsRendered = true;
      }
    });
  });

  return { close };
}
