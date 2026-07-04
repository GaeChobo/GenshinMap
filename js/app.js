"use strict";

/* =========================================================
 * 내 원신 맵
 * - 지도별 마커/카테고리 데이터는 필요할 때만 로드 (data/markers, data/categories)
 * - 마커는 캔버스로 렌더링 (수천 개도 가볍게)
 * - 원신맵스식: "완료(먹은 것)"는 지도에서 사라짐. 완료/커스텀은 localStorage 저장
 * ========================================================= */

// ===== localStorage =====
const store = {
  get(k, f) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : f; } catch (e) { return f; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
};
const DONE_KEY = "gmap_done_v1";
const CUSTOM_KEY = "gmap_custom_v1";
const HIDDEN_KEY = "gmap_hidden_v3"; // v3: 기본 필터를 워프 지점만 켜기로 변경
const HIDECOMPLETE_KEY = "gmap_hidecomplete_v1";

// ===== 상태 =====
const state = {
  map: null, overlay: null, layer: null,
  currentMapId: null,
  baseMarkers: {},          // mapId -> [marker]
  cats: {},                 // mapId -> { catId: {name, group, color, count} }
  loaded: new Set(),
  custom: store.get(CUSTOM_KEY, []),
  done: store.get(DONE_KEY, {}),
  hidden: {},               // mapId -> Set(catId)  (끈 카테고리)
  hideCompleted: store.get(HIDECOMPLETE_KEY, true),
  admin: false,
  leafletById: {},
  slicesData: {},           // mapId -> { rows, cols, sliceW, sliceH, grid }
  sliceUpdate: null,        // 현재 슬라이스 맵의 갱신 함수
  editingId: null,          // 관리자 모드에서 편집 중인 커스텀 마커 id
};
state.hidden = (() => {
  const raw = store.get(HIDDEN_KEY, {});
  const out = {}; for (const k in raw) out[k] = new Set(raw[k]); return out;
})();
function hiddenSet(mapId) { return state.hidden[mapId] || (state.hidden[mapId] = new Set()); }
function saveHidden() {
  const o = {}; for (const k in state.hidden) o[k] = [...state.hidden[k]]; store.set(HIDDEN_KEY, o);
}

// 데이터 파일이 호출하는 등록 함수
window.registerMarkers = (mapId, arr) => { state.baseMarkers[mapId] = arr; };
window.registerCategories = (mapId, obj) => { state.cats[mapId] = obj; };
window.registerSlices = (mapId, obj) => { state.slicesData[mapId] = obj; };

// ===== 데이터 로딩 =====
function loadScript(src) {
  return new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = src; s.onload = resolve; s.onerror = resolve; document.body.appendChild(s);
  });
}
async function ensureLoaded(mapId) {
  if (state.loaded.has(mapId)) return;
  const def = MAPS_LIST.find((m) => m.id === mapId);
  const loads = [
    loadScript("data/categories/" + mapId + ".js"),
    loadScript("data/markers/" + mapId + ".js"),
  ];
  if (def && def.kind === "slices") loads.push(loadScript("data/slices/" + mapId + ".js"));
  await Promise.all(loads);
  state.baseMarkers[mapId] = state.baseMarkers[mapId] || [];
  state.cats[mapId] = state.cats[mapId] || {};
  state.loaded.add(mapId);
}
function loadImageSize(url) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = rej; img.src = url;
  });
}
function markersFor(mapId) {
  return (state.baseMarkers[mapId] || []).concat(state.custom.filter((m) => m.map === mapId));
}
function catsFor(mapId) { return state.cats[mapId] || {}; }
function catDef(mapId, id) { return catsFor(mapId)[id] || { name: "카테고리 " + id, group: "기타", color: "#b98ce0" }; }
function isCustom(id) { return id[0] === "c"; }

// 리젠(재생성) 자원 그룹: 캐도 다시 생기므로 완료 수집 대상이 아님 → 완료 카운트 제외, 표시만.
const RENEWABLE_GROUPS = new Set(["광물", "적", "낚시", "동물", "지역 특산물", "배낭 / 소재"]);
function isRenewable(mapId, cat) { return RENEWABLE_GROUPS.has(catDef(mapId, cat).group); }

// ===== 지도 =====
// 픽셀 기준 좌표계: 좌상단 원점, y 아래로 증가 (이미지·타일 맵 공통).
// 마커 [lat, lng] = [픽셀y, 픽셀x] = [origin_y + 게임y, origin_x + 게임x]
const CRS_PX = L.extend({}, L.CRS.Simple, { transformation: new L.Transformation(1, 0, 1, 0) });

function initMap() {
  state.map = L.map("map", {
    crs: CRS_PX, minZoom: -8, maxZoom: 6, zoomSnap: 0.25,
    preferCanvas: true, attributionControl: false,
  });
  state.layer = L.layerGroup().addTo(state.map);
  state.map.on("click", (e) => { if (state.admin && !state.editingId) addCustomMarker(e.latlng); });
  state.map.on("moveend", () => {
    if (state.sliceUpdate) state.sliceUpdate(); // 슬라이스 맵: 보이는 조각만 로드
    renderMarkers();                             // 보이는 마커만 다시 그림
  });
}

// 다중 슬라이스 맵: 보이는 조각만 로드 + 줌에 따라 해상도(LOD) 조절(호요랩 CDN 리사이즈)
function sliceUrl(base, lod) {
  return lod ? base + "?x-oss-process=image/resize,w_" + lod : base; // lod=0 → 원본
}
function lodFor(zoom, sliceW) {
  const screenPx = sliceW * Math.pow(2, zoom); // 조각이 화면에 그려질 픽셀 폭
  if (screenPx <= 600) return 512;
  if (screenPx <= 1200) return 1024;
  return 0; // 원본
}
function makeSliceLayer(mapId) {
  const sd = state.slicesData[mapId];
  const group = L.layerGroup();
  let shown = {};
  let curLod = -1;
  state.sliceUpdate = function () {
    if (!sd) return;
    const lod = lodFor(state.map.getZoom(), sd.sliceW);
    if (lod !== curLod) { group.clearLayers(); shown = {}; curLod = lod; } // 해상도 변경 → 다시 로드
    const vb = state.map.getBounds().pad(0.5);
    for (let r = 0; r < sd.rows; r++) for (let c = 0; c < sd.cols; c++) {
      const y0 = r * sd.sliceH, x0 = c * sd.sliceW, key = r + "_" + c;
      const inView = vb.intersects(L.latLngBounds([y0, x0], [y0 + sd.sliceH, x0 + sd.sliceW]));
      if (inView && !shown[key]) {
        shown[key] = L.imageOverlay(sliceUrl(sd.grid[r][c], lod), [[y0, x0], [y0 + sd.sliceH, x0 + sd.sliceW]]).addTo(group);
      } else if (!inView && shown[key]) {
        group.removeLayer(shown[key]); delete shown[key];
      }
    }
  };
  return group;
}

async function selectMap(mapId) {
  const def = MAPS_LIST.find((m) => m.id === mapId);
  if (!def) return;
  state.currentMapId = mapId;

  let w, h;
  if (def.kind === "tiles" || def.kind === "slices") {
    [w, h] = def.size;
    await ensureLoaded(mapId);
  } else {
    const [size] = await Promise.all([loadImageSize(def.image), ensureLoaded(mapId)]);
    w = size.w; h = size.h;
  }
  const bounds = [[0, 0], [h, w]];

  // 기본 필터: 첫 방문 시 "워프 지점" 그룹(워프·신상 등)만 켜고 나머지는 끔 (렌더/이벤트 전에)
  if (!state.hidden[mapId]) {
    const h2 = new Set(), cats = catsFor(mapId);
    for (const id of Object.keys(cats)) if (cats[id].group !== "워프 지점") h2.add(Number(id));
    state.hidden[mapId] = h2;
    saveHidden();
  }

  if (state.overlay) { state.overlay.remove(); state.overlay = null; }
  state.sliceUpdate = null;
  if (def.kind === "tiles") {
    // 호요랩 타일: 표기 N(N{-z}, 다단계 피라미드) 또는 P(P{z}, 최고해상도만) 지원
    const zoomStyle = def.zoomStyle || "P";
    const HoyoTiles = L.TileLayer.extend({
      getTileUrl(coords) {
        const zp = zoomStyle === "N" ? "N" + (-coords.z) : "P" + coords.z;
        return def.tileBase + coords.x + "_" + coords.y + "_" + zp + ".webp";
      },
    });
    state.overlay = new HoyoTiles("", {
      tileSize: 256,
      minZoom: -8, maxZoom: 6,                                    // 레이어 표시 줌 범위(맵과 일치)
      minNativeZoom: def.minNative, maxNativeZoom: def.maxNative, // 실제 타일 존재 줌
      bounds, noWrap: true, updateWhenZooming: false,
    }).addTo(state.map);
  } else if (def.kind === "slices") {
    state.overlay = makeSliceLayer(mapId).addTo(state.map);
  } else {
    state.overlay = L.imageOverlay(def.image, bounds).addTo(state.map);
  }
  state.map.setMaxBounds(L.latLngBounds(bounds).pad(0.5));
  // 콘텐츠(마커) 영역으로 맞춤 — 빈 여백 로딩을 줄이고 화면도 딱 맞음
  state.map.setMinZoom(-8); // 잠시 풀어서 fitBounds가 자유롭게 맞추게
  const list = markersFor(mapId);
  if (list.length) {
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const m of list) { // 스프레드 대신 루프(마커 수만 개 대응)
      if (m.lat < minLat) minLat = m.lat; if (m.lat > maxLat) maxLat = m.lat;
      if (m.lng < minLng) minLng = m.lng; if (m.lng > maxLng) maxLng = m.lng;
    }
    state.map.fitBounds([[minLat, minLng], [maxLat, maxLng]], { padding: [30, 30] });
  } else {
    state.map.fitBounds(bounds);
  }
  // 콘텐츠 전체가 보이는 지점보다 더 축소 못 하게 (원신맵스처럼 대륙이 화면에 꽉 차는 정도까지만)
  state.map.setMinZoom(state.map.getZoom() - 0.5);

  buildAdminCats();
  renderFilters();
  renderMarkers();
  updateStats();
}

// ===== 마커 =====
function markerVisible(m) {
  if (hiddenSet(state.currentMapId).has(m.cat)) return false;
  // 리젠 자원은 완료 개념이 없으므로 "먹은 것 숨기기"의 영향을 받지 않음
  if (state.hideCompleted && state.done[m.id] && !isRenewable(state.currentMapId, m.cat)) return false;
  return true;
}
// 카테고리별 아이콘(호요랩 CDN). 같은 카테고리는 재사용(성능).
const iconCache = {};
function leafIcon(cat) {
  const c = catDef(state.currentMapId, cat);
  const key = c.icon || ("dot:" + c.color);
  if (!iconCache[key]) {
    const inner = c.icon
      ? '<img src="' + c.icon + '" alt="" loading="lazy">'
      : '<span class="mk-dot" style="background:' + c.color + '"></span>';
    iconCache[key] = L.divIcon({
      className: "mk",
      html: '<div class="mk-badge" style="border-color:' + c.color + '">' + inner + "</div>",
      iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -16],
    });
  }
  return iconCache[key];
}
function popupHtml(m) {
  const c = catDef(state.currentMapId, m.cat);
  const done = !!state.done[m.id];
  const title = m.name || c.name;
  const iconImg = c.icon ? '<img class="popup-icon" src="' + c.icon + '" alt="">' : "";
  let h = '<div class="popup-title">' + iconImg + esc(title) + "</div>" +
    '<div class="popup-cat" style="color:' + c.color + '">● ' + esc(c.name) + "</div>";
  if (m.desc) h += '<div class="popup-desc">' + esc(m.desc) + "</div>";
  h += '<div class="popup-actions">';
  if (isRenewable(state.currentMapId, m.cat)) {
    h += '<span class="renew-note">🔄 재생성 자원 (수집 집계 제외)</span>';
  } else {
    h += '<button class="done-btn ' + (done ? "is-done" : "") + '" onclick="__toggleDone(\'' + m.id + '\')">' +
      (done ? "↩ 되돌리기" : "✓ 먹었음") + "</button>";
  }
  if (state.admin && isCustom(m.id)) {
    h += '<button class="edit-btn" onclick="__editCustom(\'' + m.id + '\')">편집</button>';
    h += '<button class="del-btn" onclick="__deleteCustom(\'' + m.id + '\')">삭제</button>';
  }
  return h + "</div>";
}
const MAX_RENDER = 2000;  // 화면에 이보다 많으면 렌더 생략 + "확대" 힌트 (색 점 대신)
function renderMarkers() {
  if (!state.currentMapId) return;
  state.layer.clearLayers();
  state.leafletById = {};
  const b = state.map.getBounds().pad(0.25); // 뷰포트 컬링: 보이는 것만 그림
  const vis = [];
  let overflow = false;
  for (const m of markersFor(state.currentMapId)) {
    if (!markerVisible(m)) continue;
    if (!b.contains([m.lat, m.lng])) continue;
    vis.push(m);
    if (vis.length > MAX_RENDER) { overflow = true; break; }
  }
  const hint = document.getElementById("zoomHint");
  if (hint) hint.classList.toggle("hidden", !overflow);
  if (overflow) return; // 너무 많음: 렌더 생략, 확대 유도 (색 점으로 바꾸지 않음)
  for (const m of vis) { // 항상 아이콘 마커
    const custom = isCustom(m.id);
    const cm = L.marker([m.lat, m.lng], {
      icon: leafIcon(m.cat), opacity: state.done[m.id] ? 0.4 : 1, keyboard: false,
      draggable: state.admin && custom, // 관리자 모드: 커스텀 마커 드래그 이동
    });
    if (state.admin && custom) {
      cm.on("dragend", () => {
        const ll = cm.getLatLng();
        const c = state.custom.find((x) => x.id === m.id);
        if (c) { c.lat = Math.round(ll.lat * 10) / 10; c.lng = Math.round(ll.lng * 10) / 10; store.set(CUSTOM_KEY, state.custom); }
      });
    }
    cm.bindPopup(() => popupHtml(m));
    cm.addTo(state.layer);
    state.leafletById[m.id] = cm;
  }
}

window.__toggleDone = function (id) {
  if (state.done[id]) delete state.done[id]; else state.done[id] = true;
  store.set(DONE_KEY, state.done);
  if (window.Cloud && window.Cloud.enabled) window.Cloud.scheduleSync();
  if (state.hideCompleted) state.map.closePopup();
  renderMarkers();
  updateStats();
};

// ===== 커스텀 마커 (관리자) =====
function addCustomMarker(latlng) {
  const cat = Number(document.getElementById("adminCategory").value);
  const m = {
    id: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    map: state.currentMapId, cat,
    name: document.getElementById("adminName").value.trim(),
    desc: document.getElementById("adminDesc").value.trim(),
    lat: Math.round(latlng.lat * 10) / 10, lng: Math.round(latlng.lng * 10) / 10,
  };
  state.custom.push(m); store.set(CUSTOM_KEY, state.custom);
  document.getElementById("adminName").value = "";
  renderFilters(); renderMarkers(); updateStats();
}
window.__deleteCustom = function (id) {
  state.custom = state.custom.filter((m) => m.id !== id);
  store.set(CUSTOM_KEY, state.custom);
  if (state.editingId === id) cancelEdit();
  state.map.closePopup(); renderFilters(); renderMarkers(); updateStats();
};

// 커스텀 마커 편집: 관리자 패널에 값을 채우고 편집 모드로
window.__editCustom = function (id) {
  const m = state.custom.find((x) => x.id === id);
  if (!m) return;
  state.editingId = id;
  document.getElementById("adminCategory").value = m.cat;
  document.getElementById("adminName").value = m.name || "";
  document.getElementById("adminDesc").value = m.desc || "";
  document.getElementById("adminTitle").textContent = "마커 편집";
  document.getElementById("adminAddHint").classList.add("hidden");
  document.getElementById("adminEditActions").classList.remove("hidden");
  state.map.closePopup();
};
function saveEdit() {
  const m = state.custom.find((x) => x.id === state.editingId);
  if (m) {
    m.cat = Number(document.getElementById("adminCategory").value);
    m.name = document.getElementById("adminName").value.trim();
    m.desc = document.getElementById("adminDesc").value.trim();
    store.set(CUSTOM_KEY, state.custom);
  }
  cancelEdit();
  renderFilters(); renderMarkers(); updateStats();
}
function cancelEdit() {
  state.editingId = null;
  document.getElementById("adminName").value = "";
  document.getElementById("adminDesc").value = "";
  document.getElementById("adminTitle").textContent = "마커 추가";
  document.getElementById("adminAddHint").classList.remove("hidden");
  document.getElementById("adminEditActions").classList.add("hidden");
}

// ===== 필터 (그룹별) =====
function groupsFor(mapId) {
  const cats = catsFor(mapId);
  const present = {};
  for (const m of markersFor(mapId)) present[m.cat] = (present[m.cat] || 0) + 1;
  const groups = {};
  for (const id of Object.keys(present).map(Number)) {
    const c = catDef(mapId, id), g = c.group || "기타";
    (groups[g] = groups[g] || []).push({ id, name: c.name, color: c.color, icon: c.icon, count: present[id] });
  }
  for (const g in groups) groups[g].sort((a, b) => b.count - a.count);
  return groups;
}
function renderFilters() {
  const wrap = document.getElementById("filters");
  wrap.innerHTML = "";
  const groups = groupsFor(state.currentMapId);
  const hidden = hiddenSet(state.currentMapId);

  for (const gName of Object.keys(groups)) {
    const items = groups[gName];
    const total = items.reduce((s, i) => s + i.count, 0);
    const anyOn = items.some((i) => !hidden.has(i.id));

    const gEl = document.createElement("div");
    gEl.className = "grp collapsed" + (RENEWABLE_GROUPS.has(gName) ? " renew" : ""); // 기본 접힘

    const head = document.createElement("div");
    head.className = "grp-head";
    head.setAttribute("role", "button");
    head.setAttribute("aria-expanded", "false");
    const gcb = document.createElement("input");
    gcb.type = "checkbox"; gcb.checked = anyOn;
    gcb.addEventListener("click", (e) => {
      e.stopPropagation();
      if (gcb.checked) items.forEach((i) => hidden.delete(i.id));
      else items.forEach((i) => hidden.add(i.id));
      saveHidden(); renderFilters(); renderMarkers(); updateStats();
    });
    const gtitle = document.createElement("span");
    gtitle.className = "grp-title"; gtitle.textContent = gName;
    const gcount = document.createElement("span");
    gcount.className = "count"; gcount.textContent = total;
    const caret = document.createElement("span");
    caret.className = "caret"; // 화살표는 CSS(.caret::before)가 그림, 회전으로 상태 표시

    head.append(caret, gcb, gtitle, gcount);
    const body = document.createElement("div");
    body.className = "grp-body";
    head.addEventListener("click", () => {
      const collapsed = gEl.classList.toggle("collapsed");
      head.setAttribute("aria-expanded", String(!collapsed));
    });

    for (const it of items) {
      const row = document.createElement("label");
      row.className = "filter-row";
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = !hidden.has(it.id);
      cb.addEventListener("change", () => {
        if (cb.checked) hidden.delete(it.id); else hidden.add(it.id);
        saveHidden(); renderMarkers(); updateStats();
        gcb.checked = items.some((i) => !hidden.has(i.id));
      });
      let mark;
      if (it.icon) {
        mark = document.createElement("img");
        mark.className = "cat-icon"; mark.src = it.icon; mark.loading = "lazy";
        mark.style.borderColor = it.color;
      } else {
        mark = document.createElement("span");
        mark.className = "dot"; mark.style.background = it.color;
      }
      const nm = document.createElement("span"); nm.textContent = it.name;
      const cnt = document.createElement("span"); cnt.className = "count"; cnt.textContent = it.count;
      row.append(cb, mark, nm, cnt);
      body.appendChild(row);
    }
    gEl.append(head, body);
    wrap.appendChild(gEl);
  }
}
function setAllFilters(visible) {
  const hidden = hiddenSet(state.currentMapId);
  if (visible) hidden.clear();
  else for (const m of markersFor(state.currentMapId)) hidden.add(m.cat);
  saveHidden(); renderFilters(); renderMarkers(); updateStats();
}

// ===== 통계 =====
function updateStats() {
  const hidden = hiddenSet(state.currentMapId);
  // 완료 집계는 1회성 수집(상자·눈동자 등)만. 리젠 자원(광물·적 등)은 제외.
  const list = markersFor(state.currentMapId)
    .filter((m) => !hidden.has(m.cat) && !isRenewable(state.currentMapId, m.cat));
  const done = list.filter((m) => state.done[m.id]).length;
  const el = document.getElementById("stats");
  el.textContent = "수집 " + done + " / " + list.length;
  el.style.setProperty("--pct", (list.length ? Math.round((done / list.length) * 100) : 0) + "%");
}

// ===== 관리자 폼 카테고리 =====
function buildAdminCats() {
  const sel = document.getElementById("adminCategory");
  sel.innerHTML = "";
  const groups = groupsFor(state.currentMapId);
  for (const g of Object.keys(groups)) {
    const og = document.createElement("optgroup"); og.label = g;
    for (const it of groups[g]) {
      const o = document.createElement("option"); o.value = it.id; o.textContent = it.name;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
  if (!sel.options.length) {
    const o = document.createElement("option"); o.value = "0"; o.textContent = "기타"; sel.appendChild(o);
  }
}

// ===== 내보내기 =====
function exportMarkers() {
  const id = state.currentMapId;
  const merged = markersFor(id).map((m) => {
    const o = { id: m.id, cat: m.cat, lat: m.lat, lng: m.lng };
    if (m.name) o.name = m.name; if (m.desc) o.desc = m.desc; return o;
  });
  const content = 'registerMarkers("' + id + '", ' + JSON.stringify(merged) + ");\n";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type: "text/javascript" }));
  a.download = id + ".js"; a.click(); URL.revokeObjectURL(a.href);
  alert("다운로드된 " + id + ".js 를 data/markers/ 에 덮어쓰면 저장 완료!\n덮어쓴 뒤 [커스텀 초기화]로 정리하세요.");
}
function clearCustom() {
  const cnt = state.custom.filter((m) => m.map === state.currentMapId).length;
  if (!cnt) return alert("이 지도에 커스텀 마커가 없습니다.");
  if (!confirm("이 지도의 커스텀 마커 " + cnt + "개를 삭제할까요?\n(마커 내보내기로 저장한 뒤에 눌러야 안전)")) return;
  state.custom = state.custom.filter((m) => m.map !== state.currentMapId);
  store.set(CUSTOM_KEY, state.custom);
  renderFilters(); renderMarkers(); updateStats();
}

// ===== 관리자 모드 =====
function toggleAdmin() {
  state.admin = !state.admin;
  if (!state.admin && state.editingId) cancelEdit();
  document.body.classList.toggle("admin", state.admin);
  const at = document.getElementById("adminToggle");
  at.setAttribute("aria-pressed", String(state.admin));
  at.classList.toggle("is-active", state.admin);
  document.getElementById("adminPanel").classList.toggle("hidden", !state.admin);
  document.getElementById("exportBtn").classList.toggle("hidden", !state.admin);
  document.getElementById("clearCustomBtn").classList.toggle("hidden", !state.admin);
  renderMarkers();
}

// ===== 유틸 =====
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ===== 시작 =====
function boot() {
  const sel = document.getElementById("mapSelect");
  for (const m of MAPS_LIST) {
    const o = document.createElement("option"); o.value = m.id; o.textContent = m.name; sel.appendChild(o);
  }
  sel.addEventListener("change", () => selectMap(sel.value));

  const hc = document.getElementById("hideCompleted");
  hc.checked = state.hideCompleted;
  hc.addEventListener("change", () => {
    state.hideCompleted = hc.checked; store.set(HIDECOMPLETE_KEY, hc.checked);
    renderMarkers(); updateStats();
  });

  document.getElementById("adminToggle").addEventListener("click", toggleAdmin);
  document.getElementById("adminSaveEdit").addEventListener("click", saveEdit);
  document.getElementById("adminCancelEdit").addEventListener("click", cancelEdit);
  document.getElementById("exportBtn").addEventListener("click", exportMarkers);
  document.getElementById("clearCustomBtn").addEventListener("click", clearCustom);
  document.getElementById("showAllBtn").addEventListener("click", () => setAllFilters(true));
  document.getElementById("hideAllBtn").addEventListener("click", () => setAllFilters(false));

  initMap();
  selectMap(MAPS_LIST[0].id);
}

// 클라우드 동기화(auth.js)가 사용하는 훅
window.getDone = () => state.done;
window.applyDone = (obj) => {
  state.done = obj || {};
  store.set(DONE_KEY, state.done);
  renderMarkers();
  updateStats();
};

boot();
