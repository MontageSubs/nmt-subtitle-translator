import { t } from "../i18n";

export interface PreviewCard {
  id: number;
  start: string;
  end: string;
  source: string;
  target: string;
  missing?: boolean;
  warning?: boolean;
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

function cardClass(card: PreviewCard): string {
  if (card.missing) return " preview-card--missing";
  if (card.warning) return " preview-card--warning";
  return "";
}

interface CardsView {
  setFilter(query: string): number;
  scrollToId(id: number): void;
}

function createCardsView(scrollHost: HTMLElement, allCards: PreviewCard[]): CardsView {
  let cards = allCards;
  let offsets: number[] = [0];
  let spacer: HTMLElement;

  function rebuildLayout(): void {
    offsets = [0];
    for (const card of cards) offsets.push(offsets[offsets.length - 1] + estimateCardHeight(card));
    scrollHost.innerHTML = `<div class="preview-cards"><div class="preview-cards__spacer" style="height:${offsets[offsets.length - 1]}px"></div></div>`;
    spacer = scrollHost.querySelector<HTMLElement>(".preview-cards__spacer")!;
  }

  function findIndexAtOffset(target: number): number {
    let lo = 0, hi = offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid + 1] < target) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function renderWindow(): void {
    const viewTop = scrollHost.scrollTop - RENDER_BUFFER_PX;
    const viewBottom = scrollHost.scrollTop + scrollHost.clientHeight + RENDER_BUFFER_PX;
    const startIndex = findIndexAtOffset(Math.max(0, viewTop));
    const endIndex = Math.min(cards.length, findIndexAtOffset(viewBottom) + 1);

    let html = "";
    for (let i = startIndex; i < endIndex; i++) {
      const c = cards[i];
      html += `<div class="preview-card${cardClass(c)}" style="top:${offsets[i]}px">
        <div class="preview-card__id">#${c.id} · ${c.start} → ${c.end}</div>
        <div class="preview-card__src">${escapeHtml(c.source)}</div>
        <div class="preview-card__dst">${escapeHtml(c.target)}</div>
      </div>`;
    }
    spacer.innerHTML = html;
  }

  rebuildLayout();
  scrollHost.addEventListener("scroll", renderWindow, { passive: true });
  renderWindow();

  return {
    setFilter(query: string): number {
      const trimmed = query.trim();
      const idMatch = /^#(\d+)$/.exec(trimmed);
      if (!trimmed) cards = allCards;
      else if (idMatch) cards = allCards.filter((c) => c.id === Number(idMatch[1]));
      else {
        const needle = trimmed.toLowerCase();
        cards = allCards.filter((c) => c.source.toLowerCase().includes(needle) || c.target.toLowerCase().includes(needle));
      }
      rebuildLayout();
      scrollHost.scrollTop = 0;
      renderWindow();
      return cards.length;
    },
    scrollToId(id: number): void {
      const index = allCards.findIndex((c) => c.id === id);
      if (index === -1) return;
      cards = allCards;
      rebuildLayout();
      renderWindow();
      scrollHost.scrollTop = Math.max(0, offsets[index] - 20);
    },
  };
}

export interface PreviewModalHandle {
  close(): void;
}

export function openPreviewModal(rawSrt: string, cards: PreviewCard[]): PreviewModalHandle {
  const problemCards = cards.filter((c) => c.missing || c.warning);
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal">
      <div class="modal__head">
        <div class="modal__tabs">
          <button type="button" class="modal__tab modal__tab--active" data-tab="cards">${t("preview.tabCards")}</button>
          <button type="button" class="modal__tab" data-tab="raw">${t("preview.tabRaw")}</button>
        </div>
        <button type="button" class="modal__close" aria-label="${t("preview.close")}">✕</button>
      </div>
      <div class="modal__body">
        <pre class="preview-raw" style="display:none"></pre>
        <div class="preview-cards-pane">
          <div class="preview-toolbar">
            <input type="search" class="preview-search" placeholder="${t("preview.searchPlaceholder")}" />
            <span class="preview-match-count"></span>
          </div>
          <div class="preview-problem-list" style="display:${problemCards.length ? "flex" : "none"}"></div>
          <div class="preview-cards-host" style="height:56vh; overflow-y:auto"></div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  document.body.style.overflow = "hidden";

  const rawPre = backdrop.querySelector<HTMLElement>(".preview-raw")!;
  rawPre.textContent = rawSrt;
  const cardsPane = backdrop.querySelector<HTMLElement>(".preview-cards-pane")!;
  const cardsHost = backdrop.querySelector<HTMLElement>(".preview-cards-host")!;
  const searchInput = backdrop.querySelector<HTMLInputElement>(".preview-search")!;
  const matchCount = backdrop.querySelector<HTMLElement>(".preview-match-count")!;
  const problemList = backdrop.querySelector<HTMLElement>(".preview-problem-list")!;

  const view = createCardsView(cardsHost, cards);

  problemList.innerHTML = problemCards.map((c) => `
    <button type="button" class="preview-problem-chip${c.missing ? " preview-problem-chip--missing" : ""}" data-jump="${c.id}">
      ${c.missing ? "✕" : "⚠"} #${c.id}
    </button>`).join("");
  problemList.querySelectorAll<HTMLButtonElement>("[data-jump]").forEach((chip) => {
    chip.addEventListener("click", () => {
      searchInput.value = "";
      matchCount.textContent = "";
      view.scrollToId(Number(chip.dataset.jump));
    });
  });

  searchInput.addEventListener("input", () => {
    const total = cards.length;
    const matched = view.setFilter(searchInput.value);
    matchCount.textContent = searchInput.value.trim() ? t("preview.matchCount", { matched, total }) : "";
  });

  function close() {
    document.body.style.overflow = "";
    backdrop.remove();
  }

  backdrop.querySelector(".modal__close")!.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });

  backdrop.querySelectorAll<HTMLButtonElement>(".modal__tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      backdrop.querySelectorAll(".modal__tab").forEach((el) => el.classList.remove("modal__tab--active"));
      tab.classList.add("modal__tab--active");
      const isCards = tab.dataset.tab === "cards";
      rawPre.style.display = isCards ? "none" : "block";
      cardsPane.style.display = isCards ? "flex" : "none";
    });
  });

  return { close };
}
