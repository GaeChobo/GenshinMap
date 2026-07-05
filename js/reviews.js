"use strict";

/* =========================================================
 * 마커 리뷰/댓글 (Supabase `reviews` 테이블)
 * - 읽기는 누구나(공개), 작성/삭제는 로그인 사용자 본인만 (RLS)
 * - 테이블이 아직 없으면(PGRST205) 조용히 "준비 중"으로 degrade → 사이트 안 깨짐
 * - app.js 가 팝업 열릴 때 Reviews.mount(팝업DOM) 호출
 *
 * 필요한 Supabase 테이블(대시보드 SQL 편집기에서 1회 실행): docs/reviews.sql
 * ========================================================= */

window.Reviews = (function () {
  function sb() { return window.Cloud && window.Cloud.client; }
  function enabled() { return !!(window.Cloud && window.Cloud.enabled && sb()); }
  function currentUser() { return window.Cloud && window.Cloud.user; }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function timeAgo(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return "방금";
    if (s < 3600) return Math.floor(s / 60) + "분 전";
    if (s < 86400) return Math.floor(s / 3600) + "시간 전";
    if (s < 2592000) return Math.floor(s / 86400) + "일 전";
    return new Date(iso).toLocaleDateString("ko-KR");
  }
  function initial(name) { return (String(name || "?").trim()[0] || "?").toUpperCase(); }

  // ---- 데이터 ----
  async function list(mapId, markerId) {
    // select('*') → image_url 컬럼 유무와 무관하게 안전
    const { data, error } = await sb()
      .from("reviews")
      .select("*")
      .eq("map_id", mapId).eq("marker_id", markerId)
      .order("created_at", { ascending: false }).limit(50);
    if (error) {
      if (error.code === "PGRST205") return { missing: true, rows: [] }; // 테이블 미생성
      throw error;
    }
    const rows = data || [];
    await attachVotes(rows); // 투표수·내 투표·BEST 계산 + 정렬
    return { rows };
  }
  // 각 리뷰에 유용/비추천 수, 내 투표, BEST 여부를 붙이고 점수순 정렬
  async function attachVotes(rows) {
    if (!rows.length) return;
    const ids = rows.map((r) => r.id);
    const uid = currentUser() && currentUser().id;
    let votes = [];
    try {
      const { data, error } = await sb().from("review_votes").select("review_id,user_id,vote").in("review_id", ids);
      if (error) { if (error.code !== "PGRST205") throw error; } // 투표 테이블 없으면 0표로 진행
      votes = data || [];
    } catch (e) { votes = []; }
    const m = {};
    for (const r of rows) m[r.id] = { up: 0, down: 0, mine: 0 };
    for (const v of votes) {
      const c = m[v.review_id]; if (!c) continue;
      if (v.vote === 1) c.up++; else if (v.vote === -1) c.down++;
      if (uid && v.user_id === uid) c.mine = v.vote;
    }
    let bestId = null, bestScore = 1; // 유용 2표 이상 & 최고점만 BEST
    for (const r of rows) {
      const c = m[r.id]; r._up = c.up; r._down = c.down; r._mine = c.mine; r._score = c.up - c.down;
      if (c.up >= 2 && r._score > bestScore) { bestScore = r._score; bestId = r.id; }
    }
    rows.forEach((r) => (r._best = r.id === bestId));
    rows.sort((a, b) => (b._best - a._best) || (b._score - a._score) || (new Date(b.created_at) - new Date(a.created_at)));
  }
  async function add(mapId, markerId, text, imageUrl) {
    const u = currentUser();
    const name = ((u && u.email) || "").split("@")[0] || "익명";
    const row = { map_id: mapId, marker_id: markerId, user_id: u.id, name, text };
    if (imageUrl) row.image_url = imageUrl; // 컬럼 없으면 사진 없이(텍스트만)
    const { data, error } = await sb().from("reviews").insert(row).select("*").single();
    if (error) throw error;
    return data;
  }
  async function remove(id) {
    const { error } = await sb().from("reviews").delete().eq("id", id);
    if (error) throw error;
  }
  // 투표: value = 1(유용) | -1(비추천). 같은 값 다시 → unvote로 취소.
  async function vote(reviewId, value) {
    const u = currentUser(); if (!u) throw new Error("로그인이 필요해요.");
    const { error } = await sb().from("review_votes")
      .upsert({ review_id: reviewId, user_id: u.id, vote: value }, { onConflict: "review_id,user_id" });
    if (error) throw error;
  }
  async function unvote(reviewId) {
    const u = currentUser(); if (!u) return;
    const { error } = await sb().from("review_votes").delete().eq("review_id", reviewId).eq("user_id", u.id);
    if (error) throw error;
  }
  async function report(reviewId) {
    const u = currentUser(); if (!u) { alert("신고하려면 로그인하세요."); return false; }
    const reason = prompt("신고 사유(선택 입력):", "");
    if (reason === null) return false; // 취소
    const { error } = await sb().from("review_reports").insert({ review_id: reviewId, user_id: u.id, reason });
    if (error) { if (error.code === "PGRST205") { alert("신고 기능 준비 중입니다."); return false; } throw error; }
    return true;
  }

  // ---- 사진 업로드 (Supabase Storage: review-photos 버킷) ----
  // 업로드 전에 최대 1280px로 축소 + webp 변환 → 저장 용량 절약
  async function downscale(file, max, quality) {
    max = max || 1280; quality = quality || 0.82;
    try {
      const img = await new Promise((res, rej) => {
        const i = new Image(); i.onload = () => res(i); i.onerror = rej;
        i.src = URL.createObjectURL(file);
      });
      let w = img.naturalWidth, h = img.naturalHeight;
      if (Math.max(w, h) > max) { const s = max / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      cv.getContext("2d").drawImage(img, 0, 0, w, h);
      const blob = await new Promise((res) => cv.toBlob(res, "image/webp", quality));
      return blob || file;
    } catch (e) { return file; }
  }
  async function uploadImage(file) {
    const u = currentUser();
    const blob = await downscale(file);
    const path = u.id + "/" + Date.now() + "-" + Math.random().toString(36).slice(2, 7) + ".webp";
    const { error } = await sb().storage.from("review-photos")
      .upload(path, blob, { contentType: "image/webp", upsert: false });
    if (error) throw error;
    return sb().storage.from("review-photos").getPublicUrl(path).data.publicUrl;
  }

  // ---- 렌더 ----
  function itemHtml(r) {
    const me = currentUser();
    const mine = me && r.user_id === me.id;
    const up = r._up || 0, down = r._down || 0, my = r._mine || 0;
    return (
      '<div class="review-item' + (r._best ? " is-best" : "") + '" data-id="' + r.id + '">' +
      '<div class="review-avatar">' + esc(initial(r.name)) + "</div>" +
      '<div class="review-body">' +
      '<div class="review-meta">' +
      (r._best ? '<span class="review-best">BEST</span>' : "") +
      '<span class="review-name">' + esc(r.name || "익명") + "</span>" +
      '<span class="review-time">' + timeAgo(r.created_at) + "</span>" +
      (mine ? '<button class="review-del" title="삭제" data-id="' + r.id + '">✕</button>' : "") +
      "</div>" +
      '<div class="review-text">' + esc(r.text) + "</div>" +
      (r.image_url ? '<a class="review-photo" href="' + esc(r.image_url) + '" target="_blank" rel="noopener">' +
        '<img src="' + esc(r.image_url) + '" alt="첨부 사진" loading="lazy"></a>' : "") +
      '<div class="review-actions">' +
      '<button class="rv-up' + (my === 1 ? " on" : "") + '" data-id="' + r.id + '" title="유용해요"><b>' + up + "</b></button>" +
      '<button class="rv-down' + (my === -1 ? " on" : "") + '" data-id="' + r.id + '" title="별로예요"><b>' + down + "</b></button>" +
      (mine ? "" : '<button class="rv-report" data-id="' + r.id + '" title="신고"></button>') +
      "</div>" +
      "</div></div>"
    );
  }
  function renderList(listEl, rows) {
    if (!rows.length) { listEl.innerHTML = '<div class="review-empty">아직 리뷰가 없어요. 첫 리뷰를 남겨보세요!</div>'; return; }
    listEl.innerHTML = rows.map(itemHtml).join("");
  }
  function formHtml() {
    if (!currentUser()) {
      return '<div class="review-login-hint">로그인하면 리뷰를 남길 수 있어요.</div>';
    }
    return (
      '<div class="review-form">' +
      '<textarea class="review-input" rows="1" maxlength="500" placeholder="이 지점에 대한 팁·리뷰 남기기…"></textarea>' +
      '<label class="review-photo-btn" title="사진 첨부">' +
      '<input class="review-file" type="file" accept="image/*" hidden></label>' +
      '<button class="review-send" type="button">등록</button>' +
      "</div>" +
      '<div class="review-preview hidden"><img alt="미리보기"><button class="review-preview-x" type="button" title="사진 제거">✕</button></div>'
    );
  }

  // ---- 팝업에 마운트 ----
  // popupEl 안의 .popup-reviews[data-map][data-mid] 를 찾아 리뷰를 채운다.
  async function mount(popupEl) {
    if (!popupEl) return;
    const box = popupEl.querySelector(".popup-reviews");
    if (!box || box.dataset.mounted) return;
    box.dataset.mounted = "1";
    const mapId = box.dataset.map, markerId = box.dataset.mid;
    const listEl = box.querySelector(".review-list");

    if (!enabled()) { box.innerHTML = '<div class="review-empty">리뷰는 로그인(Supabase) 설정 후 사용할 수 있어요.</div>'; return; }

    listEl.innerHTML = '<div class="review-empty">불러오는 중…</div>';
    let res;
    try { res = await list(mapId, markerId); }
    catch (e) { listEl.innerHTML = '<div class="review-empty">리뷰를 불러오지 못했어요.</div>'; console.warn(e); return; }

    if (res.missing) {
      box.innerHTML = '<div class="review-empty">리뷰 기능 준비 중입니다.</div>';
      return;
    }
    renderList(listEl, res.rows);

    // 폼 (로그인 상태에 따라)
    const formWrap = box.querySelector(".review-form-wrap");
    if (formWrap) {
      formWrap.innerHTML = formHtml();
      const input = formWrap.querySelector(".review-input");
      const send = formWrap.querySelector(".review-send");
      const fileInput = formWrap.querySelector(".review-file");
      const preview = formWrap.querySelector(".review-preview");
      let pickedFile = null;

      if (input) {
        input.addEventListener("input", () => { // 자동 높이
          input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 90) + "px";
        });
      }
      // 사진 선택 → 미리보기
      if (fileInput) {
        fileInput.addEventListener("change", () => {
          const f = fileInput.files && fileInput.files[0];
          if (!f) return;
          if (f.size > 10 * 1024 * 1024) { alert("사진은 10MB 이하만 가능해요."); fileInput.value = ""; return; }
          pickedFile = f;
          preview.querySelector("img").src = URL.createObjectURL(f);
          preview.classList.remove("hidden");
        });
        preview.querySelector(".review-preview-x").addEventListener("click", () => {
          pickedFile = null; fileInput.value = ""; preview.classList.add("hidden");
        });
      }
      if (send) {
        send.addEventListener("click", async () => {
          const text = input.value.trim();
          if (!text && !pickedFile) return; // 글·사진 둘 다 없으면 무시
          send.disabled = true; send.textContent = "…";
          try {
            let imageUrl = null;
            if (pickedFile) imageUrl = await uploadImage(pickedFile);
            const row = await add(mapId, markerId, text, imageUrl);
            input.value = ""; input.style.height = "auto";
            pickedFile = null; if (fileInput) fileInput.value = "";
            if (preview) preview.classList.add("hidden");
            const empty = listEl.querySelector(".review-empty");
            if (empty) listEl.innerHTML = "";
            listEl.insertAdjacentHTML("afterbegin", itemHtml(row));
          } catch (e) {
            const msg = /bucket|not found|storage/i.test(e.message || "") ? "사진 저장소가 아직 설정되지 않았어요(관리자 설정 필요)." : (e.message || e);
            alert("리뷰 등록 실패: " + msg); console.warn(e);
          } finally { send.disabled = false; send.textContent = "등록"; }
        });
      }
    }

    // 삭제·투표·신고 — 위임
    listEl.addEventListener("click", async (e) => {
      const del = e.target.closest(".review-del");
      const up = e.target.closest(".rv-up");
      const down = e.target.closest(".rv-down");
      const rep = e.target.closest(".rv-report");

      if (del) {
        if (!confirm("이 리뷰를 삭제할까요?")) return;
        try {
          await remove(del.dataset.id);
          const item = del.closest(".review-item");
          if (item) item.remove();
          if (!listEl.querySelector(".review-item")) renderList(listEl, []);
        } catch (err) { alert("삭제 실패: " + (err.message || err)); }
        return;
      }
      if (up || down) {
        if (!currentUser()) { alert("로그인하면 투표할 수 있어요."); return; }
        const btn = up || down, id = btn.dataset.id, val = up ? 1 : -1;
        btn.disabled = true;
        try {
          if (btn.classList.contains("on")) await unvote(id); else await vote(id, val);
          const res = await list(mapId, markerId); renderList(listEl, res.rows); // 다시 집계·정렬
        } catch (err) {
          const s = (err.message || "") + (err.code || "");
          alert(/PGRST205|review_votes/i.test(s) ? "투표 기능 준비 중입니다." : "투표 실패: " + (err.message || err));
          btn.disabled = false;
        }
        return;
      }
      if (rep) {
        try { if (await report(rep.dataset.id)) alert("신고했어요. 감사합니다."); }
        catch (err) { alert("신고 실패: " + (err.message || err)); }
      }
    });
  }

  // 팝업 HTML에 넣을 리뷰 영역 (app.js popupHtml 에서 사용)
  function sectionHtml(mapId, markerId) {
    return (
      '<div class="popup-reviews" data-map="' + esc(mapId) + '" data-mid="' + esc(markerId) + '">' +
      '<div class="popup-reviews-head">리뷰 · 팁</div>' +
      '<div class="review-list"></div>' +
      '<div class="review-form-wrap"></div>' +
      "</div>"
    );
  }

  return { mount, sectionHtml, get enabled() { return enabled(); } };
})();
