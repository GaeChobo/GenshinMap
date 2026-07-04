// ===== 지도 목록 =====
// 새 지도 추가: tools/import-map.mjs 로 가져온 뒤 출력된 줄을 아래에 붙여넣으면 끝.
//   node tools/import-map.mjs <hoyolab_map_id> <우리_id> "이름"
//
// kind 없음 = 이미지 맵. kind:"tiles" = 타일 맵(호요랩 CDN 링크). kind:"slices" = 다중 이미지.
window.MAPS_LIST = [
  { id: "teyvat", name: "티바트 대륙", kind: "tiles",
    tileBase: "https://act-webstatic.hoyoverse.com/map_manage/map/2/c0eaef431637950e44ef47dc2ba0c105/", zoomStyle: "N",
    size: [36864, 16384], minNative: -4, maxNative: -1 },
  { id: "enkanomiya", name: "연하궁", image: "maps/enkanomiya.jpeg", size: [4096, 4096] },
  { id: "chasm_underground", name: "층암거연·지하 광갱", image: "maps/chasm_underground.jpeg", size: [4096, 4096] },
  { id: "frostmoon", name: "서리달", kind: "tiles",
    tileBase: "https://act-webstatic.hoyoverse.com/map_manage/map/40/ddd32df1233f47e4f6dd5bbf7294112f/", zoomStyle: "N",
    size: [10240, 8192], minNative: -3, maxNative: -1 },
  { id: "space_temple", name: "공간의 신전", kind: "tiles",
    tileBase: "https://act-webstatic.hoyoverse.com/map_manage/map/37/03b79379a7f32cee23e5fed9e6a41e38/", zoomStyle: "N",
    size: [3072, 3072], minNative: -2, maxNative: -1 },
  { id: "sacred_mountain", name: "태고의 신성한 산", kind: "tiles",
    tileBase: "https://act-webstatic.hoyoverse.com/map_manage/map/36/bb19ccbed47e8d9dca730050219d0b90/", zoomStyle: "N",
    size: [4096, 4096], minNative: -4, maxNative: -1 },
];
