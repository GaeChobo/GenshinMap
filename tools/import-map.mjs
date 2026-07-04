// HoYoLAB 공식 인터랙티브 맵 → 우리 로컬 맵으로 가져오는 임포터
//
// 사용법:  node tools/import-map.mjs <map_id> <우리_지도_id> "표시이름"
//   예:    node tools/import-map.mjs 7 enkanomiya "연하궁"
//
// 하는 일:
//   1) 맵 정보(origin/크기/이미지 URL) 가져오기
//   2) 카테고리(label) 트리 가져오기
//   3) 마커(point) 목록 가져오기
//   4) 맵 이미지 다운로드 (maps/<우리_id>.<확장자>)
//   5) 좌표 변환 후 data/markers/<우리_id>.js, data/categories/<우리_id>.js 생성
//   6) data/maps.js 에 넣을 한 줄 출력

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const [, , mapIdArg, localId, displayName] = process.argv;
if (!mapIdArg || !localId) {
  console.error('사용법: node tools/import-map.mjs <map_id> <우리_지도_id> "표시이름"');
  process.exit(1);
}
const mapId = Number(mapIdArg);
const name = displayName || localId;

const H = { "x-rpc-app_version": "", "x-rpc-client_type": "4", "User-Agent": "Mozilla/5.0" };
const API = "https://sg-public-api-static.hoyolab.com/common/map_user/ys_obc/v1/map";
const q = `map_id=${mapId}&app_sn=ys_obc&lang=ko-kr`;

async function api(pathname) {
  const r = await fetch(`${API}/${pathname}?${q}`, { headers: H });
  const j = await r.json();
  if (j.retcode !== 0) throw new Error(`${pathname} 실패: ${j.retcode} ${j.message}`);
  return j.data;
}

// ── 색상: 카테고리마다 안정적인 색 배정 ──
const PALETTE = [
  "#5ba8f5", "#63e0c8", "#f0b45a", "#8fd06c", "#e06666", "#b98ce0",
  "#f58fb4", "#7ad4e0", "#d0c85a", "#8c9ee0", "#e0925a", "#6cd0a0",
  "#e0d76c", "#c86cd0", "#6ce0d0", "#e06c9e", "#a0d06c", "#6c8ce0",
];
function colorFor(id, idx) { return PALETTE[idx % PALETTE.length]; }

(async () => {
  console.log(`▶ map_id=${mapId} 가져오는 중...`);

  const info = JSON.parse((await api("info")).info.detail);
  const [w, h] = info.total_size;
  const [ox, oy] = info.origin;
  const slices = info.slices;
  const rows = slices.length, cols = slices[0].length;
  console.log(`  크기 ${w}x${h}, origin [${ox},${oy}], 슬라이스 ${rows}x${cols}`);

  const labelData = await api("label/tree");
  const labelMeta = {}; // id -> {name, group}
  for (const group of labelData.tree || []) {
    for (const child of group.children || []) {
      labelMeta[child.id] = { name: child.name, group: group.name };
    }
  }

  const pointData = await api("point/list");
  const points = pointData.point_list || [];
  console.log(`  마커 ${points.length}개`);

  // 좌표 변환: HoYoLAB 게임좌표 → 이미지 픽셀 → Leaflet(CRS.Simple, bounds [[0,0],[h,w]])
  //   픽셀_x = origin_x + x_pos,  픽셀_y = origin_y + y_pos  (y는 위→아래)
  //   Leaflet lat = h - 픽셀_y,   lng = 픽셀_x
  const markers = points.map((p) => ({
    id: "h" + p.id,
    cat: p.label_id,
    lat: Math.round((h - (oy + p.y_pos)) * 10) / 10,
    lng: Math.round((ox + p.x_pos) * 10) / 10,
  }));

  // 실제로 등장한 카테고리만, 개수 많은 순으로 색 배정
  const present = {};
  for (const m of markers) present[m.cat] = (present[m.cat] || 0) + 1;
  const catIds = Object.keys(present).map(Number).sort((a, b) => present[b] - present[a]);
  const categories = {};
  catIds.forEach((id, idx) => {
    const meta = labelMeta[id] || { name: "카테고리 " + id, group: "기타" };
    categories[id] = { name: meta.name, group: meta.group, color: colorFor(id, idx), count: present[id] };
  });
  console.log(`  카테고리 ${catIds.length}종 (실제 등장)`);

  // 이미지 다운로드 (단일 슬라이스만 지원; 다중 슬라이스는 추후 타일링)
  const firstUrl = slices[0][0].url;
  const ext = path.extname(new URL(firstUrl).pathname) || ".jpeg";
  const imgFile = `maps/${localId}${ext}`;
  if (rows === 1 && cols === 1) {
    const buf = Buffer.from(await (await fetch(firstUrl, { headers: H })).arrayBuffer());
    fs.writeFileSync(path.join(ROOT, imgFile), buf);
    console.log(`  이미지 저장 → ${imgFile} (${(buf.length / 1e6).toFixed(1)}MB)`);
  } else {
    console.log(`  ⚠ 슬라이스 ${rows}x${cols} — 대형 맵은 별도 타일링 필요 (이미지 스킵)`);
  }

  // 파일 쓰기
  fs.writeFileSync(
    path.join(ROOT, `data/categories/${localId}.js`),
    `registerCategories("${localId}", ${JSON.stringify(categories, null, 1)});\n`
  );
  fs.writeFileSync(
    path.join(ROOT, `data/markers/${localId}.js`),
    `registerMarkers("${localId}", ${JSON.stringify(markers)});\n`
  );
  console.log(`  data/categories/${localId}.js, data/markers/${localId}.js 생성`);

  console.log("\n✅ 완료! data/maps.js 에 아래 줄을 추가하세요:");
  console.log(`  { id: "${localId}", name: "${name}", image: "${imgFile}", size: [${w}, ${h}] },`);
})().catch((e) => { console.error("✖", e.message); process.exit(1); });
