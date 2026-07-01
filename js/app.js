import * as pdfjsLib from "../vendor/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "../vendor/pdf.worker.min.mjs";

// ---------- 상태 ----------
const state = {
  pdf: null,
  numPages: 0,
  currentPage: 1,
  scale: 1.2,
  fitScale: 1.2,          // 화면 너비에 맞춘 기본 배율
  renderedPages: new Map(), // pageNum -> { wrap, canvas, textLayer, textItems, viewport }
  search: {
    query: "",
    matches: [],          // { page, spanIndex } (렌더된 후 채워짐)
    rawMatches: [],       // { page } 목록 (전체 문서 스캔 결과)
    activeIndex: -1,
  },
};

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const viewer = $("viewer");
const pagesContainer = $("pagesContainer");
const welcome = $("welcome");
const loading = $("loading");
const loadingText = $("loadingText");
const fileInput = $("fileInput");
const pageInput = $("pageInput");
const pageCount = $("pageCount");

// ---------- 파일 열기 ----------
function pickFile() { fileInput.click(); }

$("openBtn").addEventListener("click", pickFile);
$("welcomeOpenBtn").addEventListener("click", pickFile);
fileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) openFile(file);
  fileInput.value = "";
});

// 드래그 앤 드롭
["dragover", "dragenter"].forEach((ev) =>
  viewer.addEventListener(ev, (e) => { e.preventDefault(); viewer.classList.add("dragover"); })
);
["dragleave", "drop"].forEach((ev) =>
  viewer.addEventListener(ev, (e) => { e.preventDefault(); viewer.classList.remove("dragover"); })
);
viewer.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file && file.type === "application/pdf") openFile(file);
});

async function openFile(file) {
  showLoading("문서를 여는 중...");
  try {
    const buf = await file.arrayBuffer();
    await loadPdf(buf);
  } catch (err) {
    alert("PDF를 열 수 없습니다: " + err.message);
    console.error(err);
  } finally {
    hideLoading();
  }
}

async function loadPdf(data) {
  if (state.pdf) { state.pdf.destroy(); }
  clearPages();
  state.pdf = await pdfjsLib.getDocument({ data }).promise;
  state.numPages = state.pdf.numPages;
  state.currentPage = 1;
  welcome.classList.add("hidden");
  pageInput.max = state.numPages;
  pageCount.textContent = state.numPages;
  computeFitScale();
  await renderFresh();
  await buildOutline();
  goToPage(1, false);
}

// ---------- 렌더링 ----------
function clearPages() {
  pagesContainer.innerHTML = "";
  state.renderedPages.clear();
}

async function computeFitScale() {
  // 첫 페이지 기준으로 화면 너비에 맞는 배율 계산
  const page = await state.pdf.getPage(1);
  const unscaled = page.getViewport({ scale: 1 });
  const avail = viewer.clientWidth - 28; // .pages 좌우 패딩(24px) + 약간의 여유
  state.fitScale = Math.max(0.5, avail / unscaled.width);
  state.scale = state.fitScale;
}

async function renderFresh() {
  clearPages();
  const map = new Map();
  for (let n = 1; n <= state.numPages; n++) {
    map.set(n, await buildPage(n, pagesContainer));
  }
  state.renderedPages = map;
}

// 한 페이지를 만들어 지정한 컨테이너에 넣고 entry를 반환 (재렌더 시 재사용)
async function buildPage(num, container) {
  const page = await state.pdf.getPage(num);
  const viewport = page.getViewport({ scale: state.scale });
  const dpr = window.devicePixelRatio || 1;

  const wrap = document.createElement("div");
  wrap.className = "page-wrap";
  wrap.dataset.page = num;
  wrap.style.width = viewport.width + "px";
  wrap.style.height = viewport.height + "px";

  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = viewport.width + "px";
  canvas.style.height = viewport.height + "px";
  const ctx = canvas.getContext("2d");
  wrap.appendChild(canvas);

  const textLayer = document.createElement("div");
  textLayer.className = "text-layer";
  textLayer.style.width = viewport.width + "px";
  textLayer.style.height = viewport.height + "px";
  wrap.appendChild(textLayer);

  container.appendChild(wrap);

  await page.render({
    canvasContext: ctx,
    viewport,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
  }).promise;

  const textContent = await page.getTextContent();
  const textItems = buildTextLayer(textLayer, textContent, viewport);

  return { wrap, canvas, textLayer, textItems, viewport, page };
}

// 텍스트 레이어를 수동으로 그려 검색 하이라이트를 지원
function buildTextLayer(container, textContent, viewport) {
  container.innerHTML = "";
  const items = [];
  for (const item of textContent.items) {
    if (!item.str) continue;
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontHeight = Math.hypot(tx[2], tx[3]);
    const left = tx[4];
    const top = tx[5] - fontHeight;
    const span = document.createElement("span");
    span.textContent = item.str;
    span.style.left = left + "px";
    span.style.top = top + "px";
    span.style.fontSize = fontHeight + "px";
    span.style.fontFamily = item.fontName || "sans-serif";
    container.appendChild(span);
    items.push({ span, str: item.str });
  }
  return items;
}

// ---------- 페이지 이동 ----------
function goToPage(num, smooth = true) {
  num = Math.max(1, Math.min(state.numPages, num));
  state.currentPage = num;
  pageInput.value = num;
  const entry = state.renderedPages.get(num);
  if (entry) {
    entry.wrap.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
  }
}

pageInput.addEventListener("change", () => goToPage(parseInt(pageInput.value, 10) || 1));

// 스크롤에 따라 현재 페이지 번호 갱신
let scrollRAF = null;
viewer.addEventListener("scroll", () => {
  if (scrollRAF) return;
  scrollRAF = requestAnimationFrame(() => {
    scrollRAF = null;
    updateCurrentPageFromScroll();
  });
});
function updateCurrentPageFromScroll() {
  const mid = viewer.scrollTop + viewer.clientHeight / 2;
  let best = state.currentPage;
  for (const [num, entry] of state.renderedPages) {
    const top = entry.wrap.offsetTop;
    const bottom = top + entry.wrap.offsetHeight;
    if (mid >= top && mid < bottom) { best = num; break; }
  }
  if (best !== state.currentPage) {
    state.currentPage = best;
    pageInput.value = best;
  }
}

// 스와이프로 페이지 넘김 (확대되지 않은 상태에서 한 손가락 가로 스와이프만)
let touchStartX = 0, touchStartY = 0, touchStartT = 0, swipeCandidate = false;
viewer.addEventListener("touchstart", (e) => {
  if (e.touches.length === 1) {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchStartT = e.timeStamp;
    // ★ 제스처 "시작" 시점의 확대 상태로 판단.
    //   확대 중이면 이 제스처는 넘김이 아니라 패닝이므로 후보에서 제외.
    swipeCandidate = !isZoomed();
  } else {
    // 두 손가락 이상(핀치 등)이면 넘김 후보 아님
    swipeCandidate = false;
  }
}, { passive: true });
viewer.addEventListener("touchmove", (e) => {
  // 제스처 도중 손가락이 추가되면(핀치로 전환) 넘김 취소
  if (e.touches.length > 1) swipeCandidate = false;
}, { passive: true });
viewer.addEventListener("touchend", (e) => {
  if (!swipeCandidate) return;
  swipeCandidate = false;
  const t = e.changedTouches[0];
  const dx = t.clientX - touchStartX;
  const dy = t.clientY - touchStartY;
  const dt = e.timeStamp - touchStartT;
  if (dt < 500 && Math.abs(dx) > 80 && Math.abs(dx) > Math.abs(dy) * 1.8) {
    if (dx < 0) goToPage(state.currentPage + 1);
    else goToPage(state.currentPage - 1);
  }
}, { passive: true });

// ---------- 확대/축소 ----------
$("zoomInBtn").addEventListener("click", () => requestZoom(state.scale * 1.25));
$("zoomOutBtn").addEventListener("click", () => requestZoom(state.scale / 1.25));

// 화면 맞춤 배율보다 확대된 상태인지 (스와이프 넘김 vs 패닝 판단에 사용)
function isZoomed() { return state.scale > state.fitScale * 1.02; }

// 확대 요청을 직렬화 — 연속 확대 시 재렌더가 겹치지 않도록
let zoomBusy = false, zoomPending = null;
function requestZoom(scale) {
  zoomPending = Math.max(0.4, Math.min(5, scale));
  if (zoomBusy) return;
  runZoomQueue();
}
async function runZoomQueue() {
  zoomBusy = true;
  try {
    while (zoomPending != null) {
      const s = zoomPending;
      zoomPending = null;
      await rerenderAt(s);
    }
  } finally {
    zoomBusy = false;
  }
}

// 새 배율로 다시 렌더. 화면 중심을 유지하고, 재렌더 동안에는 CSS 변형으로 즉시 미리보기를 유지해 깜빡임/끊김을 없앰
async function rerenderAt(newScale) {
  if (!state.pdf) return;
  const oldScale = state.scale;
  if (Math.abs(newScale - oldScale) < 0.001) { clearPreview(); return; }
  const factor = newScale / oldScale;

  // 화면 중심 기준 즉시 미리보기 (부드러운 반응)
  const cx = viewer.scrollLeft + viewer.clientWidth / 2;
  const cy = viewer.scrollTop + viewer.clientHeight / 2;
  pagesContainer.style.transformOrigin = `${cx}px ${cy}px`;
  pagesContainer.style.transform = `scale(${factor})`;

  // 재렌더 후 중심을 유지하기 위한 목표 스크롤
  const targetLeft = cx * factor - viewer.clientWidth / 2;
  const targetTop = cy * factor - viewer.clientHeight / 2;

  state.scale = newScale;

  // 새 페이지를 화면 밖 프래그먼트에 렌더 → 기존 미리보기는 그대로 유지되어 깜빡임 없음
  const frag = document.createDocumentFragment();
  const map = new Map();
  for (let n = 1; n <= state.numPages; n++) {
    map.set(n, await buildPage(n, frag));
  }

  // 교체 후 미리보기 변형 제거
  clearPreview();
  pagesContainer.replaceChildren(frag);
  state.renderedPages = map;

  // 중심 유지 스크롤 복원
  viewer.scrollLeft = Math.max(0, targetLeft);
  viewer.scrollTop = Math.max(0, targetTop);

  // 검색 중이었다면 하이라이트 복원
  if (state.search.query) reapplySearchAfterRender();
}

function clearPreview() {
  pagesContainer.style.transform = "";
  pagesContainer.style.transformOrigin = "";
}

function reapplySearchAfterRender() {
  applyHighlights();
  const n = state.search.matches.length;
  if (n > 0) {
    if (state.search.activeIndex < 0 || state.search.activeIndex >= n) state.search.activeIndex = 0;
    state.search.matches[state.search.activeIndex].mark.classList.add("hl-active");
  } else {
    state.search.activeIndex = -1;
  }
  updateSearchStatus();
}

// ---------- 핀치 확대 (두 손가락, 실시간 미리보기) ----------
let pinchActive = false, pinchStartDist = 0, pinchStartScale = 1, pinchRatio = 1;
viewer.addEventListener("touchstart", (e) => {
  if (e.touches.length === 2) {
    pinchActive = true;
    pinchStartDist = touchDist(e.touches);
    pinchStartScale = state.scale;
    pinchRatio = 1;
    // 화면 중심을 확대 기준점으로 고정
    const cx = viewer.scrollLeft + viewer.clientWidth / 2;
    const cy = viewer.scrollTop + viewer.clientHeight / 2;
    pagesContainer.style.transformOrigin = `${cx}px ${cy}px`;
  }
}, { passive: true });
viewer.addEventListener("touchmove", (e) => {
  if (pinchActive && e.touches.length === 2 && pinchStartDist) {
    e.preventDefault(); // 브라우저 기본 확대 방지
    pinchRatio = touchDist(e.touches) / pinchStartDist;
    // 최종 배율이 허용 범위를 넘지 않도록 미리보기도 제한
    const clamped = Math.max(0.4, Math.min(5, pinchStartScale * pinchRatio)) / pinchStartScale;
    pagesContainer.style.transform = `scale(${clamped})`;
  }
}, { passive: false });
viewer.addEventListener("touchend", (e) => {
  if (pinchActive && e.touches.length < 2) {
    pinchActive = false;
    pinchStartDist = 0;
    const target = pinchStartScale * pinchRatio;
    if (Math.abs(target - state.scale) > 0.005) requestZoom(target);
    else clearPreview();
  }
});
function touchDist(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

// ---------- 목차 (Outline) ----------
const outlinePanel = $("outlinePanel");
const outlineContent = $("outlineContent");
const backdrop = $("backdrop");

$("menuBtn").addEventListener("click", () => toggleOutline(true));
$("outlineClose").addEventListener("click", () => toggleOutline(false));
backdrop.addEventListener("click", () => toggleOutline(false));

function toggleOutline(show) {
  outlinePanel.classList.toggle("hidden", !show);
  backdrop.classList.toggle("hidden", !show);
}

async function buildOutline() {
  outlineContent.innerHTML = "";
  let outline = null;
  try { outline = await state.pdf.getOutline(); } catch { /* 무시 */ }
  if (!outline || outline.length === 0) {
    outlineContent.innerHTML = '<div class="outline-empty">이 문서에는 목차 정보가 없습니다.</div>';
    return;
  }
  const flat = [];
  const walk = (items, depth) => {
    for (const it of items) {
      flat.push({ title: it.title, dest: it.dest, depth });
      if (it.items && it.items.length) walk(it.items, depth + 1);
    }
  };
  walk(outline, 0);

  for (const it of flat) {
    const el = document.createElement("div");
    el.className = "outline-item";
    el.textContent = it.title;
    el.style.paddingLeft = 16 + it.depth * 16 + "px";
    el.addEventListener("click", async () => {
      toggleOutline(false);
      const pageNum = await destToPage(it.dest);
      if (pageNum) goToPage(pageNum);
    });
    outlineContent.appendChild(el);
  }
}

async function destToPage(dest) {
  try {
    let explicit = dest;
    if (typeof dest === "string") explicit = await state.pdf.getDestination(dest);
    if (!explicit) return null;
    const ref = explicit[0];
    const idx = await state.pdf.getPageIndex(ref);
    return idx + 1;
  } catch { return null; }
}

// ---------- 검색 ----------
const searchBar = $("searchBar");
const searchField = $("searchField");
const searchStatus = $("searchStatus");

$("searchBtn").addEventListener("click", () => {
  searchBar.classList.remove("hidden");
  searchField.focus();
});
$("searchClose").addEventListener("click", closeSearch);
$("searchNext").addEventListener("click", () => moveMatch(1));
$("searchPrev").addEventListener("click", () => moveMatch(-1));

let searchDebounce = null;
searchField.addEventListener("input", () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(runSearch, 250);
});
searchField.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); moveMatch(e.shiftKey ? -1 : 1); }
});

function closeSearch() {
  searchBar.classList.add("hidden");
  clearHighlights();
  state.search.query = "";
  state.search.matches = [];
  state.search.activeIndex = -1;
  searchStatus.textContent = "";
  searchField.value = "";
}

function clearHighlights() {
  for (const [, entry] of state.renderedPages) {
    for (const item of entry.textItems) {
      if (item.span.querySelector(".hl") || item.span.dataset.hl) {
        item.span.textContent = item.str; // 원본 복원
        delete item.span.dataset.hl;
      }
    }
  }
}

function runSearch() {
  const q = searchField.value.trim();
  clearHighlights();
  state.search.matches = [];
  state.search.activeIndex = -1;
  state.search.query = q;
  if (!q) { searchStatus.textContent = ""; return; }
  applyHighlights();
  if (state.search.matches.length > 0) {
    state.search.activeIndex = 0;
    focusMatch();
  }
  updateSearchStatus();
}

// 렌더된 텍스트 스팬에서 검색어를 찾아 하이라이트
function applyHighlights() {
  const q = state.search.query.toLowerCase();
  if (!q) return;
  state.search.matches = [];
  for (const [pageNum, entry] of state.renderedPages) {
    for (let si = 0; si < entry.textItems.length; si++) {
      const item = entry.textItems[si];
      const lower = item.str.toLowerCase();
      let idx = lower.indexOf(q);
      if (idx === -1) continue;
      // 하이라이트 마크업 생성
      const frag = document.createDocumentFragment();
      let cursor = 0;
      while (idx !== -1) {
        if (idx > cursor) frag.appendChild(document.createTextNode(item.str.slice(cursor, idx)));
        const mark = document.createElement("span");
        mark.className = "hl";
        mark.textContent = item.str.slice(idx, idx + q.length);
        frag.appendChild(mark);
        state.search.matches.push({ page: pageNum, mark });
        cursor = idx + q.length;
        idx = lower.indexOf(q, cursor);
      }
      if (cursor < item.str.length) frag.appendChild(document.createTextNode(item.str.slice(cursor)));
      item.span.textContent = "";
      item.span.appendChild(frag);
      item.span.dataset.hl = "1";
    }
  }
}

function moveMatch(dir) {
  const n = state.search.matches.length;
  if (n === 0) return;
  state.search.activeIndex = (state.search.activeIndex + dir + n) % n;
  focusMatch();
  updateSearchStatus();
}

function focusMatch() {
  state.search.matches.forEach((m) => m.mark.classList.remove("hl-active"));
  const m = state.search.matches[state.search.activeIndex];
  if (!m) return;
  m.mark.classList.add("hl-active");
  m.mark.scrollIntoView({ behavior: "smooth", block: "center" });
}

function updateSearchStatus() {
  const n = state.search.matches.length;
  searchStatus.textContent = n === 0 ? "결과 없음" : `${state.search.activeIndex + 1}/${n}`;
}

// ---------- 로딩 표시 ----------
function showLoading(text) {
  loadingText.textContent = text || "불러오는 중...";
  loading.classList.remove("hidden");
}
function hideLoading() { loading.classList.add("hidden"); }

// ---------- 키보드 (데스크톱 테스트용) ----------
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  if (e.key === "ArrowRight" || e.key === "PageDown") goToPage(state.currentPage + 1);
  if (e.key === "ArrowLeft" || e.key === "PageUp") goToPage(state.currentPage - 1);
});

// ---------- 서비스 워커 등록 (PWA) ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW 등록 실패", e));
  });
}
