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
const AREA_KEY = "gmap_area_v1"; // 지도별 선택된 지역(나라). 0 = 전체
const LEVEL_KEY = "gmap_level_v1"; // 지도별 지상/지하 필터. all | surface | under

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
  ugLayer: null,            // 지하 오버레이 이미지 레이어
  ugUpdate: null,           // 지하 오버레이 갱신(뷰포트 컬링) 함수
  editingId: null,          // 관리자 모드에서 편집 중인 커스텀 마커 id
  areaSel: store.get(AREA_KEY, {}), // mapId -> 선택된 area_id (0/없음 = 전체)
  levelSel: store.get(LEVEL_KEY, {}), // mapId -> "all" | "surface" | "under"
  floors: {},               // mapId -> { floorId: 층이름 } (지하)
  active: [],               // 현재 지도+지역+층의 렌더 대상 마커 캐시 (moveend 성능)
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
window.registerFloors = (mapId, obj) => { state.floors[mapId] = obj; };

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
  loads.push(loadScript("data/floors/" + mapId + ".js")); // 지하 층 정보(없으면 무시)
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
// ===== 지역(나라) =====
// teyvat처럼 areas가 있는 지도는 나라별로 나눠서 보여줌. 마커의 m.a(area_id) 기준.
function mapAreas(mapId) {
  const d = MAPS_LIST.find((m) => m.id === mapId);
  return d && d.areas && d.areas.length ? d.areas : null;
}
function currentArea() {
  if (!mapAreas(state.currentMapId)) return 0;
  return state.areaSel[state.currentMapId] || 0; // 0 = 전체
}
// 현재 선택 지역에 속하는가 (전체면 항상 true, 커스텀 마커는 지역 무관하게 항상 표시)
function inArea(m) {
  const a = currentArea();
  if (!a) return true;
  return m.a === a || isCustom(m.id);
}
// 특정 지역(또는 전체)의 마커 목록 — fitBounds/집계용 (커스텀 제외해도 무방)
function areaMarkers(mapId) {
  const a = state.areaSel[mapId] || 0;
  const all = markersFor(mapId);
  return a ? all.filter((m) => m.a === a) : all;
}
// ===== 지상/지하 (층) =====
// 마커에 m.f(floor_id)가 있으면 지하(해당 층 이름), 없으면 지상.
function isUnderground(m) { return m.f != null; }
function floorEntry(mapId, f) { return (state.floors[mapId] || {})[f] || null; }
function floorName(mapId, f) { const e = floorEntry(mapId, f); return (e && e.n) || "지하"; }
function hasUnderground(mapId) {
  const fl = state.floors[mapId];
  return !!(fl && Object.keys(fl).length);
}
function currentLevel(mapId) { return state.levelSel[mapId] || "all"; } // all|surface|under
function passLevel(mapId, m) {
  const lv = currentLevel(mapId);
  if (lv === "all") return true;
  return lv === "under" ? isUnderground(m) : !isUnderground(m);
}

// 렌더 대상 캐시 재빌드 — 지도/지역/층/커스텀이 바뀔 때만 호출.
// (moveend마다 8만개 전체를 순회하면 끊김 → 선택 조건 통과 마커만 미리 걸러둠)
function rebuildActive() {
  const mapId = state.currentMapId;
  if (!mapId) { state.active = []; return; }
  const a = currentArea();
  const base = state.baseMarkers[mapId] || [];
  const cust = state.custom.filter((m) => m.map === mapId);
  const pass = (m) => (!a || m.a === a) && passLevel(mapId, m);
  state.active = base.filter(pass).concat(cust); // 커스텀은 지역/층 무관하게 항상 표시
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
    if (state.ugUpdate) state.ugUpdate();       // 지하 모드: 보이는 지하 오버레이만 로드
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

// 지하 오버레이 레이어 — "지하" 필터일 때만, 보이는 층 이미지만 로드(뷰포트 컬링).
// floors[fid].o = [url, top(lat), left(lng), bottom(lat), right(lng)] (픽셀좌표)
function makeUndergroundLayer(mapId) {
  const floors = state.floors[mapId] || {};
  const group = L.layerGroup();
  const shown = {};
  state.ugUpdate = function () {
    const on = currentLevel(mapId) === "under";
    document.getElementById("map").classList.toggle("ug-mode", on); // 지상 타일 흐리게
    if (!on) { if (Object.keys(shown).length) { group.clearLayers(); for (const k in shown) delete shown[k]; } return; }
    const vb = state.map.getBounds().pad(0.5);
    for (const fid in floors) {
      const o = floors[fid].o; if (!o) continue;
      const b = L.latLngBounds([o[1], o[2]], [o[3], o[4]]);
      const inView = vb.intersects(b);
      if (inView && !shown[fid]) shown[fid] = L.imageOverlay(o[0], b).addTo(group);
      else if (!inView && shown[fid]) { group.removeLayer(shown[fid]); delete shown[fid]; }
    }
  };
  return group;
}

// 지역(나라) 선택 드롭다운 채우기 — areas 있는 지도만 표시
function populateAreaSelect(mapId) {
  const sel = document.getElementById("areaSelect");
  const areas = mapAreas(mapId);
  if (!areas) { sel.classList.add("hidden"); sel.innerHTML = ""; return; }
  // 첫 방문 시 기본값 = 첫 나라 (호요랩처럼). 이미 고른 값이 있으면 유지.
  if (!(mapId in state.areaSel)) { state.areaSel[mapId] = areas[0].id; store.set(AREA_KEY, state.areaSel); }
  sel.innerHTML = "";
  const optAll = document.createElement("option");
  optAll.value = "0"; optAll.textContent = "🗺 전체";
  sel.appendChild(optAll);
  for (const a of areas) {
    const o = document.createElement("option"); o.value = a.id; o.textContent = a.name; sel.appendChild(o);
  }
  sel.value = String(state.areaSel[mapId] || 0);
  sel.classList.remove("hidden");
}
// 지상/지하 필터 UI — 지하 마커가 있는 지도에서만 표시
function renderLevelFilter(mapId) {
  const el = document.getElementById("levelFilter");
  if (!el) return;
  if (!hasUnderground(mapId)) { el.classList.add("hidden"); return; }
  const cur = currentLevel(mapId);
  for (const btn of el.querySelectorAll("button"))
    btn.classList.toggle("active", btn.dataset.level === cur);
  el.classList.remove("hidden");
}

// 선택 지역으로 화면 맞춤 (minZoom은 대륙 기준 유지 → 언제든 축소 가능)
function fitToArea() {
  const mapId = state.currentMapId;
  const a = state.areaSel[mapId] || 0;
  const list = areaMarkers(mapId);
  if (!list.length) return;
  let bb;
  if (a) {
    // 특정 나라: 멀리 떨어진 소수 이상치(예: 폰타인 남쪽)에 화면이 끌려가지 않도록
    // 상·하위 2%를 잘라낸 밀집 구역에 초점을 맞춘다.
    const lats = list.map((m) => m.lat).sort((x, y) => x - y);
    const lngs = list.map((m) => m.lng).sort((x, y) => x - y);
    const q = (arr, p) => arr[Math.floor((arr.length - 1) * p)];
    bb = [[q(lats, 0.02), q(lngs, 0.02)], [q(lats, 0.98), q(lngs, 0.98)]];
  } else {
    // 전체: 대륙 전체가 보이게
    let mnLat = Infinity, mxLat = -Infinity, mnLng = Infinity, mxLng = -Infinity;
    for (const m of list) {
      if (m.lat < mnLat) mnLat = m.lat; if (m.lat > mxLat) mxLat = m.lat;
      if (m.lng < mnLng) mnLng = m.lng; if (m.lng > mxLng) mxLng = m.lng;
    }
    bb = [[mnLat, mnLng], [mxLat, mxLng]];
  }
  state.map.fitBounds(bb, { padding: [30, 30] });
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
  populateAreaSelect(mapId); // 지역 선택기(기본 나라 설정 포함) — 필터/렌더 전에
  renderLevelFilter(mapId);  // 지상/지하 필터 (지하 있는 지도만 표시)
  rebuildActive();           // 렌더 캐시 — fitBounds가 유발하는 moveend 렌더 전에 준비

  if (state.overlay) { state.overlay.remove(); state.overlay = null; }
  if (state.ugLayer) { state.ugLayer.remove(); state.ugLayer = null; }
  state.sliceUpdate = null; state.ugUpdate = null;
  document.getElementById("map").classList.remove("ug-mode");
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
      keepBuffer: 4,          // 화면 밖 타일을 더 유지 → 팬할 때 타일 재로딩(끊김) 감소
    }).addTo(state.map);
  } else if (def.kind === "slices") {
    state.overlay = makeSliceLayer(mapId).addTo(state.map);
  } else {
    state.overlay = L.imageOverlay(def.image, bounds).addTo(state.map);
  }
  // 지하 오버레이 레이어(지하 있는 지도만) — 타일 위, 마커 아래
  if (hasUnderground(mapId)) state.ugLayer = makeUndergroundLayer(mapId).addTo(state.map);
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
  if (currentArea()) fitToArea(); // 특정 나라 선택 시 그 지역으로 초점 (축소는 대륙까지 가능)

  buildAdminCats();
  renderFilters();
  renderMarkers();
  updateStats();
  if (state.ugUpdate) state.ugUpdate(); // 지하 모드로 시작한 경우 오버레이 표시
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
function leafIcon(cat, underground) {
  const c = catDef(state.currentMapId, cat);
  const key = (c.icon || ("dot:" + c.color)) + (underground ? "|ug" : "");
  if (!iconCache[key]) {
    const inner = c.icon
      ? '<img src="' + c.icon + '" alt="" loading="lazy">'
      : '<span class="mk-dot" style="background:' + c.color + '"></span>';
    // 지하 마커는 물방울 배지에 지하 표식(🔻)을 덧붙여 한눈에 구분
    const ugMark = underground ? '<span class="mk-ug" title="지하">▼</span>' : "";
    iconCache[key] = L.divIcon({
      className: "mk pin-precise" + (underground ? " is-under" : ""), // 물방울 끝이 정확한 좌표를 가리킴
      html: '<div class="mk-badge" style="border-color:' + c.color + '">' + inner + ugMark + "</div>",
      iconSize: [30, 38], iconAnchor: [15, 38], popupAnchor: [0, -34],
    });
  }
  return iconCache[key];
}
// 클러스터 아이콘 — 링(conic-gradient)이 수집비율, 중앙에 개수 (디자인 v2)
function clusterIcon(cat, total, done, collectible) {
  const c = catDef(state.currentMapId, cat);
  const ratio = collectible && total ? done / total : 0;
  const complete = collectible && done === total;
  const size = total <= 5 ? "sm" : total <= 30 ? "md" : "lg";
  const px = size === "sm" ? 32 : size === "lg" ? 50 : 40;
  return L.divIcon({
    className: "mk-cluster-host",
    html: '<div class="mk-cluster ' + size + (complete ? " done" : "") +
      '" style="--ratio:' + ratio.toFixed(3) + ";--ring:" + c.color + '">' +
      '<span class="mk-cluster-inner"><b class="mk-cluster-count">' + total + "</b></span></div>",
    iconSize: [px, px], iconAnchor: [px / 2, px / 2], popupAnchor: [0, -px / 2],
  });
}
function popupHtml(m) {
  const c = catDef(state.currentMapId, m.cat);
  const done = !!state.done[m.id];
  const title = m.name || c.name;
  const iconImg = c.icon ? '<img class="popup-icon" src="' + c.icon + '" alt="">' : "";
  let h = '<div class="popup-title">' + iconImg + esc(title) + "</div>" +
    '<div class="popup-cat" style="color:' + c.color + '">● ' + esc(c.name) + "</div>";
  // 지상/지하 표시
  if (isUnderground(m)) {
    h += '<div class="popup-level under">🔻 지하 · ' + esc(floorName(state.currentMapId, m.f)) + "</div>";
  } else if (hasUnderground(state.currentMapId)) {
    h += '<div class="popup-level surface">🔼 지상</div>';
  }
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
const CLUSTER_CELL = 46;   // 클러스터 격자 크기(화면 픽셀). 이 안의 같은 카테고리는 묶임
const CLUSTER_CAP = 15000; // 화면에 이보다 많으면 렌더 생략 + "확대" 힌트 (안전장치)

function addIndividual(m) {
  const custom = isCustom(m.id);
  const cm = L.marker([m.lat, m.lng], {
    icon: leafIcon(m.cat, isUnderground(m)), opacity: state.done[m.id] ? 0.4 : 1, keyboard: false,
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

function renderMarkers() {
  if (!state.currentMapId) return;
  state.layer.clearLayers();
  state.leafletById = {};
  const zoom = state.map.getZoom();
  const b = state.map.getBounds().pad(0.25); // 뷰포트 컬링: 보이는 것만 처리

  // 보이는 마커를 화면 격자(카테고리별)로 묶기 (수집/전체 계산 위해 완료 마커도 그룹에 포함)
  const hidden = hiddenSet(state.currentMapId);
  const cells = new Map();
  let count = 0;
  for (const m of state.active) {                   // 지역 필터는 캐시(state.active)에서 이미 처리
    if (hidden.has(m.cat)) continue;               // 카테고리 필터만(완료는 그룹 계산에 포함)
    if (!b.contains([m.lat, m.lng])) continue;
    if (++count > CLUSTER_CAP) break;
    const pt = state.map.project([m.lat, m.lng], zoom);
    const key = m.cat + ":" + Math.floor(pt.x / CLUSTER_CELL) + ":" + Math.floor(pt.y / CLUSTER_CELL);
    let cell = cells.get(key);
    if (!cell) { cell = { cat: m.cat, items: [], sx: 0, sy: 0, done: 0 }; cells.set(key, cell); }
    cell.items.push(m); cell.sx += m.lng; cell.sy += m.lat;
    if (state.done[m.id]) cell.done++;
  }

  const hint = document.getElementById("zoomHint");
  if (count > CLUSTER_CAP) { if (hint) hint.classList.remove("hidden"); return; }
  if (hint) hint.classList.add("hidden");

  for (const cell of cells.values()) {
    const total = cell.items.length;
    const collectible = !isRenewable(state.currentMapId, cell.cat);
    if (total === 1) {
      const m = cell.items[0];
      if (state.hideCompleted && collectible && state.done[m.id]) continue; // 완료 개별은 숨김
      addIndividual(m);
      continue;
    }
    // 완료 클러스터는 "먹은 것 숨기기" 시 숨김 (리젠 자원은 완료 개념 없음)
    if (state.hideCompleted && collectible && cell.done === total) continue;
    const lat = cell.sy / total, lng = cell.sx / total;
    const cm = L.marker([lat, lng], {
      icon: clusterIcon(cell.cat, total, cell.done, collectible), keyboard: false,
    });
    cm.on("click", () => state.map.setView([lat, lng], Math.min(zoom + 2, state.map.getMaxZoom())));
    cm.addTo(state.layer);
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
  rebuildActive(); renderFilters(); renderMarkers(); updateStats();
}
window.__deleteCustom = function (id) {
  state.custom = state.custom.filter((m) => m.id !== id);
  store.set(CUSTOM_KEY, state.custom);
  if (state.editingId === id) cancelEdit();
  state.map.closePopup(); rebuildActive(); renderFilters(); renderMarkers(); updateStats();
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
  const cur = mapId === state.currentMapId; // 현재 지도면 선택 지역/층만 집계
  const a = cur ? currentArea() : 0;
  for (const m of markersFor(mapId)) {
    if (isCustom(m.id)) { present[m.cat] = (present[m.cat] || 0) + 1; continue; }
    if (a && m.a !== a) continue;
    if (cur && !passLevel(mapId, m)) continue;
    present[m.cat] = (present[m.cat] || 0) + 1;
  }
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
    .filter((m) => inArea(m) && passLevel(state.currentMapId, m) && !hidden.has(m.cat) && !isRenewable(state.currentMapId, m.cat));
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
  rebuildActive(); renderFilters(); renderMarkers(); updateStats();
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

  document.getElementById("areaSelect").addEventListener("change", (e) => {
    state.areaSel[state.currentMapId] = Number(e.target.value);
    store.set(AREA_KEY, state.areaSel);
    rebuildActive();
    fitToArea();
    renderFilters(); renderMarkers(); updateStats();
  });

  document.getElementById("levelFilter").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-level]");
    if (!btn) return;
    state.levelSel[state.currentMapId] = btn.dataset.level;
    store.set(LEVEL_KEY, state.levelSel);
    renderLevelFilter(state.currentMapId);
    rebuildActive();
    if (state.ugUpdate) state.ugUpdate(); // 지하 오버레이 표시/숨김 + 지상 타일 흐리게
    renderFilters(); renderMarkers(); updateStats();
  });

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
