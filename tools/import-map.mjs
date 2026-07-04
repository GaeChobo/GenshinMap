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

// 라벨 트리(v1/v2 구조 모두) → { id: {name, group} } 로 평탄화
function flattenLabels(tree, out, group) {
  for (const node of tree || []) {
    const g = group || node.name;
    if (node.id != null && node.name && !(node.children && node.children.length))
      out[node.id] = { name: node.name, group: g };
    if (node.children && node.children.length) flattenLabels(node.children, out, g);
    else if (node.id != null && node.name) out[node.id] = out[node.id] || { name: node.name, group: g };
  }
  return out;
}

const PALETTE = [
  "#5ba8f5", "#63e0c8", "#f0b45a", "#8fd06c", "#e06666", "#b98ce0",
  "#f58fb4", "#7ad4e0", "#d0c85a", "#8c9ee0", "#e0925a", "#6cd0a0",
  "#e0d76c", "#c86cd0", "#6ce0d0", "#e06c9e", "#a0d06c", "#6c8ce0",
];

(async () => {
  console.log(`▶ map_id=${mapId} 가져오는 중...`);
  const info = (await api("v1", "info")).info;
  const isTile = !(info.detail && info.detail.length > 2);

  let origin, mapEntry, imgNote = "";
  if (!isTile) {
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
      imgNote = `⚠ 슬라이스 ${rows}x${cols} 대형 맵 — 타일 방식 별도 처리 필요`;
      mapEntry = `/* ${imgNote} */`;
    }
  } else {
    // ── 타일 맵 (호요랩 CDN 핫링크) ──
    const v2 = info.detail_v2;
    const [w, h] = v2.total_size;
    origin = v2.origin;
    console.log(`  타일 맵 padded ${w}x${h}, origin [${origin}], zoom ${v2.min_zoom}..${v2.max_zoom}`);
    mapEntry =
      `{ id: "${localId}", name: "${name}", kind: "tiles",\n` +
      `    tiles: "${TILE_CDN}/${mapId}/${v2.map_version}/{x}_{y}_P{z}.webp",\n` +
      `    size: [${w}, ${h}], minZoom: ${v2.min_zoom}, maxZoom: ${v2.max_zoom} }`;
  }

  // ── 카테고리(라벨) ──
  const labelMeta = {};
  try { flattenLabels((await api("v1", "label/tree")).tree, labelMeta); } catch (e) {}
  try { flattenLabels((await api("v2", "label/tree")).tree, labelMeta); } catch (e) {}

  // ── 마커(포인트) ── point/list 는 이미지·타일 맵 모두 동작
  const points = (await api("v1", "point/list")).point_list || [];
  const [ox, oy] = origin;
  const markers = points.map((p) => ({
    id: "h" + p.id, cat: p.label_id,
    lat: Math.round((oy + p.y_pos) * 10) / 10,
    lng: Math.round((ox + p.x_pos) * 10) / 10,
  }));
  console.log(`  마커 ${markers.length}개`);

  // 등장한 카테고리만, 많은 순으로 색 배정
  const present = {};
  for (const m of markers) present[m.cat] = (present[m.cat] || 0) + 1;
  const catIds = Object.keys(present).map(Number).sort((a, b) => present[b] - present[a]);
  const categories = {};
  catIds.forEach((id, idx) => {
    const meta = labelMeta[id] || { name: "카테고리 " + id, group: "기타" };
    categories[id] = { name: meta.name, group: meta.group, color: PALETTE[idx % PALETTE.length], count: present[id] };
  });
  console.log(`  카테고리 ${catIds.length}종`);

  fs.writeFileSync(path.join(ROOT, `data/categories/${localId}.js`),
    `registerCategories("${localId}", ${JSON.stringify(categories, null, 1)});\n`);
  fs.writeFileSync(path.join(ROOT, `data/markers/${localId}.js`),
    `registerMarkers("${localId}", ${JSON.stringify(markers)});\n`);
  console.log(`  data/categories/${localId}.js, data/markers/${localId}.js 생성`);

  if (imgNote) console.log("\n" + imgNote);
  console.log("\n✅ 완료! data/maps.js 에 아래를 추가하세요:");
  console.log("  " + mapEntry + ",");
})().catch((e) => { console.error("✖", e.message); process.exit(1); });
