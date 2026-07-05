// 기존 맵에 "지하 층(floor)" 정보만 추가하는 패치 스크립트.
// import-map.mjs 를 재실행하지 않고, point_group 만 가져와서
//   ① 마커 파일에 f(floor_id) 주입   ② data/floors/<id>.js 생성
// 하는 가벼운 버전. (마커 좌표/카테고리는 건드리지 않음)
//
// 사용법:  node tools/add-floors.mjs <hoyolab_map_id> <우리_id>
//   예:    node tools/add-floors.mjs 40 frostmoon

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const [, , mapIdArg, localId] = process.argv;
if (!mapIdArg || !localId) {
  console.error("사용법: node tools/add-floors.mjs <hoyolab_map_id> <우리_id>");
  process.exit(1);
}
const mapId = Number(mapIdArg);

const H = { "x-rpc-app_version": "", "x-rpc-client_type": "4", "User-Agent": "Mozilla/5.0" };
const S = "https://sg-public-api-static.hoyolab.com/common/map_user/ys_obc";

async function api(ver, pathname) {
  const r = await fetch(`${S}/${ver}/map/${pathname}?map_id=${mapId}&app_sn=ys_obc&lang=ko-kr`, { headers: H });
  const j = await r.json();
  if (j.retcode !== 0) throw new Error(`${pathname} 실패: ${j.retcode} ${j.message}`);
  return j.data;
}

(async () => {
  console.log(`▶ map_id=${mapId} (${localId}) 층 정보 가져오는 중...`);

  // origin: 타일 맵이면 detail_v2.origin, 아니면 detail.origin
  const info = (await api("v1", "info")).info;
  const v2 = info.detail_v2;
  const useTiles = v2 && v2.map_version && Array.isArray(v2.total_size) && v2.total_size.length === 2;
  const origin = useTiles ? v2.origin : JSON.parse(info.detail).origin;
  const [oX, oY] = origin;
  console.log(`  origin [${origin}] (${useTiles ? "타일" : "이미지"} 맵)`);

  // point_group → floorReg(층 메타), pointToFloor(포인트→층)
  const floorReg = {};
  const pointToFloor = new Map();
  for (const g of ((await api("v2", "point_group")).list || [])) {
    for (const f of (g.floors || [])) {
      const e = { n: f.floor_name || ("층 " + f.id) };
      const o = f.overlay;
      if (o && o.url) e.o = [o.url,
        Math.round((oY + o.l_y) * 10) / 10, Math.round((oX + o.l_x) * 10) / 10,
        Math.round((oY + o.r_y) * 10) / 10, Math.round((oX + o.r_x) * 10) / 10];
      floorReg[f.id] = e;
      for (const pid of (f.point_ids || [])) pointToFloor.set(pid, f.id);
    }
  }
  console.log(`  층 ${Object.keys(floorReg).length}종, 지하 포인트 ${pointToFloor.size}개`);
  if (!pointToFloor.size) { console.log("  지하 데이터 없음 → 종료"); return; }

  // 마커 파일 찾기: data/markers/<id>.js (통짜) 또는 data/markers/<id>/*.js (나라별)
  const singleFile = path.join(ROOT, `data/markers/${localId}.js`);
  const areaDir = path.join(ROOT, `data/markers/${localId}`);
  const files = [];
  if (fs.existsSync(singleFile)) files.push(singleFile);
  if (fs.existsSync(areaDir)) for (const fn of fs.readdirSync(areaDir)) if (fn.endsWith(".js")) files.push(path.join(areaDir, fn));
  if (!files.length) { console.error(`  마커 파일 없음: ${singleFile}`); process.exit(1); }

  let injected = 0;
  const usedFloors = {};
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const a = text.indexOf("["), b = text.lastIndexOf("]");
    const head = text.slice(0, a);            // registerMarkers("id", 또는 registerAreaMarkers("id", N,
    const markers = JSON.parse(text.slice(a, b + 1));
    for (const m of markers) {
      const pid = Number(String(m.id).replace(/^h/, ""));
      const fid = pointToFloor.get(pid);
      if (fid != null) { m.f = fid; usedFloors[fid] = floorReg[fid]; injected++; }
      else if (m.f != null) delete m.f;       // 옛 잘못된 f 정리
    }
    fs.writeFileSync(file, `${head}${JSON.stringify(markers)});\n`);
  }
  console.log(`  마커 ${injected}개에 f 주입 (파일 ${files.length}개)`);

  // data/floors/<id>.js — 실제 사용된 층만
  fs.mkdirSync(path.join(ROOT, "data/floors"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, `data/floors/${localId}.js`),
    `registerFloors("${localId}", ${JSON.stringify(usedFloors)});\n`);
  console.log(`  data/floors/${localId}.js 생성 (층 ${Object.keys(usedFloors).length}종)`);
})();
