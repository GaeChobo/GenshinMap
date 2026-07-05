# 원신 맵 — 디자인 리뷰 요청 (Claude design용)

바닐라 HTML/CSS/JS + Leaflet 기반 원신 인터랙티브 지도. 이미 **Fontaine Frost** 테마(라이트: 블루-화이트 / 다크: 짙은 남색, 인디고 메탈 + 시안 포인트)가 적용돼 있습니다. 이번엔 그 테마 위에 **새로 추가된 컴포넌트들**을 다듬어 주세요.

**규칙**: 기능 로직은 건드리지 말고 **CSS 교체 + 최소 HTML 스니펫**만. 기존 id/class 훅 이름은 **절대 바꾸지 말 것**. 마커가 화면에 수천 개 뜨므로 무거운 블러/그림자/애니메이션 금지.

---

## 1) 이번에 리뷰받고 싶은 컴포넌트

### A. 마커 리뷰/댓글 (핵심 — 가장 신경써주세요)
마커 팝업 하단에 리뷰 영역이 있습니다. 원신맵스처럼 **글 + 사진 + 투표 + 신고**가 다 들어갑니다. 지금은 기능만 붙인 상태라 시각적으로 정돈이 필요합니다.

리뷰 한 개(`.review-item`)의 구조:
```html
<div class="review-item is-best">          <!-- is-best: BEST 리뷰 -->
  <div class="review-avatar">파</div>       <!-- 이름 첫 글자 원형 -->
  <div class="review-body">
    <div class="review-meta">
      <span class="review-best">BEST</span>  <!-- 유용 2표↑ 최고점 1개 -->
      <span class="review-name">파이몬</span>
      <span class="review-time">3일 전</span>
      <button class="review-del">✕</button>  <!-- 본인 것만 -->
    </div>
    <div class="review-text">여기 상자는 절벽 위에 숨어있어요.</div>
    <a class="review-photo"><img src="..."></a> <!-- 첨부 사진(선택) -->
    <div class="review-actions">
      <button class="rv-up on">👍 <b>12</b></button>   <!-- .on: 내가 누름 -->
      <button class="rv-down">👎 <b>1</b></button>
      <button class="rv-report">🚩</button>            <!-- 남의 것에만 -->
    </div>
  </div>
</div>
```
작성 폼(`.review-form`): `textarea.review-input` + `label.review-photo-btn`(📷 파일첨부) + `button.review-send`(등록). 사진 미리보기 `.review-preview`(img + ✕).
헤더 `.popup-reviews-head`, 목록 `.review-list`(스크롤).

**요청**: 이모지 버튼(👍👎🚩📷) 대신 깔끔한 아이콘 느낌으로, BEST 배지·투표 버튼·신고 버튼·사진 썸네일 레이아웃을 원신맵스 수준으로 정돈. 사진이 여러 장일 수도 있으니 썸네일 그리드도 고려. 라이트/다크 둘 다.

### B. 완료(수집) 상태 토글 버튼
팝업의 `.done-btn`. 기본 `○ 미완료`(중립 아웃라인) → 누르면 `✓ 완료`(`.is-done`, 초록 채움). 상태가 한눈에 보이게.

### C. 클러스터 배지 (지도 위)
시점 축소 시 같은 종류 마커가 원형 배지로 묶임. `.mk-cluster`(링=수집비율 conic-gradient) 안에 `.mk-cluster-icon`(카테고리 아이콘) + `.mk-cluster-count`(예 "0/7" 수집/전체). 원신맵스식 상자 배지 톤으로.

### D. 지상/지하 필터 (사이드바)
세그먼트 토글 `#levelFilter` = `[전체][🔼 지상][🔻 지하]`. `.active` 상태 강조.

### E. 로그인 창 (`#loginForm`)
이메일/비번 입력 + `[로그인][회원가입]` + "또는" 구분선 + `Google`(`.btn-google`)·`카카오`(`.btn-kakao`, 노란색) 소셜 버튼 + "메일 링크로 로그인" 링크. 소셜 버튼 로고/정렬 다듬기.

### F. (참고) 완료 마커 = 희미하게
완료한 마커는 숨기지 않고 반투명(opacity .4)으로 남깁니다. 이 "희미함" 정도가 적절한지도 봐주세요.

---

## 2) 받고 싶은 산출물 (deliverable)

1. **`css/style.css` 교체본** — 위 컴포넌트들의 스타일. CSS 변수(디자인 토큰)는 기존 것 재사용. 라이트/다크 둘 다.
2. **필요하면 HTML 스니펫** — 아이콘을 이미지 대신 인라인 SVG로 넣는다면 그 마크업. (외부 파일/CDN 금지, 인라인만)
3. **목업 스크린샷** — 리뷰 영역, 로그인 창, 클러스터 배지의 before/after 시안. 정확한 마크업 구조 + 붙일 위치 포함.
4. **아이콘** — 👍/👎/🚩/📷/BEST 등을 이모지 대신 쓸 거면 인라인 SVG나 CSS로. (색·크기 토큰 명시)
5. **변경 가이드** — "어느 class를 어떻게" 짧게. class/id 이름은 유지.

## 3) 제약 (꼭 지켜주세요)
- 기존 **id/class 이름 변경 금지** (JS가 그 훅을 씀).
- 외부 폰트/이미지/CDN/스크립트 **금지**, 전부 인라인.
- 마커 수천 개 → **무거운 그림자·블러·per-marker 애니메이션 금지**.
- **라이트/다크 모두** 대응(`prefers-color-scheme` + `[data-theme]`).
- Leaflet이 그리는 `#map` 타일/마커 위치 로직 건드리지 말 것 (스타일만).
