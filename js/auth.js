"use strict";

/* =========================================================
 * 로그인 + 회원별 진행상황 동기화 (Supabase)
 * - 설정(data/config.js)이 비어있으면 비활성 → app.js가 localStorage로만 동작
 * - 로그인 시: 클라우드 진행상황을 불러와 로컬과 합친 뒤 클라우드에 저장
 * - 이후 "먹었음" 변경은 디바운스로 클라우드에 자동 저장
 *
 * app.js 가 노출하는 훅을 사용:
 *   window.getDone()          → 현재 done 객체
 *   window.applyDone(obj)     → done 교체 + 화면 갱신
 * ========================================================= */

window.Cloud = (function () {
  const cfg = window.SUPABASE_CONFIG || {};
  const enabled = !!(cfg.url && cfg.anonKey);
  let sb = null;
  let user = null;
  let syncTimer = null;

  const els = {}; // UI 요소 캐시

  function setStatus(text) {
    if (els.status) els.status.textContent = text;
  }

  // ---- UI 상태 반영 ----
  function renderAuthUI() {
    if (!els.loginBtn) return;
    if (!enabled) {
      els.loginBtn.classList.add("hidden");
      els.userBox.classList.add("hidden");
      return;
    }
    if (user) {
      els.loginBtn.classList.add("hidden");
      els.userBox.classList.remove("hidden");
      els.userEmail.textContent = user.email || "로그인됨";
    } else {
      els.loginBtn.classList.remove("hidden");
      els.userBox.classList.add("hidden");
    }
  }

  // ---- 클라우드 ↔ 로컬 ----
  async function pullAndMerge() {
    if (!user) return;
    setStatus("동기화 중…");
    const { data, error } = await sb
      .from("progress").select("data").eq("user_id", user.id).maybeSingle();
    if (error) { setStatus("동기화 오류"); console.warn(error); return; }

    const cloud = (data && data.data) || {};
    const local = window.getDone ? window.getDone() : {};
    // 합집합: 로컬 체크가 클라우드에 없으면 살림 (첫 로그인 시 유실 방지)
    const merged = Object.assign({}, cloud, local);
    if (window.applyDone) window.applyDone(merged);
    // 합친 결과를 클라우드에 저장(로컬에만 있던 것 반영)
    await push(merged);
    setStatus("");
  }

  async function push(doneObj) {
    if (!user) return;
    const { error } = await sb.from("progress")
      .upsert({ user_id: user.id, data: doneObj, updated_at: new Date().toISOString() });
    if (error) { setStatus("저장 오류"); console.warn(error); }
  }

  function scheduleSync() {
    if (!enabled || !user) return;
    setStatus("저장 중…");
    clearTimeout(syncTimer);
    syncTimer = setTimeout(async () => {
      await push(window.getDone ? window.getDone() : {});
      setStatus("저장됨 ✓");
      setTimeout(() => setStatus(""), 1500);
    }, 800);
  }

  // ---- 로그인/로그아웃 ----
  async function sendMagicLink(email) {
    setStatus("메일 전송 중…");
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.href.split("#")[0] },
    });
    if (error) { alert("로그인 메일 전송 실패: " + error.message); setStatus(""); return; }
    alert(email + " 로 로그인 링크를 보냈어요.\n메일의 링크를 클릭하면 로그인됩니다.");
    setStatus("메일 확인하세요");
  }

  async function logout() {
    await sb.auth.signOut();
    user = null;
    renderAuthUI();
    setStatus("");
  }

  // ---- 초기화 ----
  function init() {
    els.loginBtn = document.getElementById("loginBtn");
    els.userBox = document.getElementById("userBox");
    els.userEmail = document.getElementById("userEmail");
    els.logoutBtn = document.getElementById("logoutBtn");
    els.status = document.getElementById("syncStatus");
    els.loginForm = document.getElementById("loginForm");
    els.loginEmail = document.getElementById("loginEmail");
    els.loginSend = document.getElementById("loginSend");

    if (!enabled) {
      // 설정 전: 로그인 버튼에 안내
      if (els.loginBtn) {
        els.loginBtn.textContent = "로그인 (설정 필요)";
        els.loginBtn.title = "data/config.js 에 Supabase URL/키를 넣으면 활성화됩니다";
        els.loginBtn.addEventListener("click", () =>
          alert("로그인을 쓰려면 data/config.js 에 Supabase 프로젝트 URL과 anon 키를 넣어야 해요."));
      }
      renderAuthUI();
      return;
    }

    sb = supabase.createClient(cfg.url, cfg.anonKey);

    els.loginBtn.addEventListener("click", () => els.loginForm.classList.toggle("hidden"));
    els.loginSend.addEventListener("click", () => {
      const email = els.loginEmail.value.trim();
      if (email) sendMagicLink(email);
    });
    els.loginEmail.addEventListener("keydown", (e) => {
      if (e.key === "Enter") els.loginSend.click();
    });
    els.logoutBtn.addEventListener("click", logout);

    // 세션 감지 (매직링크 복귀 포함)
    sb.auth.getSession().then(({ data }) => {
      if (data.session) { user = data.session.user; renderAuthUI(); pullAndMerge(); }
      else renderAuthUI();
    });
    sb.auth.onAuthStateChange((_evt, session) => {
      const was = user;
      user = session ? session.user : null;
      renderAuthUI();
      els.loginForm && els.loginForm.classList.add("hidden");
      if (user && !was) pullAndMerge();
    });
  }

  return {
    init, scheduleSync,
    get enabled() { return enabled; },
    get user() { return user; },
    get client() { return sb; }, // 리뷰 등 다른 모듈이 재사용
  };
})();

// app.js 로드 후(이 스크립트가 body 끝에 있으므로 DOM 준비됨) 초기화
window.Cloud.init();
