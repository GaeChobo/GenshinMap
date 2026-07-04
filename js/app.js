"use strict";

/* =========================================================
 * 내 원신 맵 - 1단계 (정적 버전)
 * - 지도별 마커 데이터는 data/markers/<지도id>.js 에서 필요할 때만 로드
 * - 마커는 캔버스로 렌더링 (수천 개도 가볍게)
 * - 완료 체크 / 커스텀 마커는 localStorage 저장
 * ========================================================= */

// ===== 카테고리 정의 (여기에 추가하면 필터/관리자 폼에 자동 반영) =====
const CATEGORIES = {
  waypoint:  { name: "워프 포인트", color: "#5ba8f5" },
  oculus:    { name: "신의 눈동자", color: "#63e0c8" },
  chest:     { name: "보물상자",    color: "#f0b45a" },
  specialty: { name: "특산물",      color: "#8fd06c" },
  boss:      { name: "필드 보스",   color: "#e06666" },
  etc:       { name: "기타",        color: "#b98ce0" },
};

// ===== localStorage 헬퍼 =====
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) { return fallback; }
  },
  set(key, value) { localStorage.setItem(key, JSON.stringify(value)); },
};

const DONE_KEY = "gmap_done_v1";
const CUSTOM_KEY = "gmap_custom_v1";
const HIDDEN_KEY = "gmap_hidden_v1";

// ===== 상태 =====
const state = {
  map: null,
  overlay: null,
  layer: null,
  currentMapId: null,
  baseMarkers: {},          // mapId -> [marker]
  loadedFiles: new Set(),   // 이미 로드한 마커 파일
  custom: store.get(CUSTOM_KEY, []),
  done: store.get(DONE_KEY, {}),
  hiddenCats: new Set(store.get(HIDDEN_KEY, [])),
  admin: false,
  leafletById: {},          // markerId -> L.CircleMarker
};

// 마커 데이터 파일이 호출하는 등록 함수
window.registerMarkers = function (mapId, markers) {
  state.baseMarkers[mapId] = markers;
};

// ===== 데이터 로딩 =====
function ensureMarkersLoaded(mapId) {
  return new Promise((resolve) => {
    if (state.loadedFiles.has(mapId)) return resolve();
    const s = document.createElement("script");
    s.src = "data/markers/" + mapId + ".js";
    s.onload = () => { state.loadedFiles.add(mapId); resolve(); };
    s.onerror = () => { // 파일이 없으면 빈 지도로 시작 (새 지도 추가 직후 상태)
      state.baseMarkers[mapId] = state.baseMarkers[mapId] || [];
      state.loadedFiles.add(mapId);
      resolve();
    };
    document.body.appendChild(s);
  });
}

function loadImageSize(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = reject;
    img.src = url;
  });
}

function markersFor(mapId) {
  const base = state.baseMarkers[mapId] || [];
  const custom = state.custom.filter((m) => m.map === mapId);
  return base.concat(custom);
}

function isCustom(id) {
  return state.custom.some((m) => m.id === id);
}

// ===== 지도 =====
function initMap() {
  state.map = L.map("map", {
    crs: L.CRS.Simple,
    minZoom: -3,
    maxZoom: 3,
    zoomSnap: 0.25,
    preferCanvas: true, // 캔버스 렌더링: 마커가 많아져도 가벼움
    attributionControl: false,
  });
  state.layer = L.layerGroup().addTo(state.map);

  state.map.on("click", (e) => {
    if (state.admin) addCustomMarker(e.latlng);
  });
}

async function selectMap(mapId) {
  const def = MAPS_LIST.find((m) => m.id === mapId);
  if (!def) return;
  state.currentMapId = mapId;

  const [size] = await Promise.all([
    loadImageSize(def.image),
    ensureMarkersLoaded(mapId),
  ]);

  const bounds = [[0, 0], [size.h, size.w]];
  if (state.overlay) state.overlay.remove();
  state.overlay = L.imageOverlay(def.image, bounds).addTo(state.map);
  state.map.setMaxBounds(L.latLngBounds(bounds).pad(0.3));
  state.map.fitBounds(bounds);

  renderMarkers();
  renderFilters();
  updateStats();
}

// ===== 마커 렌더링 =====
function markerStyle(m) {
  const cat = CATEGORIES[m.category] || CATEGORIES.etc;
  const done = !!state.done[m.id];
  return {
    radius: 8,
    fillColor: cat.color,
    fillOpacity: done ? 0.25 : 0.9,
    color: done ? "#888" : "#ffffff",
    weight: 2,
    opacity: done ? 0.4 : 1,
  };
}

function popupHtml(m) {
  const cat = CATEGORIES[m.category] || CATEGORIES.etc;
  const done = !!state.done[m.id];
  let html =
    '<div class="popup-title">' + escapeHtml(m.name) + "</div>" +
    '<div class="popup-cat" style="color:' + cat.color + '">● ' + cat.name + "</div>";
  if (m.desc) html += '<div class="popup-desc">' + escapeHtml(m.desc) + "</div>";
  html += '<div class="popup-actions">';
  html +=
    '<button class="done-btn ' + (done ? "is-done" : "") + '" onclick="__toggleDone(\'' + m.id + '\')">' +
    (done ? "✓ 완료됨" : "완료 체크") + "</button>";
  if (state.admin && isCustom(m.id)) {
    html += '<button class="del-btn" onclick="__deleteCustom(\'' + m.id + '\')">삭제</button>';
  }
  html += "</div>";
  return html;
}

function renderMarkers() {
  state.layer.clearLayers();
  state.leafletById = {};
  const list = markersFor(state.currentMapId);
  for (const m of list) {
    if (state.hiddenCats.has(m.category)) continue;
    const cm = L.circleMarker([m.lat, m.lng], markerStyle(m));
    cm.bindPopup(() => popupHtml(m));
    cm.addTo(state.layer);
    state.leafletById[m.id] = cm;
  }
}

// ===== 완료 체크 =====
window.__toggleDone = function (id) {
  if (state.done[id]) delete state.done[id];
  else state.done[id] = true;
  store.set(DONE_KEY, state.done);

  const cm = state.leafletById[id];
  const m = markersFor(state.currentMapId).find((x) => x.id === id);
  if (cm && m) {
    cm.setStyle(markerStyle(m));
    cm.setPopupContent(popupHtml(m));
  }
  updateStats();
};

// ===== 커스텀 마커 (관리자 모드) =====
function addCustomMarker(latlng) {
  const category = document.getElementById("adminCategory").value;
  const nameInput = document.getElementById("adminName");
  const descInput = document.getElementById("adminDesc");

  const catDef = CATEGORIES[category];
  const count = markersFor(state.currentMapId).filter((m) => m.category === category).length;
  const name = nameInput.value.trim() || catDef.name + " " + (count + 1);

  const marker = {
    id: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    map: state.currentMapId,
    category: category,
    name: name,
    desc: descInput.value.trim(),
    lat: Math.round(latlng.lat),
    lng: Math.round(latlng.lng),
  };
  state.custom.push(marker);
  store.set(CUSTOM_KEY, state.custom);
  nameInput.value = "";

  renderMarkers();
  renderFilters();
  updateStats();
}

window.__deleteCustom = function (id) {
  state.custom = state.custom.filter((m) => m.id !== id);
  store.set(CUSTOM_KEY, state.custom);
  state.map.closePopup();
  renderMarkers();
  renderFilters();
  updateStats();
};

// ===== 필터 =====
function renderFilters() {
  const wrap = document.getElementById("filters");
  wrap.innerHTML = "";
  const list = markersFor(state.currentMapId);

  for (const key of Object.keys(CATEGORIES)) {
    const cat = CATEGORIES[key];
    const count = list.filter((m) => m.category === key).length;
    if (count === 0) continue;

    const row = document.createElement("label");
    row.className = "filter-row";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !state.hiddenCats.has(key);
    cb.addEventListener("change", () => {
      if (cb.checked) state.hiddenCats.delete(key);
      else state.hiddenCats.add(key);
      store.set(HIDDEN_KEY, [...state.hiddenCats]);
      renderMarkers();
      updateStats();
    });

    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = cat.color;

    const label = document.createElement("span");
    label.textContent = cat.name;

    const cnt = document.createElement("span");
    cnt.className = "count";
    cnt.textContent = count;

    row.append(cb, dot, label, cnt);
    wrap.appendChild(row);
  }
}

function setAllFilters(visible) {
  if (visible) state.hiddenCats.clear();
  else Object.keys(CATEGORIES).forEach((k) => state.hiddenCats.add(k));
  store.set(HIDDEN_KEY, [...state.hiddenCats]);
  renderFilters();
  renderMarkers();
  updateStats();
}

// ===== 통계 =====
function updateStats() {
  const list = markersFor(state.currentMapId).filter((m) => !state.hiddenCats.has(m.category));
  const done = list.filter((m) => state.done[m.id]).length;
  document.getElementById("stats").textContent = "완료 " + done + " / " + list.length;
}

// ===== 내보내기 =====
function exportMarkers() {
  const mapId = state.currentMapId;
  const merged = markersFor(mapId).map((m) => ({
    id: m.id,
    category: m.category,
    name: m.name,
    desc: m.desc || "",
    lat: m.lat,
    lng: m.lng,
  }));
  const content = 'registerMarkers("' + mapId + '", ' + JSON.stringify(merged, null, 2) + ");\n";
  const blob = new Blob([content], { type: "text/javascript" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = mapId + ".js";
  a.click();
  URL.revokeObjectURL(a.href);
  alert(
    "다운로드된 " + mapId + ".js 파일을\ndata/markers/ 폴더에 덮어쓰면 저장 완료!\n" +
    "덮어쓴 뒤에는 [커스텀 초기화]를 눌러 중복을 정리하세요."
  );
}

function clearCustom() {
  const cnt = state.custom.filter((m) => m.map === state.currentMapId).length;
  if (cnt === 0) { alert("이 지도에 커스텀 마커가 없습니다."); return; }
  if (!confirm("이 지도의 커스텀 마커 " + cnt + "개를 삭제할까요?\n(마커 내보내기로 파일에 저장한 뒤에 눌러야 안전합니다)")) return;
  state.custom = state.custom.filter((m) => m.map !== state.currentMapId);
  store.set(CUSTOM_KEY, state.custom);
  renderMarkers();
  renderFilters();
  updateStats();
}

// ===== 관리자 모드 =====
function toggleAdmin() {
  state.admin = !state.admin;
  document.body.classList.toggle("admin", state.admin);
  document.getElementById("adminPanel").classList.toggle("hidden", !state.admin);
  document.getElementById("exportBtn").classList.toggle("hidden", !state.admin);
  document.getElementById("clearCustomBtn").classList.toggle("hidden", !state.admin);
  renderMarkers(); // 팝업의 삭제 버튼 표시 갱신
}

// ===== 유틸 =====
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ===== 시작 =====
function boot() {
  // 지도 선택 드롭다운
  const sel = document.getElementById("mapSelect");
  for (const m of MAPS_LIST) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.name;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", () => selectMap(sel.value));

  // 관리자 폼 카테고리
  const catSel = document.getElementById("adminCategory");
  for (const key of Object.keys(CATEGORIES)) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = CATEGORIES[key].name;
    catSel.appendChild(opt);
  }

  document.getElementById("adminToggle").addEventListener("click", toggleAdmin);
  document.getElementById("exportBtn").addEventListener("click", exportMarkers);
  document.getElementById("clearCustomBtn").addEventListener("click", clearCustom);
  document.getElementById("showAllBtn").addEventListener("click", () => setAllFilters(true));
  document.getElementById("hideAllBtn").addEventListener("click", () => setAllFilters(false));

  initMap();
  selectMap(MAPS_LIST[0].id);
}

boot();
