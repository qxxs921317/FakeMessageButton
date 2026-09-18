import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

// ⚠️ 다른 확장과 겹치지 않도록 이 확장 전용 네임스페이스만 사용합니다.
const EXT_NAME = "fake-message-button";
const BTN_ID = "fakemsg-btn";
const ICON_ID = "fakemsg-icon";
const SEND_BTN_ID = "fakemsg-send-btn";
const SEND_ICON_ID = "fakemsg-send-icon";
const RECOVER_BTN_ID = "fakemsg-recover-btn";
const RECOVER_ICON_ID = "fakemsg-recover-icon";

const STORAGE_KEY = "fakemsg_input_history_v2";
const STORAGE_KEY_LEGACY = "fakemsg_input_history_v1";

const DEFAULT_CONFIG = {
    emoji: "💉",
    iconSize: 24,
    iconMarginRight: 6,
    clearInput: true,   // 삽입 후 입력창 비우기

    showFakeButton: true,

    // 심플 전송 (유저 메시지로만 삽입, AI 응답 없음)
    showSendButton: true,
    sendEmoji: "📨",

    // 인풋 복구
    showRecoverButton: true,
    recoverEmoji: "↩️",
    historyLimit: 20,       // 보관 개수
    minLength: 8,           // 이 길이 미만은 기록 안 함
    sentPolicy: "demote",   // demote | delete | keep
};

// ---------- 설정 헬퍼 ----------

function getConfig() {
    if (!extension_settings[EXT_NAME]) {
        extension_settings[EXT_NAME] = {};
    }
    extension_settings[EXT_NAME] = { ...DEFAULT_CONFIG, ...extension_settings[EXT_NAME] };
    return extension_settings[EXT_NAME];
}

function saveConfig() {
    saveSettingsDebounced();
}

// ============================================================
//  인풋 기록 / 복구
//
//  기록 1건 = { t: 본문, s: 전송여부(bool), d: 기록시각(ms) }
//  배열 순서가 곧 복구 순환 순서. [0] 이 가장 먼저 나온다.
// ============================================================

let history = [];
let cycleIndex = 0;        // 다음에 꺼낼 위치
let cycleActive = false;   // 복구 순환 중인가
let suppressSnapshot = false; // 우리가 방금 입력창을 바꿨으니 폴링은 무시하라

let lastValue = "";        // 직전 폴링 때의 입력창 값
let stableTicks = 0;       // 값이 몇 틱째 안 바뀌고 있는지
let pollTimer = null;

const POLL_MS = 500;           // 폴링 주기
const STABLE_TICKS = 2;        // 이만큼 유지되면 "타이핑 멈춤" 으로 보고 스냅샷
const PERSIST_DELAY = 1500;    // localStorage 쓰기 합치는 간격
const MAX_BYTES = 256 * 1024;  // 기록 전체 용량 상한

// ---------- 저장 / 로드 ----------

let persistTimer = null;

function persistHistory() {
    // 여러 번 호출돼도 실제 쓰기는 한 번으로 합침 (동기 직렬화로 인한 끊김 방지)
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
        persistTimer = null;
        flushHistory();
    }, PERSIST_DELAY);
}

function flushHistory() {
    try {
        let payload = JSON.stringify(history);
        // 용량 상한 초과 시 뒤쪽(오래된/전송된 것)부터 잘라냄
        while (payload.length > MAX_BYTES && history.length > 1) {
            history.pop();
            payload = JSON.stringify(history);
        }
        localStorage.setItem(STORAGE_KEY, payload);
    } catch (e) {
        // 용량 초과 등 — 조용히 무시 (메모리 기록은 계속 동작)
        console.warn("[주작버튼] 인풋 기록 저장 실패:", e);
    }
}

function loadHistory() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                history = parsed
                    .filter(v => v && typeof v.t === "string")
                    .map(v => ({ t: v.t, s: !!v.s, d: v.d || 0 }));
                return;
            }
        }
        // v1(문자열 배열) 마이그레이션
        const legacy = localStorage.getItem(STORAGE_KEY_LEGACY);
        if (legacy) {
            const parsed = JSON.parse(legacy);
            if (Array.isArray(parsed)) {
                history = parsed
                    .filter(v => typeof v === "string")
                    .map(t => ({ t, s: false, d: 0 }));
                flushHistory();
            }
        }
    } catch (e) {
        console.warn("[주작버튼] 인풋 기록 로드 실패:", e);
    }
}

// ---------- 기록 추가 ----------

function trimHistory() {
    const limit = getConfig().historyLimit;
    if (history.length <= limit) return;
    // 넘치면 전송된 것부터 버리고, 그래도 넘치면 오래된 것부터 버림
    for (let i = history.length - 1; i >= 0 && history.length > limit; i--) {
        if (history[i].s) history.splice(i, 1);
    }
    if (history.length > limit) history.length = limit;
}

/**
 * 입력값을 기록에 넣는다.
 * - 너무 짧으면 무시
 * - 맨 위 항목과 같으면 무시
 * - 맨 위 항목(미전송)과 "이어 쓰는 관계"(한쪽이 다른 쪽의 앞부분)면 덮어쓰기
 *   → 타이핑 중간 상태가 기록을 도배하지 않게 함
 *
 * @param {boolean} resetCycle 순환 위치를 처음으로 되돌릴지. 복구 중에는 false.
 */
function pushHistory(text, resetCycle = true) {
    const config = getConfig();
    const t = String(text ?? "");
    if (t.trim().length < config.minLength) return;

    const head = history[0];

    if (head && head.t === t) {
        if (resetCycle) cycleIndex = 0;
        return;
    }

    // 이미 같은 내용이 뒤쪽에 있으면 그걸 앞으로 끌어올림 (중복 누적 방지)
    const dupIdx = history.findIndex(h => h.t === t);
    if (dupIdx > 0) {
        const [item] = history.splice(dupIdx, 1);
        item.s = false;
        item.d = Date.now();
        history.unshift(item);
    } else if (head && !head.s && (t.startsWith(head.t) || head.t.startsWith(t))) {
        head.t = t;
        head.d = Date.now();
    } else {
        history.unshift({ t, s: false, d: Date.now() });
    }

    trimHistory();
    if (resetCycle) cycleIndex = 0;
    persistHistory();
    refreshHistoryCount();
}

// ---------- 전송된 입력 처리 ----------

/**
 * 채팅에 무사히 들어간 입력을 기록에서 어떻게 다룰지.
 *  demote : 전송 표시 후 맨 뒤로 → 복구 시 미전송 것부터 나옴 (기본)
 *  delete : 기록에서 제거
 *  keep   : 아무것도 안 함
 * 본문이 정확히 일치하지 않으면 아무 일도 일어나지 않음 (안전 실패).
 */
function markAsSent(text) {
    const policy = getConfig().sentPolicy;
    if (policy === "keep") return;

    const t = String(text ?? "").trim();
    if (!t) return;

    const idx = history.findIndex(h => h.t === t || h.t.trim() === t);
    if (idx === -1) return; // 매칭 실패 → 기록은 그대로 둔다

    if (policy === "delete") {
        history.splice(idx, 1);
    } else {
        const [item] = history.splice(idx, 1);
        item.s = true;
        history.push(item);
    }

    cycleIndex = 0;
    cycleActive = false;
    persistHistory();
    refreshHistoryCount();
}

// ---------- 복구 ----------

/**
 * 현재 입력창 값과 다른, 다음 복구 후보를 반환.
 * cycleIndex 를 리셋하지 않으므로 연타하면 기록 전체를 한 바퀴 돈다.
 */
function getNextRecoverable(currentInput = "") {
    if (!history.length) return null;
    const cur = String(currentInput ?? "");

    for (let offset = 0; offset < history.length; offset++) {
        const idx = (cycleIndex + offset) % history.length;
        const item = history[idx];
        if (item.t !== cur) {
            cycleIndex = (idx + 1) % history.length;
            return { item, idx };
        }
    }
    return null;
}

function recoverInput(pickIndex) {
    const ta = document.getElementById("send_textarea");
    if (!ta) return null;

    // 순환을 "시작"할 때만 현재 입력을 보존한다.
    // 연타 중에 매번 넣으면 기록이 오염되고 순환 위치가 리셋돼 2개만 왕복하게 됨.
    if (!cycleActive) {
        pushHistory(ta.value ?? "", true);
        cycleActive = true;
    }

    let next;
    if (Number.isInteger(pickIndex)) {
        // 1-based 번호로 직접 지정
        const item = history[pickIndex - 1];
        if (!item) {
            toastr?.warning?.(`${pickIndex}번 기록이 없어요. (총 ${history.length}개)`, "주작버튼");
            return null;
        }
        next = { item, idx: pickIndex - 1 };
        cycleIndex = pickIndex % history.length;
    } else {
        next = getNextRecoverable(ta.value ?? "");
    }
    if (!next) {
        toastr?.info?.("복구할 기록이 없어요.", "주작버튼");
        return null;
    }

    suppressSnapshot = true;   // 폴링이 이 값을 다시 집어넣지 않도록
    ta.value = next.item.t;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    lastValue = next.item.t;
    stableTicks = 0;

    const tag = next.item.s ? " · 전송됨" : "";
    toastr?.success?.(`인풋 복구 (${next.idx + 1}/${history.length}${tag})`, "주작버튼");
    return next.item.t;
}

/** 기록 목록을 사람이 읽을 수 있는 문자열로 */
function formatHistoryList(max = 20) {
    if (!history.length) return "(기록 없음)";
    return history.slice(0, max).map((h, i) => {
        const head = h.t.replace(/\s+/g, " ").slice(0, 40);
        const more = h.t.length > 40 ? "…" : "";
        return `${i + 1}. ${h.s ? "[전송됨] " : ""}${head}${more}`;
    }).join("\n");
}

// ---------- 기록 목록 뷰어 ----------

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function renderHistoryRows() {
    if (!history.length) {
        return `<div class="fm-modal-empty">저장된 기록이 없어요.</div>`;
    }
    return history.map((h, i) => {
        const preview = escapeHtml(h.t.replace(/\s+/g, " ").slice(0, 120));
        const more = h.t.length > 120 ? "…" : "";
        const sent = h.s ? `<span class="fm-modal-tag">전송됨</span>` : "";
        return `
        <div class="fm-modal-item" data-idx="${i}">
            <div class="fm-modal-num">${i + 1}</div>
            <div class="fm-modal-body">
                <div class="fm-modal-meta">${sent}<span class="fm-modal-len">${h.t.length}자</span></div>
                <div class="fm-modal-text">${preview}${more}</div>
            </div>
            <div class="fm-modal-del" data-del="${i}" title="이 기록 삭제">✕</div>
        </div>`;
    }).join("");
}

function openHistoryViewer() {
    closeHistoryViewer();

    const html = `
    <div id="fakemsg-history-modal" class="fm-modal-overlay">
        <div class="fm-modal">
            <div class="fm-modal-head">
                <span>인풋 기록</span>
                <span class="fm-modal-count">${history.length}개</span>
                <span class="fm-modal-close" title="닫기">✕</span>
            </div>
            <div class="fm-modal-hint">항목을 누르면 입력창에 불러옵니다.</div>
            <div class="fm-modal-list">${renderHistoryRows()}</div>
        </div>
    </div>`;

    $("body").append(html);

    const $modal = $("#fakemsg-history-modal");

    $modal.on("click", function (e) {
        if (e.target === this) closeHistoryViewer();
    });
    $modal.find(".fm-modal-close").on("click", closeHistoryViewer);

    $modal.on("click", ".fm-modal-del", function (e) {
        e.stopPropagation();
        const idx = parseInt($(this).data("del"), 10);
        if (!Number.isInteger(idx) || !history[idx]) return;
        history.splice(idx, 1);
        cycleIndex = 0;
        cycleActive = false;
        flushHistory();
        refreshHistoryCount();
        $modal.find(".fm-modal-list").html(renderHistoryRows());
        $modal.find(".fm-modal-count").text(`${history.length}개`);
    });

    $modal.on("click", ".fm-modal-item", function () {
        const idx = parseInt($(this).data("idx"), 10);
        const item = history[idx];
        if (!item) return;
        const ta = document.getElementById("send_textarea");
        if (!ta) return;

        suppressSnapshot = true;
        cycleActive = false;
        cycleIndex = (idx + 1) % history.length;
        ta.value = item.t;
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        lastValue = item.t;
        stableTicks = 0;

        closeHistoryViewer();
        toastr?.success?.(`${idx + 1}번 기록을 불러왔어요.`, "주작버튼");
    });

    $(document).on("keydown.fakemsgModal", function (e) {
        if (e.key === "Escape") closeHistoryViewer();
    });
}

function closeHistoryViewer() {
    $("#fakemsg-history-modal").remove();
    $(document).off("keydown.fakemsgModal");
}

// ---------- 입력창 감시 ----------

/**
 * 폴링 루프.
 * input 이벤트가 아니라 값 자체를 직접 감시하기 때문에,
 * 다른 확장이 textarea.value 를 이벤트 없이 덮어써도 잡아낸다.
 */
function tick() {
    const ta = document.getElementById("send_textarea");
    if (!ta) return;

    const cur = ta.value ?? "";

    if (cur === lastValue) {
        if (suppressSnapshot) return;   // 복구로 넣은 값은 다시 기록하지 않음
        stableTicks++;
        if (stableTicks === STABLE_TICKS) pushHistory(cur);
        return;
    }

    // 사용자가 직접 손댐 → 복구 순환 종료
    suppressSnapshot = false;
    cycleActive = false;

    // 값이 급격히 줄었다 = 지워졌거나 덮어써졌다 → 줄어들기 직전 값을 즉시 보존
    if (lastValue.trim().length >= getConfig().minLength &&
        cur.length < lastValue.length / 2) {
        pushHistory(lastValue);
    }

    lastValue = cur;
    stableTicks = 0;
}

function startWatching() {
    if (pollTimer) return;
    const ta = document.getElementById("send_textarea");
    lastValue = ta ? (ta.value ?? "") : "";
    pollTimer = setInterval(tick, POLL_MS);

    // 페이지를 떠날 때 대기 중인 쓰기를 확실히 반영
    window.addEventListener("pagehide", flushHistory);
    window.addEventListener("beforeunload", flushHistory);
}

/** 입력창을 비우기 직전에 호출 — 확실하게 기록에 남긴다 */
function snapshotNow() {
    const ta = document.getElementById("send_textarea");
    if (ta) pushHistory(ta.value ?? "");
}

// ---------- 캐릭터 정보 조회 ----------
// 현재 대화 중인 캐릭터의 이름/아바타를 그대로 사용함.
// 그룹 채팅 등 캐릭터가 특정되지 않는 상황에서는 name2(화면에 표시되는 상대 이름)로 폴백.
function getCharacterInfo(context) {
    let charName = context.name2 || "Character";
    let avatar = null;

    try {
        const chid = context.characterId;
        const chars = context.characters;
        if (chid !== undefined && chid !== null && chars && chars[chid]) {
            const char = chars[chid];
            if (char.name) charName = char.name;
            if (char.avatar) avatar = char.avatar;
        }
    } catch (e) {
        console.warn("[주작버튼] 캐릭터 정보 조회 실패, 기본값 사용:", e);
    }

    return { charName, avatar };
}

// ---------- 공통: 채팅에 메시지 밀어넣기 ----------

async function pushMessage(message, isUser) {
    const context = getContext();
    const chat = context.chat;

    chat.push(message);

    if (typeof context.addOneMessage === "function") {
        await context.addOneMessage(message);
    }

    if (typeof context.saveChat === "function") {
        await context.saveChat();
    }

    try {
        const idx = chat.length - 1;
        const et = context.eventTypes;
        if (isUser) {
            await context.eventSource.emit(et.MESSAGE_SENT, idx);
            await context.eventSource.emit(et.USER_MESSAGE_RENDERED, idx);
        } else {
            await context.eventSource.emit(et.MESSAGE_RECEIVED, idx);
            await context.eventSource.emit(et.CHARACTER_MESSAGE_RENDERED, idx);
        }
    } catch (e) {
        console.warn("[주작버튼] 이벤트 발생 실패(무시 가능):", e);
    }
}

function readInput(override) {
    const $textarea = $("#send_textarea");
    const fromInput = override === undefined || override === null || override === "";
    const text = fromInput
        ? String($textarea.val() || "").trim()
        : String(override).trim();
    if (!text) {
        toastr?.info?.("입력창에 내용을 먼저 써주세요.", "주작버튼");
        return null;
    }
    const context = getContext();
    if (!Array.isArray(context.chat)) {
        toastr?.warning?.("채팅을 먼저 열어주세요.", "주작버튼");
        return null;
    }
    return { $textarea, text, context, fromInput };
}

function clearInputIfNeeded($textarea) {
    if (getConfig().clearInput) {
        $textarea.val("").trigger("input");
        lastValue = "";
        stableTicks = 0;
        suppressSnapshot = false;
        cycleActive = false;
    }
}

// ---------- 캐릭터 메시지 삽입 (주작) ----------

async function injectCharacterMessage(override) {
    try {
        const parsed = readInput(override);
        if (!parsed) return null;
        const { $textarea, text, context, fromInput } = parsed;

        if (fromInput) snapshotNow(); // 비우기 전에 기록

        const { charName, avatar } = getCharacterInfo(context);

        // 일반 AI 응답과 동일한 형태의 메시지 객체를 만듦.
        const now = new Date().toISOString();
        const message = {
            name: charName,
            is_user: false,
            is_system: false,
            send_date: now,
            mes: text,
            extra: {},
            swipe_id: 0,
            swipes: [text],
            swipe_info: [{
                send_date: now,
                gen_started: null,
                gen_finished: null,
                extra: {},
            }],
        };

        if (avatar) {
            message.original_avatar = avatar;
        }

        await pushMessage(message, false);
        markAsSent(text);
        if (fromInput) clearInputIfNeeded($textarea);

        console.log(`[주작버튼] 캐릭터 메시지 삽입됨 (${charName}, len=${text.length})`);
        return charName;
    } catch (e) {
        console.error("[주작버튼] 삽입 실패:", e);
        toastr?.error?.("삽입에 실패했어요. 콘솔을 확인해주세요.", "주작버튼");
        return null;
    }
}

// ---------- 심플 전송 (유저 메시지만 삽입, AI 응답 없음) ----------

let isSending = false;

async function simpleSend(override) {
    if (isSending) return null;
    isSending = true;
    try {
        const parsed = readInput(override);
        if (!parsed) return null;
        const { $textarea, text, context, fromInput } = parsed;

        if (fromInput) snapshotNow(); // 비우기 전에 기록

        const now = new Date().toISOString();
        const message = {
            name: context.name1 || "You",
            is_user: true,
            is_system: false,
            send_date: now,
            mes: text,
            extra: {},
        };

        await pushMessage(message, true);
        if (fromInput) clearInputIfNeeded($textarea);

        console.log(`[주작버튼] 유저 메시지 삽입됨 (len=${text.length})`);
        return text;
    } catch (e) {
        console.error("[주작버튼] 심플 전송 실패:", e);
        toastr?.error?.("전송에 실패했어요. 콘솔을 확인해주세요.", "주작버튼");
        return null;
    } finally {
        isSending = false;
    }
}

// ---------- 전송 감지 ----------

function hookSendEvents() {
    try {
        const { eventSource, eventTypes, chat } = getContext();
        if (!eventSource || !eventTypes) return;

        eventSource.on(eventTypes.MESSAGE_SENT, (idx) => {
            try {
                const msg = getContext().chat?.[idx];
                if (msg?.mes) markAsSent(msg.mes);
            } catch (e) { /* noop */ }
        });
    } catch (e) {
        console.warn("[주작버튼] 전송 이벤트 연결 실패:", e);
    }
}

// ---------- 툴바 버튼 ----------

function applyButtonStyle() {
    const config = getConfig();

    $(`#${ICON_ID}`).text(config.emoji);
    $(`#${SEND_ICON_ID}`).text(config.sendEmoji);
    $(`#${RECOVER_ICON_ID}`).text(config.recoverEmoji);

    $(`#${BTN_ID}, #${SEND_BTN_ID}, #${RECOVER_BTN_ID}`).css({
        width: `${config.iconSize}px`,
        height: `${config.iconSize}px`,
        flex: `0 0 ${config.iconSize}px`,
        fontSize: `${config.iconSize * 0.55}px`,
        marginRight: `${config.iconMarginRight}px`,
    });

    $(`#${BTN_ID}`).toggle(!!config.showFakeButton);
    $(`#${SEND_BTN_ID}`).toggle(!!config.showSendButton);
    $(`#${RECOVER_BTN_ID}`).toggle(!!config.showRecoverButton);

    // 설정 패널 미리보기도 같이 갱신
    $("#fakemsg-preview-fake").text(config.emoji).toggle(!!config.showFakeButton);
    $("#fakemsg-preview-send").text(config.sendEmoji).toggle(!!config.showSendButton);
    $("#fakemsg-preview-recover").text(config.recoverEmoji).toggle(!!config.showRecoverButton);
    $("#fakemsg-preview .fm-preview-btn").css({
        width: `${config.iconSize}px`,
        height: `${config.iconSize}px`,
        fontSize: `${config.iconSize * 0.55}px`,
        marginRight: `${config.iconMarginRight}px`,
    });
}

function buildButton() {
    if ($(`#${BTN_ID}`).length) return; // 중복 삽입 방지

    // 배치 순서: [↩️ 복구] [📨 심플전송] [💉 주작] [FLIP] [전송]
    const html = `
        <div id="${RECOVER_BTN_ID}" class="fakemsg-tool-btn interactable" tabindex="0" title="이전에 쓰던 입력 복구 (연타하면 기록을 순환)"><span id="${RECOVER_ICON_ID}"></span></div>
        <div id="${SEND_BTN_ID}" class="fakemsg-tool-btn interactable" tabindex="0" title="입력창 내용을 유저 메시지로만 삽입 (AI 응답 없음)"><span id="${SEND_ICON_ID}"></span></div>
        <div id="${BTN_ID}" class="fakemsg-tool-btn interactable" tabindex="0" title="입력창 내용을 캐릭터 메시지로 삽입"><span id="${ICON_ID}"></span></div>
    `;

    const $flip = $("#flip-toggle-btn");
    const $flipro = $("#flipro-toggle-btn");

    if ($flip.length) {
        $flip.before(html);
    } else if ($flipro.length) {
        $flipro.before(html);
    } else if ($("#send_but").length) {
        $("#send_but").before(html);
    } else {
        setTimeout(buildButton, 500);
        return;
    }

    $(`#${BTN_ID}`).on("click", injectCharacterMessage);
    $(`#${SEND_BTN_ID}`).on("click", simpleSend);
    $(`#${RECOVER_BTN_ID}`).on("click", recoverInput);

    applyButtonStyle();
}

// ---------- 설정 패널 ----------

function refreshHistoryCount() {
    const $el = $("#fakemsg-history-count");
    if (!$el.length) return;
    const unsent = history.filter(h => !h.s).length;
    const sent = history.length - unsent;
    $el.text(sent > 0 ? `${unsent} + ${sent}` : `${unsent}개`);
    $el.attr("title", `미전송 ${unsent}개 / 전송됨 ${sent}개`);
    $el.toggleClass("fm-badge-empty", history.length === 0);
}

function buildSettingsPanel() {
    const config = getConfig();

    const sw = (id, checked) =>
        `<label class="fm-switch"><input id="${id}" type="checkbox" ${checked ? "checked" : ""}><span class="fm-slider"></span></label>`;

    const sel = (v) => config.sentPolicy === v ? "selected" : "";

    const html = `
    <div class="fakemsg-settings-block">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>💉 주작버튼</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content fm-root">

                <div id="fakemsg-preview" class="fm-preview">
                    <span class="fm-preview-label">미리보기</span>
                    <div class="fm-preview-bar">
                        <span id="fakemsg-preview-recover" class="fm-preview-btn"></span>
                        <span id="fakemsg-preview-send" class="fm-preview-btn"></span>
                        <span id="fakemsg-preview-fake" class="fm-preview-btn"></span>
                        <span class="fm-preview-input"></span>
                        <span class="fm-preview-send"><i class="fa-solid fa-paper-plane"></i></span>
                    </div>
                </div>

                <div class="fm-sec">
                    <div class="fm-sec-title">버튼</div>

                    <div class="fm-row">
                        <span class="fm-label">주작<small>캐릭터 메시지로 삽입</small></span>
                        <input id="fakemsg-emoji-input" class="text_pole fm-emoji" type="text" maxlength="10" value="${config.emoji}">
                        ${sw("fakemsg-show-fake", config.showFakeButton)}
                    </div>

                    <div class="fm-row">
                        <span class="fm-label">심플전송<small>유저 메시지만, AI 응답 없음</small></span>
                        <input id="fakemsg-send-emoji-input" class="text_pole fm-emoji" type="text" maxlength="10" value="${config.sendEmoji}">
                        ${sw("fakemsg-show-send", config.showSendButton)}
                    </div>

                    <div class="fm-row">
                        <span class="fm-label">인풋복구<small>날아간 입력 되살리기</small></span>
                        <input id="fakemsg-recover-emoji-input" class="text_pole fm-emoji" type="text" maxlength="10" value="${config.recoverEmoji}">
                        ${sw("fakemsg-show-recover", config.showRecoverButton)}
                    </div>
                </div>

                <div class="fm-sec">
                    <div class="fm-sec-title">모양 &amp; 동작</div>

                    <div class="fm-row">
                        <span class="fm-label">아이콘 크기</span>
                        <div class="fm-ctl">
                            <input id="fakemsg-icon-size-range" class="fm-range" type="range" min="12" max="64" step="1" value="${config.iconSize}">
                            <input id="fakemsg-icon-size-input" class="text_pole fm-num" type="number" min="12" max="64" step="1" value="${config.iconSize}">
                        </div>
                    </div>

                    <div class="fm-row">
                        <span class="fm-label">오른쪽 여백</span>
                        <div class="fm-ctl">
                            <input id="fakemsg-icon-margin-range" class="fm-range" type="range" min="0" max="40" step="1" value="${config.iconMarginRight}">
                            <input id="fakemsg-icon-margin-input" class="text_pole fm-num" type="number" min="0" max="40" step="1" value="${config.iconMarginRight}">
                        </div>
                    </div>

                    <div class="fm-row">
                        <span class="fm-label">삽입 후 입력창 비우기</span>
                        ${sw("fakemsg-clear-input", config.clearInput)}
                    </div>
                </div>

                <div class="fm-sec">
                    <div class="fm-sec-title">
                        인풋 기록
                        <span id="fakemsg-history-count" class="fm-badge">0개</span>
                    </div>

                    <div class="fm-row">
                        <span class="fm-label">전송된 입력 처리<small id="fakemsg-policy-desc"></small></span>
                        <select id="fakemsg-sent-policy" class="text_pole fm-select">
                            <option value="demote" ${sel("demote")}>뒤로 밀기</option>
                            <option value="delete" ${sel("delete")}>삭제</option>
                            <option value="keep" ${sel("keep")}>그대로</option>
                        </select>
                    </div>

                    <div class="fm-row">
                        <span class="fm-label">보관 개수</span>
                        <input id="fakemsg-history-limit" class="text_pole fm-num" type="number" min="1" max="100" step="1" value="${config.historyLimit}">
                    </div>

                    <div class="fm-row">
                        <span class="fm-label">기록 최소 글자수<small>이보다 짧으면 저장 안 함</small></span>
                        <input id="fakemsg-min-length" class="text_pole fm-num" type="number" min="1" max="200" step="1" value="${config.minLength}">
                    </div>

                    <div class="fm-row fm-row-end">
                        <input id="fakemsg-view-history" class="menu_button" type="button" value="기록 보기">
                        <input id="fakemsg-clear-history" class="menu_button fm-danger" type="button" value="기록 비우기">
                    </div>
                </div>

                <details class="fm-help">
                    <summary>사용법</summary>
                    <p>입력창은 0.5초마다 자동 스냅샷돼서 <b>그냥 타이핑한 내용도 기록</b>되고, 다른 확장이 입력창을 덮어써도 직전 값이 남습니다.</p>
                    <p>기록은 브라우저에 저장되어 <b>새로고침해도 유지</b>돼요. 복구 버튼을 연타하면 기록 전체를 한 바퀴 순환합니다.</p>
                    <p>버튼을 다 꺼도 슬래시 명령어로 쓸 수 있어요 — <code>/fake</code> <code>/fakeuser</code> <code>/recover</code> <code>/recoverlist</code></p>
                    <p>뱃지의 <b>미전송 + 전송됨</b> 숫자는 각각 아직 채팅에 안 들어간 입력과 이미 들어간 입력의 개수예요.</p>
                </details>

            </div>
        </div>
    </div>
    `;

    const $target = $("#extensions_settings2").length ? $("#extensions_settings2") : $("#extensions_settings");
    $target.append(html);

    refreshHistoryCount();
    refreshPolicyDesc();

    // --- 이모지 입력 ---
    const bindEmoji = (selq, key, fallback) => {
        $(selq).on("input", function () {
            getConfig()[key] = $(this).val().trim() || fallback;
            saveConfig();
            applyButtonStyle();
        });
    };
    bindEmoji("#fakemsg-emoji-input", "emoji", DEFAULT_CONFIG.emoji);
    bindEmoji("#fakemsg-send-emoji-input", "sendEmoji", DEFAULT_CONFIG.sendEmoji);
    bindEmoji("#fakemsg-recover-emoji-input", "recoverEmoji", DEFAULT_CONFIG.recoverEmoji);

    // --- 숫자 입력 ---
    const bindNumber = (selq, key, min, max, after) => {
        $(selq).on("input", function () {
            let val = parseInt($(this).val(), 10);
            if (isNaN(val)) return;
            val = Math.min(max, Math.max(min, val));
            getConfig()[key] = val;
            saveConfig();
            applyButtonStyle();
            if (after) after();
        });
    };
    bindNumber("#fakemsg-icon-size-input", "iconSize", 12, 64);
    bindNumber("#fakemsg-icon-margin-input", "iconMarginRight", 0, 40);
    bindNumber("#fakemsg-history-limit", "historyLimit", 1, 100, () => {
        trimHistory();
        persistHistory();
        refreshHistoryCount();
    });
    bindNumber("#fakemsg-min-length", "minLength", 1, 200);

    // --- 슬라이더 ↔ 숫자 동기화 ---
    const linkRange = (rangeSel, numSel, key, min, max) => {
        $(rangeSel).on("input", function () {
            const val = Math.min(max, Math.max(min, parseInt($(this).val(), 10)));
            $(numSel).val(val);
            getConfig()[key] = val;
            saveConfig();
            applyButtonStyle();
        });
        $(numSel).on("input", function () {
            const val = parseInt($(this).val(), 10);
            if (!isNaN(val)) $(rangeSel).val(Math.min(max, Math.max(min, val)));
        });
    };
    linkRange("#fakemsg-icon-size-range", "#fakemsg-icon-size-input", "iconSize", 12, 64);
    linkRange("#fakemsg-icon-margin-range", "#fakemsg-icon-margin-input", "iconMarginRight", 0, 40);

    // --- 토글 ---
    const bindCheck = (selq, key) => {
        $(selq).on("change", function () {
            getConfig()[key] = $(this).prop("checked");
            saveConfig();
            applyButtonStyle();
        });
    };
    bindCheck("#fakemsg-show-fake", "showFakeButton");
    bindCheck("#fakemsg-clear-input", "clearInput");
    bindCheck("#fakemsg-show-send", "showSendButton");
    bindCheck("#fakemsg-show-recover", "showRecoverButton");

    // --- 전송된 입력 처리 ---
    $("#fakemsg-sent-policy").on("change", function () {
        getConfig().sentPolicy = $(this).val();
        saveConfig();
        refreshPolicyDesc();
    });

    $("#fakemsg-view-history").on("click", openHistoryViewer);

    $("#fakemsg-clear-history").on("click", function () {
        history = [];
        cycleIndex = 0;
        cycleActive = false;
        flushHistory();
        refreshHistoryCount();
        closeHistoryViewer();
        toastr?.info?.("인풋 기록을 비웠어요.", "주작버튼");
    });

    applyButtonStyle();
}

function refreshPolicyDesc() {
    const desc = {
        demote: "채팅에 들어간 건 순환 맨 뒤로 — 안 보낸 것부터 나옴",
        delete: "채팅에 들어간 건 기록에서 제거",
        keep: "전송 여부와 상관없이 그대로 둠",
    };
    $("#fakemsg-policy-desc").text(desc[getConfig().sentPolicy] || "");
}

// ---------- 슬래시 명령어 ----------
// 버튼을 전부 숨겨도 명령어만으로 모든 기능을 쓸 수 있게 등록한다.
// 신형 SlashCommandParser 를 먼저 시도하고, 없으면 구형 registerSlashCommand 로 폴백.

async function registerSlashCommands() {
    const handlers = {
        fake: async (_args, value) => (await injectCharacterMessage(value)) ?? "",
        fakeuser: async (_args, value) => (await simpleSend(value)) ?? "",
        recover: (_args, value) => {
            const n = parseInt(String(value ?? "").trim(), 10);
            return recoverInput(Number.isInteger(n) ? n : undefined) ?? "";
        },
        recoverlist: () => {
            openHistoryViewer();
            return formatHistoryList();
        },
    };

    const help = {
        fake: "입력창(또는 인자로 준 텍스트)을 캐릭터 메시지로 채팅에 삽입합니다. 예: <code>/fake 그가 문을 열었다.</code>",
        fakeuser: "입력창(또는 인자로 준 텍스트)을 유저 메시지로만 삽입합니다. AI 응답은 생성하지 않습니다. 예: <code>/fakeuser 안녕</code>",
        recover: "이전에 쓰던 입력을 되살립니다. 인자 없이 쓰면 기록을 순환하고, 번호를 주면 그 번호를 바로 불러옵니다. 예: <code>/recover 3</code>",
        recoverlist: "저장된 인풋 기록 목록을 창으로 띄웁니다. 항목을 누르면 입력창에 불러옵니다. 목록 텍스트도 반환하므로 <code>/recoverlist | /echo</code> 처럼 이어 쓸 수 있습니다.",
    };

    try {
        const [parserMod, cmdMod, argMod] = await Promise.all([
            import("../../../slash-commands/SlashCommandParser.js"),
            import("../../../slash-commands/SlashCommand.js"),
            import("../../../slash-commands/SlashCommandArgument.js"),
        ]);
        const { SlashCommandParser } = parserMod;
        const { SlashCommand } = cmdMod;
        const { SlashCommandArgument, ARGUMENT_TYPE } = argMod;

        const textArg = (desc) => SlashCommandArgument.fromProps({
            description: desc,
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: false,
        });

        const defs = [
            ["fake", "삽입한 캐릭터 이름", textArg("삽입할 내용 (생략하면 입력창 내용)")],
            ["fakeuser", "삽입한 내용", textArg("삽입할 내용 (생략하면 입력창 내용)")],
            ["recover", "복구된 내용", textArg("기록 번호 (생략하면 순환)")],
            ["recoverlist", "기록 목록", null],
        ];

        for (const [name, returns, arg] of defs) {
            SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                name,
                callback: handlers[name],
                returns,
                unnamedArgumentList: arg ? [arg] : [],
                helpString: help[name],
            }));
        }
        console.log("[주작버튼] 슬래시 명령어 등록 완료 (신형)");
        return;
    } catch (e) {
        console.warn("[주작버튼] 신형 슬래시 명령어 등록 실패, 구형 방식 시도:", e);
    }

    try {
        const { registerSlashCommand } = await import("../../../slash-commands.js");
        for (const name of Object.keys(handlers)) {
            registerSlashCommand(name, handlers[name], [], help[name], true, true);
        }
        console.log("[주작버튼] 슬래시 명령어 등록 완료 (구형)");
    } catch (e) {
        console.warn("[주작버튼] 슬래시 명령어 등록 실패:", e);
    }
}

// ---------- 초기화 ----------

jQuery(async () => {
    loadHistory();
    buildButton();
    buildSettingsPanel();
    hookSendEvents();
    startWatching();
    registerSlashCommands();
});
