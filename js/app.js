import * as pdfjsLib from "../vendor/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "../vendor/pdf.worker.min.mjs";

// ---------- 최근 파일 저장소 (IndexedDB) ----------
// 웹앱은 파일 경로로 다시 열 수 없으므로 PDF 내용 자체를 기기 내부에 저장한다.
// meta 스토어(가벼운 목록) + blob 스토어(실제 바이트)로 분리해 목록 조회 시 바이트를 읽지 않는다.
const DB_NAME = "pdfviewer";
const DB_VERSION = 1;
const MAX_RECENTS = 12;             // 최대 보관 개수
const MAX_STORE_BYTES = 80 * 1024 * 1024; // 이보다 큰 파일은 바이트 저장 생략(목록엔 남기되 재열기 불가)

let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "id" });
      if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function idbReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function recentsList() {
  try {
    const db = await openDB();
    const tx = db.transaction("meta", "readonly");
    const all = await idbReq(tx.objectStore("meta").getAll());
    return all.sort((a, b) => b.savedAt - a.savedAt);
  } catch (e) {
    console.warn("최근 목록 조회 실패", e);
    return [];
  }
}

async function recentGetBytes(id) {
  const db = await openDB();
  const tx = db.transaction("blobs", "readonly");
  return idbReq(tx.objectStore("blobs").get(id));
}

async function recentSave(meta, bytes) {
  const db = await openDB();
  // meta + blob 저장
  await new Promise((resolve, reject) => {
    const tx = db.transaction(["meta", "blobs"], "readwrite");
    tx.objectStore("meta").put(meta);
    if (bytes) tx.objectStore("blobs").put(bytes, meta.id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  // 개수 제한 초과분 정리
  const list = await recentsList();
  if (list.length > MAX_RECENTS) {
    const remove = list.slice(MAX_RECENTS);
    await Promise.all(remove.map((m) => recentDelete(m.id)));
  }
}

async function recentDelete(id) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(["meta", "blobs"], "readwrite");
    tx.objectStore("meta").delete(id);
    tx.objectStore("blobs").delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function recentClear() {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(["meta", "blobs"], "readwrite");
    tx.objectStore("meta").clear();
    tx.objectStore("blobs").clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function recentUpdatePage(id, page) {
  if (!id) return;
  try {
    const db = await openDB();
    const tx = db.transaction("meta", "readwrite");
    const store = tx.objectStore("meta");
    const meta = await idbReq(store.get(id));
    if (meta) { meta.lastPage = page; store.put(meta); }
  } catch (e) { /* 무시 */ }
}

// ---------- 상태 ----------
const state = {
  pdf: null,
  numPages: 0,
  currentPage: 1,
  currentFileId: null,    // 현재 열려 있는 파일의 최근목록 id
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
    const id = `${file.name}__${file.size}__${file.lastModified}`;
    // 이미 본 적 있으면 마지막 페이지 이어보기
    let resumePage = 1;
    try {
      const db = await openDB();
      const prev = await idbReq(db.transaction("meta", "readonly").objectStore("meta").get(id));
      if (prev && prev.lastPage) resumePage = prev.lastPage;
    } catch { /* 무시 */ }

    // ★ PDF.js에 넘기기 전에 먼저 저장 (getDocument는 ArrayBuffer를 detach 함)
    await saveRecentFor(id, file, resumePage);
    state.currentFileId = id;
    await loadPdf(buf, resumePage);
  } catch (err) {
    alert("PDF를 열 수 없습니다: " + err.message);
    console.error(err);
  } finally {
    hideLoading();
  }
}

// 최근목록에 메타 + (가능하면) 바이트 저장
async function saveRecentFor(id, file, lastPage) {
  const meta = {
    id,
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
    lastPage: lastPage || 1,
    savedAt: performance.timeOrigin + performance.now(), // Date.now 대체(단조 증가 타임스탬프)
  };
  let bytes = null;
  if (file.size <= MAX_STORE_BYTES) {
    try { bytes = await file.arrayBuffer(); } catch { bytes = null; }
  } else {
    meta.tooLarge = true; // 재열기 불가 표시
  }
  try {
    await recentSave(meta, bytes);
  } catch (e) {
    console.warn("최근 파일 저장 실패(용량 초과 등)", e);
  }
}

async function loadPdf(data, resumePage = 1) {
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
  goToPage(Math.max(1, Math.min(state.numPages, resumePage)), false);
}

// 최근 목록에서 다시 열기
async function reopenRecent(id) {
  showLoading("문서를 여는 중...");
  try {
    const bytes = await recentGetBytes(id);
    if (!bytes) {
      alert("저장된 파일 데이터가 없어 다시 열 수 없습니다. 파일을 다시 선택해 주세요.");
      return;
    }
    const list = await recentsList();
    const meta = list.find((m) => m.id === id);
    state.currentFileId = id;
    // savedAt 갱신(목록 상단으로)
    if (meta) { meta.savedAt = performance.timeOrigin + performance.now(); await recentSave(meta, null); }
    await loadPdf(bytes, meta ? meta.lastPage : 1);
  } catch (err) {
    alert("다시 열기 실패: " + err.message);
    console.error(err);
  } finally {
    hideLoading();
  }
}

// ---------- 최근 파일 UI ----------
const recentSection = $("recentSection");
const recentListEl = $("recentList");

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}
function fmtWhen(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000), h = Math.floor(diff / 3600000), d = Math.floor(diff / 86400000);
  if (m < 1) return "방금 전";
  if (m < 60) return `${m}분 전`;
  if (h < 24) return `${h}시간 전`;
  if (d < 7) return `${d}일 전`;
  return new Date(ts).toLocaleDateString("ko-KR");
}

async function renderRecents() {
  const list = await recentsList();
  recentListEl.innerHTML = "";
  if (list.length === 0) { recentSection.classList.add("hidden"); return; }
  recentSection.classList.remove("hidden");
  for (const m of list) {
    const item = document.createElement("div");
    item.className = "recent-item";

    const thumb = document.createElement("div");
    thumb.className = "recent-thumb";
    thumb.textContent = "📄";

    const info = document.createElement("div");
    info.className = "recent-info";
    const name = document.createElement("div");
    name.className = "recent-name";
    name.textContent = m.name;
    const meta = document.createElement("div");
    meta.className = "recent-meta";
    const pagePart = m.lastPage > 1 ? ` · ${m.lastPage}쪽부터` : "";
    meta.textContent = `${fmtSize(m.size)} · ${fmtWhen(m.savedAt)}${pagePart}${m.tooLarge ? " · 재열기 불가(용량)" : ""}`;
    info.appendChild(name);
    info.appendChild(meta);

    const del = document.createElement("button");
    del.className = "recent-del";
    del.textContent = "✕";
    del.setAttribute("aria-label", "목록에서 삭제");
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      await recentDelete(m.id);
      renderRecents();
    });

    item.appendChild(thumb);
    item.appendChild(info);
    item.appendChild(del);
    item.addEventListener("click", () => {
      if (m.tooLarge) { pickFile(); return; } // 용량 초과분은 다시 선택 유도
      reopenRecent(m.id);
    });
    recentListEl.appendChild(item);
  }
}

// 시작 화면(최근 목록) 표시
function showHome() {
  welcome.classList.remove("hidden");
  renderRecents();
}
$("homeBtn").addEventListener("click", showHome);
$("clearRecentsBtn").addEventListener("click", async () => {
  if (confirm("최근 파일 기록을 모두 지울까요?")) {
    await recentClear();
    renderRecents();
  }
});

// 앱을 벗어나거나 백그라운드로 갈 때 마지막 페이지 확정 저장
window.addEventListener("pagehide", () => {
  if (state.currentFileId) recentUpdatePage(state.currentFileId, state.currentPage);
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && state.currentFileId) recentUpdatePage(state.currentFileId, state.currentPage);
});

// 시작 시 최근 목록 렌더
renderRecents();

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
  scheduleSavePage();
}

// 마지막으로 본 페이지를 최근목록에 저장(디바운스)
let pageSaveTimer = null;
function scheduleSavePage() {
  if (!state.currentFileId) return;
  clearTimeout(pageSaveTimer);
  pageSaveTimer = setTimeout(() => recentUpdatePage(state.currentFileId, state.currentPage), 600);
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
    scheduleSavePage();
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
