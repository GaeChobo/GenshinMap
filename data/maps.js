// ===== 지도 목록 =====
// 새 지도 추가: tools/import-map.mjs 로 가져온 뒤 출력된 줄을 아래에 붙여넣으면 끝.
//   node tools/import-map.mjs <hoyolab_map_id> <우리_id> "이름"
//
// kind 생략 = 이미지 맵. kind:"tiles" = 타일 맵(호요랩 CDN 링크, 저장 불필요).
window.MAPS_LIST = [
  { id: "teyvat", name: "티바트 대륙", kind: "slices", size: [22528, 20480] },
  { id: "enkanomiya", name: "연하궁", image: "maps/enkanomiya.jpeg", size: [4096, 4096] },
  { id: "chasm_underground", name: "층암거연·지하 광갱", image: "maps/chasm_underground.jpeg", size: [4096, 4096] },
  { id: "frostmoon", name: "서리달", kind: "tiles",
    tiles: "https://act-webstatic.hoyoverse.com/map_manage/map/40/ddd32df1233f47e4f6dd5bbf7294112f/{x}_{y}_P{z}.webp",
    size: [10240, 8192], minZoom: -3, maxZoom: 0 },
  { id: "space_temple", name: "공간의 신전", kind: "tiles",
    tiles: "https://act-webstatic.hoyoverse.com/map_manage/map/37/03b79379a7f32cee23e5fed9e6a41e38/{x}_{y}_P{z}.webp",
    size: [3072, 3072], minZoom: -2, maxZoom: 0 },
  { id: "sacred_mountain", name: "태고의 신성한 산", kind: "tiles",
    tiles: "https://act-webstatic.hoyoverse.com/map_manage/map/36/bb19ccbed47e8d9dca730050219d0b90/{x}_{y}_P{z}.webp",
    size: [4096, 4096], minZoom: -4, maxZoom: 0 },
];
