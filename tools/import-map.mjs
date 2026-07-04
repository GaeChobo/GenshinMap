// HoYoLAB 공식 인터랙티브 맵 → 우리 로컬 맵으로 가져오는 임포터 (이미지/타일 맵 모두 지원)
//
// 사용법:  node tools/import-map.mjs <map_id> <우리_id> "표시이름"
//   예:    node tools/import-map.mjs 7  enkanomiya "연하궁"        (이미지 맵)
//          node tools/import-map.mjs 40 frostmoon  "서리달"        (타일 맵)
//
// 좌표계: 모든 맵을 "픽셀 기준(좌상단 원점, y 아래로 증가)"으로 통일.
//   마커 픽셀 = origin + 게임좌표  →  Leaflet [lat=픽셀y, lng=픽셀x]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const [, , mapIdArg, localId, displayName] = process.argv;
if (!mapIdArg || !localId) {
  console.error('사용법: node tools/import-map.mjs <map_id> <우리_id> "표시이름"');
  process.exit(1);
}
const mapId = Number(mapIdArg);
const name = displayName || localId;

const H = { "x-rpc-app_version": "", "x-rpc-client_type": "4", "User-Agent": "Mozilla/5.0" };
const S = "https://sg-public-api-static.hoyolab.com/common/map_user/ys_obc";
const TILE_CDN = "https://act-webstatic.hoyoverse.com/map_manage/map";

async function api(ver, pathname, extra = "") {
  const r = await fetch(`${S}/${ver}/map/${pathname}?map_id=${mapId}&app_sn=ys_obc&lang=ko-kr${extra}`, { headers: H });
  const j = await r.json();
  if (j.retcode !== 0) throw new Error(`${pathname} 실패: ${j.retcode} ${j.message}`);
  return j.data;
}

// 라벨 트리(v1/v2 구조 모두) → { id: {name, group, icon} } 로 평탄화
function flattenLabels(tree, out, group) {
  for (const node of tree || []) {
    const g = group || node.name;
    if (node.id != null && node.name && !(node.children && node.children.length))
      out[node.id] = { name: node.name, group: g, icon: node.icon || "" };
    if (node.children && node.children.length) flattenLabels(node.children, out, g);
    else if (node.id != null && node.name) out[node.id] = out[node.id] || { name: node.name, group: g, icon: node.icon || "" };
  }
  return out;
}

// 그룹 이름 보정: 호요랩 "퍼즐 보물상자"(실은 상자를 여는 퍼즐/장치)를 "상자 기믹"으로 표기
const GROUP_RENAME = { "퍼즐 보물상자": "상자 기믹" };

const PALETTE = [
  "#5ba8f5", "#63e0c8", "#f0b45a", "#8fd06c", "#e06666", "#b98ce0",
  "#f58fb4", "#7ad4e0", "#d0c85a", "#8c9ee0", "#e0925a", "#6cd0a0",
  "#e0d76c", "#c86cd0", "#6ce0d0", "#e06c9e", "#a0d06c", "#6c8ce0",
];

(async () => {
  console.log(`▶ map_id=${mapId} 가져오는 중...`);
  const info = (await api("v1", "info")).info;
  const v2 = info.detail_v2;
  // 현행 타일(detail_v2)이 있으면 그걸 우선 사용 (map/2처럼 구 이미지+신 타일 공존 시)
  const useTiles = v2 && v2.map_version && Array.isArray(v2.total_size) && v2.total_size.length === 2;

  async function headOk(u) { try { return (await fetch(u, { method: "HEAD", headers: H })).status === 200; } catch (e) { return false; } }

  let origin, mapEntry, imgNote = "";
  if (useTiles) {
    // ── 타일 맵 (호요랩 CDN 핫링크) ──
    const [w, h] = v2.total_size;
    origin = v2.origin;
    const base = `${TILE_CDN}/${mapId}/${v2.map_version}/`;
    const minz = v2.min_zoom || 0, maxz = v2.max_zoom || 0;
    const [ox0, oy0] = origin;
    // 레벨 L(≤0)에서 원점 근처에 실제 타일이 있는지
    async function existsAt(style, L) {
      const tw = 256 * Math.pow(2, -L);        // L<=0 → 타일이 덮는 픽셀 폭
      const cx = Math.floor(ox0 / tw), cy = Math.floor(oy0 / tw);
      for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
        const x = cx + dx, y = cy + dy; if (x < 0 || y < 0) continue;
        const zp = style === "N" ? "N" + (-L) : "P" + L;
        if (await headOk(`${base}${x}_${y}_${zp}.webp`)) return true;
      }
      return false;
    }
    // 표기 감지(N 우선)
    let zoomStyle = (await existsAt("N", minz)) || (await existsAt("N", maxz)) ? "N" : "P";
    // 실제 존재하는 네이티브 레벨 범위
    const levels = [];
    for (let L = maxz; L >= minz; L--) if (await existsAt(zoomStyle, L)) levels.push(L);
    const maxNative = levels.length ? Math.max(...levels) : 0;
    const minNative = levels.length ? Math.min(...levels) : 0;
    console.log(`  타일 맵 ${w}x${h}, origin [${origin}], 표기 ${zoomStyle}, 네이티브 ${minNative}..${maxNative}`);
    mapEntry =
      `{ id: "${localId}", name: "${name}", kind: "tiles",\n` +
      `    tileBase: "${base}", zoomStyle: "${zoomStyle}",\n` +
      `    size: [${w}, ${h}], minNative: ${minNative}, maxNative: ${maxNative} }`;
  } else {
    // ── 이미지 맵 ──
    const d = JSON.parse(info.detail);
    const [w, h] = d.total_size;
    origin = d.origin;
    const rows = d.slices.length, cols = d.slices[0].length;
    console.log(`  이미지 맵 ${w}x${h}, origin [${origin}], 슬라이스 ${rows}x${cols}`);
    if (rows === 1 && cols === 1) {
      const url = d.slices[0][0].url;
      const ext = path.extname(new URL(url).pathname) || ".jpeg";
      const file = `maps/${localId}${ext}`;
      const buf = Buffer.from(await (await fetch(url, { headers: H })).arrayBuffer());
      fs.writeFileSync(path.join(ROOT, file), buf);
      console.log(`  이미지 저장 → ${file} (${(buf.length / 1e6).toFixed(1)}MB)`);
      mapEntry = `{ id: "${localId}", name: "${name}", image: "${file}", size: [${w}, ${h}] }`;
    } else {
      const grid = d.slices.map((row) => row.map((s) => s.url));
      fs.writeFileSync(path.join(ROOT, `data/slices/${localId}.js`),
        `registerSlices("${localId}", ${JSON.stringify({ rows, cols, sliceW: w / cols, sliceH: h / rows, grid })});\n`);
      console.log(`  슬라이스 ${rows}x${cols} → data/slices/${localId}.js (핫링크)`);
      mapEntry = `{ id: "${localId}", name: "${name}", kind: "slices", size: [${w}, ${h}] }`;
    }
  }

  // ── 카테고리(라벨) ──
  const labelMeta = {};
  try { flattenLabels((await api("v1", "label/tree")).tree, labelMeta); } catch (e) {}
  try { flattenLabels((await api("v2", "label/tree")).tree, labelMeta); } catch (e) {}

  // ── 지하 층(floor) 메타 ── point_group: 각 지하층 이름 + 그 층에 속한 point_ids
  const floorReg = {};       // floor_id -> 층 이름
  const pointToFloor = new Map(); // point_id -> floor_id (지하)
  try {
    for (const g of ((await api("v2", "point_group")).list || [])) {
      for (const f of (g.floors || [])) {
        floorReg[f.id] = f.floor_name || ("층 " + f.id);
        for (const pid of (f.point_ids || [])) pointToFloor.set(pid, f.id);
      }
    }
  } catch (e) {}

  // ── 마커(포인트) ── point/list 는 이미지·타일 맵 모두 동작
  const points = (await api("v1", "point/list")).point_list || [];
  const [ox, oy] = origin;
  const markers = points.map((p) => {
    const m = {
      id: "h" + p.id, cat: p.label_id,
      lat: Math.round((oy + p.y_pos) * 10) / 10,
      lng: Math.round((ox + p.x_pos) * 10) / 10,
    };
    if (p.area_id) m.a = p.area_id;                    // 지역(나라)
    const fid = pointToFloor.get(p.id);
    if (fid != null) m.f = fid;                        // 지하 층
    return m;
  });
  const ugN = markers.filter((m) => m.f != null).length;
  console.log(`  마커 ${markers.length}개 (지하 ${ugN})`);

  // 등장한 카테고리만, 많은 순으로 색 배정
  const present = {};
  for (const m of markers) present[m.cat] = (present[m.cat] || 0) + 1;
  const catIds = Object.keys(present).map(Number).sort((a, b) => present[b] - present[a]);
  const categories = {};
  catIds.forEach((id, idx) => {
    const meta = labelMeta[id] || { name: "카테고리 " + id, group: "기타", icon: "" };
    const group = GROUP_RENAME[meta.group] || meta.group;
    categories[id] = { name: meta.name, group, color: PALETTE[idx % PALETTE.length], icon: meta.icon || "", count: present[id] };
  });
  console.log(`  카테고리 ${catIds.length}종`);

  fs.writeFileSync(path.join(ROOT, `data/categories/${localId}.js`),
    `registerCategories("${localId}", ${JSON.stringify(categories, null, 1)});\n`);
  fs.writeFileSync(path.join(ROOT, `data/markers/${localId}.js`),
    `registerMarkers("${localId}", ${JSON.stringify(markers)});\n`);
  console.log(`  data/categories/${localId}.js, data/markers/${localId}.js 생성`);

  // 사용된 지하 층만 registry로 저장 (있을 때만)
  const usedFloors = {};
  for (const m of markers) if (m.f != null) usedFloors[m.f] = floorReg[m.f];
  if (Object.keys(usedFloors).length) {
    fs.mkdirSync(path.join(ROOT, "data/floors"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, `data/floors/${localId}.js`),
      `registerFloors("${localId}", ${JSON.stringify(usedFloors)});\n`);
    console.log(`  data/floors/${localId}.js 생성 (지하 층 ${Object.keys(usedFloors).length}종)`);
  }

  if (imgNote) console.log("\n" + imgNote);
  console.log("\n✅ 완료! data/maps.js 에 아래를 추가하세요:");
  console.log("  " + mapEntry + ",");
})().catch((e) => { console.error("✖", e.message); process.exit(1); });
