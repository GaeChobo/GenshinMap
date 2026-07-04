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
    const { data, error } = await sb()
      .from("reviews")
      .select("id,user_id,name,text,created_at")
      .eq("map_id", mapId).eq("marker_id", markerId)
      .order("created_at", { ascending: false }).limit(50);
    if (error) {
      if (error.code === "PGRST205") return { missing: true, rows: [] }; // 테이블 미생성
      throw error;
    }
    return { rows: data || [] };
  }
  async function add(mapId, markerId, text) {
    const u = currentUser();
    const name = ((u && u.email) || "").split("@")[0] || "익명";
    const { data, error } = await sb()
      .from("reviews")
      .insert({ map_id: mapId, marker_id: markerId, user_id: u.id, name, text })
      .select("id,user_id,name,text,created_at").single();
    if (error) throw error;
    return data;
  }
  async function remove(id) {
    const { error } = await sb().from("reviews").delete().eq("id", id);
    if (error) throw error;
  }

  // ---- 렌더 ----
  function itemHtml(r) {
    const mine = currentUser() && r.user_id === currentUser().id;
    return (
      '<div class="review-item" data-id="' + r.id + '">' +
      '<div class="review-avatar">' + esc(initial(r.name)) + "</div>" +
      '<div class="review-body">' +
      '<div class="review-meta">' +
      '<span class="review-name">' + esc(r.name || "익명") + "</span>" +
      '<span class="review-time">' + timeAgo(r.created_at) + "</span>" +
      (mine ? '<button class="review-del" title="삭제" data-id="' + r.id + '">✕</button>' : "") +
      "</div>" +
      '<div class="review-text">' + esc(r.text) + "</div>" +
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
      '<button class="review-send" type="button">등록</button>' +
      "</div>"
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
      if (input) {
        input.addEventListener("input", () => { // 자동 높이
          input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 90) + "px";
        });
      }
      if (send) {
        send.addEventListener("click", async () => {
          const text = input.value.trim();
          if (!text) return;
          send.disabled = true;
          try {
            const row = await add(mapId, markerId, text);
            input.value = "";
            // 빈 상태 문구 제거 후 맨 위에 추가
            const empty = listEl.querySelector(".review-empty");
            if (empty) listEl.innerHTML = "";
            listEl.insertAdjacentHTML("afterbegin", itemHtml(row));
          } catch (e) { alert("리뷰 등록 실패: " + (e.message || e)); console.warn(e); }
          finally { send.disabled = false; }
        });
      }
    }

    // 삭제(본인 것) — 위임
    listEl.addEventListener("click", async (e) => {
      const btn = e.target.closest(".review-del");
      if (!btn) return;
      if (!confirm("이 리뷰를 삭제할까요?")) return;
      try {
        await remove(btn.dataset.id);
        const item = btn.closest(".review-item");
        if (item) item.remove();
        if (!listEl.querySelector(".review-item")) renderList(listEl, []);
      } catch (err) { alert("삭제 실패: " + (err.message || err)); }
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
