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

const STORAGE_KEY = "fakemsg_input_history_v1";

const DEFAULT_CONFIG = {
    emoji: "💉",
    iconSize: 24,
    iconMarginRight: 6,
    clearInput: true,   // 삽입 후 입력창 비우기

    // 심플 전송 (유저 메시지로만 삽입, AI 응답 없음)
    showSendButton: true,
    sendEmoji: "📨",

    // 인풋 복구
    showRecoverButton: true,
    recoverEmoji: "↩️",
    historyLimit: 20,   // 보관 개수
    minLength: 8,       // 이 길이 미만은 기록 안 함
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
// ============================================================

let history = [];         // [0] 이 가장 최근
let cycleIndex = 0;       // 복구 버튼 연타 시 순환 위치
let lastValue = "";       // 직전 폴링 때의 입력창 값
let stableTicks = 0;      // 값이 몇 틱째 안 바뀌고 있는지
let pollTimer = null;

const POLL_MS = 500;      // 폴링 주기
const STABLE_TICKS = 2;   // 이만큼 유지되면 "타이핑 멈춤" 으로 보고 스냅샷

function loadHistory() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) history = parsed.filter(v => typeof v === "string");
        }
    } catch (e) {
        console.warn("[주작버튼] 인풋 기록 로드 실패:", e);
    }
}

function persistHistory() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    } catch (e) {
        // 용량 초과 등 — 조용히 무시 (메모리 기록은 계속 동작)
    }
}

/**
 * 입력값을 기록에 넣는다.
 * - 너무 짧으면 무시
 * - 맨 위 항목과 같으면 무시
 * - 맨 위 항목과 "이어 쓰는 관계"(한쪽이 다른 쪽의 앞부분)면 덮어쓰기
 *   → 타이핑 중간 상태가 기록을 도배하지 않게 함
 */
function pushHistory(text) {
    const config = getConfig();
    const t = String(text ?? "");
    if (t.trim().length < config.minLength) return;

    if (history[0] === t) {
        cycleIndex = 0;
        return;
    }

    if (history[0] && (t.startsWith(history[0]) || history[0].startsWith(t))) {
        history[0] = t;
    } else {
        history.unshift(t);
    }

    if (history.length > config.historyLimit) {
        history.length = config.historyLimit;
    }
    cycleIndex = 0;
    persistHistory();
}

/**
 * 현재 입력창 값과 다른, 다음 복구 후보를 반환.
 * 계속 누르면 기록을 순환한다.
 */
function getNextRecoverable(currentInput = "") {
    if (!history.length) return "";
    const cur = String(currentInput ?? "");

    for (let offset = 0; offset < history.length; offset++) {
        const idx = (cycleIndex + offset) % history.length;
        const candidate = history[idx];
        if (candidate !== cur) {
            cycleIndex = (idx + 1) % history.length;
            return candidate;
        }
    }
    return "";
}

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
        stableTicks++;
        // 타이핑이 멈춘 시점에 한 번만 스냅샷
        if (stableTicks === STABLE_TICKS) pushHistory(cur);
        return;
    }

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
}

/** 입력창을 비우기 직전에 호출 — 확실하게 기록에 남긴다 */
function snapshotNow() {
    const ta = document.getElementById("send_textarea");
    if (ta) pushHistory(ta.value ?? "");
}

function recoverInput() {
    const ta = document.getElementById("send_textarea");
    if (!ta) return;

    // 지금 쓰고 있던 것도 잃지 않도록 먼저 보존
    pushHistory(ta.value ?? "");

    const prev = getNextRecoverable(ta.value ?? "");
    if (!prev) {
        toastr?.info?.("복구할 기록이 없어요.", "주작버튼");
        return;
    }

    ta.value = prev;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    lastValue = prev;
    stableTicks = 0;

    const pos = cycleIndex === 0 ? history.length : cycleIndex;
    toastr?.success?.(`인풋 복구 (${pos}/${history.length})`, "주작버튼");
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

function readInput() {
    const $textarea = $("#send_textarea");
    const text = String($textarea.val() || "").trim();
    if (!text) {
        toastr?.info?.("입력창에 내용을 먼저 써주세요.", "주작버튼");
        return null;
    }
    const context = getContext();
    if (!Array.isArray(context.chat)) {
        toastr?.warning?.("채팅을 먼저 열어주세요.", "주작버튼");
        return null;
    }
    return { $textarea, text, context };
}

function clearInputIfNeeded($textarea) {
    if (getConfig().clearInput) {
        $textarea.val("").trigger("input");
        lastValue = "";
        stableTicks = 0;
    }
}

// ---------- 캐릭터 메시지 삽입 (주작) ----------

async function injectCharacterMessage() {
    try {
        const parsed = readInput();
        if (!parsed) return;
        const { $textarea, text, context } = parsed;

        snapshotNow(); // 비우기 전에 기록

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
        clearInputIfNeeded($textarea);

        console.log(`[주작버튼] 캐릭터 메시지 삽입됨 (${charName}, len=${text.length})`);
    } catch (e) {
        console.error("[주작버튼] 삽입 실패:", e);
        toastr?.error?.("삽입에 실패했어요. 콘솔을 확인해주세요.", "주작버튼");
    }
}

// ---------- 심플 전송 (유저 메시지만 삽입, AI 응답 없음) ----------

let isSending = false;

async function simpleSend() {
    if (isSending) return;
    isSending = true;
    try {
        const parsed = readInput();
        if (!parsed) return;
        const { $textarea, text, context } = parsed;

        snapshotNow(); // 비우기 전에 기록

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
        clearInputIfNeeded($textarea);

        console.log(`[주작버튼] 유저 메시지 삽입됨 (len=${text.length})`);
    } catch (e) {
        console.error("[주작버튼] 심플 전송 실패:", e);
        toastr?.error?.("전송에 실패했어요. 콘솔을 확인해주세요.", "주작버튼");
    } finally {
        isSending = false;
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

    $(`#${SEND_BTN_ID}`).toggle(!!config.showSendButton);
    $(`#${RECOVER_BTN_ID}`).toggle(!!config.showRecoverButton);
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

function buildSettingsPanel() {
    const config = getConfig();

    const html = `
    <div class="fakemsg-settings-block">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>💉 주작버튼</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label for="fakemsg-emoji-input">주작 버튼 아이콘</label>
                <input id="fakemsg-emoji-input" class="text_pole" type="text" maxlength="10" value="${config.emoji}">

                <label for="fakemsg-send-emoji-input">심플전송 버튼 아이콘</label>
                <input id="fakemsg-send-emoji-input" class="text_pole" type="text" maxlength="10" value="${config.sendEmoji}">

                <label for="fakemsg-recover-emoji-input">인풋복구 버튼 아이콘</label>
                <input id="fakemsg-recover-emoji-input" class="text_pole" type="text" maxlength="10" value="${config.recoverEmoji}">

                <label for="fakemsg-icon-size-input">아이콘 크기 (px)</label>
                <input id="fakemsg-icon-size-input" class="text_pole" type="number" min="12" max="64" step="1" value="${config.iconSize}">

                <label for="fakemsg-icon-margin-input">오른쪽 여백 (px)</label>
                <input id="fakemsg-icon-margin-input" class="text_pole" type="number" min="0" max="40" step="1" value="${config.iconMarginRight}">

                <label class="checkbox_label" for="fakemsg-clear-input">
                    <input id="fakemsg-clear-input" type="checkbox" ${config.clearInput ? "checked" : ""}>
                    <span>삽입 후 입력창 비우기</span>
                </label>

                <label class="checkbox_label" for="fakemsg-show-send">
                    <input id="fakemsg-show-send" type="checkbox" ${config.showSendButton ? "checked" : ""}>
                    <span>심플전송 버튼 표시</span>
                </label>

                <label class="checkbox_label" for="fakemsg-show-recover">
                    <input id="fakemsg-show-recover" type="checkbox" ${config.showRecoverButton ? "checked" : ""}>
                    <span>인풋복구 버튼 표시</span>
                </label>

                <label for="fakemsg-history-limit">인풋 기록 보관 개수</label>
                <input id="fakemsg-history-limit" class="text_pole" type="number" min="1" max="100" step="1" value="${config.historyLimit}">

                <label for="fakemsg-min-length">기록 최소 글자수</label>
                <input id="fakemsg-min-length" class="text_pole" type="number" min="1" max="200" step="1" value="${config.minLength}">

                <div style="margin-top:10px;">
                    <span id="fakemsg-history-count" class="fakemsg-count"></span>
                    <input id="fakemsg-clear-history" class="menu_button" type="button" value="기록 비우기">
                </div>

                <small>💉 캐릭터 메시지 삽입 / 📨 유저 메시지만 삽입(AI 응답 없음) / ↩️ 날아간 입력 복구.<br>
                입력창은 0.5초마다 자동 스냅샷돼서 <b>그냥 타이핑한 내용도 기록</b>되고, 다른 확장이 입력창을 덮어써도 직전 값이 남습니다. 기록은 브라우저에 저장되어 새로고침해도 유지돼요. ↩️를 연타하면 기록을 차례로 순환합니다.</small>
            </div>
        </div>
    </div>
    `;

    const $target = $("#extensions_settings2").length ? $("#extensions_settings2") : $("#extensions_settings");
    $target.append(html);

    function refreshCount() {
        $("#fakemsg-history-count").text(`저장된 기록: ${history.length}개  `);
    }
    refreshCount();
    setInterval(refreshCount, 3000);

    const bindEmoji = (sel, key, fallback) => {
        $(sel).on("input", function () {
            getConfig()[key] = $(this).val().trim() || fallback;
            saveConfig();
            applyButtonStyle();
        });
    };
    bindEmoji("#fakemsg-emoji-input", "emoji", DEFAULT_CONFIG.emoji);
    bindEmoji("#fakemsg-send-emoji-input", "sendEmoji", DEFAULT_CONFIG.sendEmoji);
    bindEmoji("#fakemsg-recover-emoji-input", "recoverEmoji", DEFAULT_CONFIG.recoverEmoji);

    const bindNumber = (sel, key, min, max) => {
        $(sel).on("input", function () {
            let val = parseInt($(this).val(), 10);
            if (isNaN(val)) return;
            val = Math.min(max, Math.max(min, val));
            getConfig()[key] = val;
            saveConfig();
            applyButtonStyle();
        });
    };
    bindNumber("#fakemsg-icon-size-input", "iconSize", 12, 64);
    bindNumber("#fakemsg-icon-margin-input", "iconMarginRight", 0, 40);
    bindNumber("#fakemsg-history-limit", "historyLimit", 1, 100);
    bindNumber("#fakemsg-min-length", "minLength", 1, 200);

    const bindCheck = (sel, key) => {
        $(sel).on("change", function () {
            getConfig()[key] = $(this).prop("checked");
            saveConfig();
            applyButtonStyle();
        });
    };
    bindCheck("#fakemsg-clear-input", "clearInput");
    bindCheck("#fakemsg-show-send", "showSendButton");
    bindCheck("#fakemsg-show-recover", "showRecoverButton");

    $("#fakemsg-clear-history").on("click", function () {
        history = [];
        cycleIndex = 0;
        persistHistory();
        refreshCount();
        toastr?.info?.("인풋 기록을 비웠어요.", "주작버튼");
    });
}

// ---------- 초기화 ----------

jQuery(async () => {
    loadHistory();
    buildButton();
    buildSettingsPanel();
    startWatching();
});
