import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

// ⚠️ 다른 확장과 겹치지 않도록 이 확장 전용 네임스페이스만 사용합니다.
const EXT_NAME = "fake-message-button";
const BTN_ID = "fakemsg-btn";
const ICON_ID = "fakemsg-icon";

const DEFAULT_CONFIG = {
    emoji: "💉",
    iconSize: 24,
    iconMarginRight: 6,
    clearInput: true,   // 삽입 후 입력창 비우기
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

// ---------- 캐릭터 메시지 삽입 ----------

async function injectCharacterMessage() {
    try {
        const $textarea = $("#send_textarea");
        const text = String($textarea.val() || "").trim();

        if (!text) {
            toastr?.info?.("입력창에 내용을 먼저 써주세요.", "주작버튼");
            return;
        }

        const context = getContext();
        const chat = context.chat;

        if (!Array.isArray(chat)) {
            toastr?.warning?.("채팅을 먼저 열어주세요.", "주작버튼");
            return;
        }

        const { charName, avatar } = getCharacterInfo(context);

        // 일반 AI 응답과 동일한 형태의 메시지 객체를 만듦.
        // is_user: false / is_system: false 이므로 ST는 이걸 평범한 캐릭터 메시지로 취급함
        // (화면 표시, 스와이프, 편집, 프롬프트 히스토리 포함까지 전부 정상 동작).
        const now = new Date().toISOString();
        const message = {
            name: charName,
            is_user: false,
            is_system: false,
            send_date: now,
            mes: text,
            extra: {},
            // 스와이프 구조를 미리 갖춰둠 (없으면 ST가 나중에 경고를 띄우며 백필함)
            swipe_id: 0,
            swipes: [text],
            swipe_info: [{
                send_date: now,
                gen_started: null,
                gen_finished: null,
                extra: {},
            }],
        };

        // 캐릭터 아바타 지정 (그룹 채팅 등에서 아바타가 어긋나지 않도록)
        if (avatar) {
            message.original_avatar = avatar;
        }

        chat.push(message);

        // 화면에 렌더링
        if (typeof context.addOneMessage === "function") {
            await context.addOneMessage(message);
        }

        // 채팅 파일에 저장 -> 새로고침해도 남아있고 프롬프트 히스토리에도 포함됨
        if (typeof context.saveChat === "function") {
            await context.saveChat();
        }

        // 다른 확장들이 새 메시지를 인지할 수 있도록 이벤트 발생
        try {
            const idx = chat.length - 1;
            await context.eventSource.emit(context.eventTypes.MESSAGE_RECEIVED, idx);
            await context.eventSource.emit(context.eventTypes.CHARACTER_MESSAGE_RENDERED, idx);
        } catch (e) {
            console.warn("[주작버튼] 이벤트 발생 실패(무시 가능):", e);
        }

        if (getConfig().clearInput) {
            $textarea.val("").trigger("input");
        }

        console.log(`[주작버튼] 캐릭터 메시지 삽입됨 (${charName}, len=${text.length})`);
    } catch (e) {
        console.error("[주작버튼] 삽입 실패:", e);
        toastr?.error?.("삽입에 실패했어요. 콘솔을 확인해주세요.", "주작버튼");
    }
}

// ---------- 툴바 버튼 ----------

function applyButtonStyle() {
    const config = getConfig();
    $(`#${ICON_ID}`).text(config.emoji);
    $(`#${BTN_ID}`).css({
        width: `${config.iconSize}px`,
        height: `${config.iconSize}px`,
        flex: `0 0 ${config.iconSize}px`,
        fontSize: `${config.iconSize * 0.55}px`,
        marginRight: `${config.iconMarginRight}px`,
    });
}

function buildButton() {
    if ($(`#${BTN_ID}`).length) return; // 중복 삽입 방지

    const html = `<div id="${BTN_ID}" class="interactable" tabindex="0" title="입력창 내용을 캐릭터 메시지로 삽입"><span id="${ICON_ID}"></span></div>`;

    // 우선 Force Last Input Plus 버튼 왼쪽에 배치.
    // 그 확장이 없으면 전송 버튼 왼쪽으로 폴백.
    const $flip = $("#flip-toggle-btn");
    const $flipro = $("#flipro-toggle-btn");

    if ($flip.length) {
        $flip.before(html);
    } else if ($flipro.length) {
        $flipro.before(html);
    } else if ($("#send_but").length) {
        $("#send_but").before(html);
    } else {
        // 아직 UI가 안 그려졌으면 잠시 후 재시도
        setTimeout(buildButton, 500);
        return;
    }

    $(`#${BTN_ID}`).on("click", injectCharacterMessage);

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
                <label for="fakemsg-emoji-input">버튼 아이콘</label>
                <input id="fakemsg-emoji-input" class="text_pole" type="text" maxlength="10" value="${config.emoji}">

                <label for="fakemsg-icon-size-input">아이콘 크기 (px)</label>
                <input id="fakemsg-icon-size-input" class="text_pole" type="number" min="12" max="64" step="1" value="${config.iconSize}">

                <label for="fakemsg-icon-margin-input">오른쪽 여백 (px)</label>
                <input id="fakemsg-icon-margin-input" class="text_pole" type="number" min="0" max="40" step="1" value="${config.iconMarginRight}">

                <label class="checkbox_label" for="fakemsg-clear-input">
                    <input id="fakemsg-clear-input" type="checkbox" ${config.clearInput ? "checked" : ""}>
                    <span>삽입 후 입력창 비우기</span>
                </label>

                <small>💡 입력창에 글을 쓰고 버튼을 누르면, 유저 메시지가 아니라 <b>캐릭터 메시지</b>로 채팅에 삽입돼요. AI 응답은 받지 않고 삽입만 해요. 실제 채팅 기록에 저장되므로 편집/삭제/스와이프도 평소처럼 됩니다.</small>
            </div>
        </div>
    </div>
    `;

    const $target = $("#extensions_settings2").length ? $("#extensions_settings2") : $("#extensions_settings");
    $target.append(html);

    $("#fakemsg-emoji-input").on("input", function () {
        const val = $(this).val().trim() || DEFAULT_CONFIG.emoji;
        getConfig().emoji = val;
        saveConfig();
        applyButtonStyle();
    });

    $("#fakemsg-icon-size-input").on("input", function () {
        let val = parseInt($(this).val(), 10);
        if (isNaN(val)) return;
        val = Math.min(64, Math.max(12, val));
        getConfig().iconSize = val;
        saveConfig();
        applyButtonStyle();
    });

    $("#fakemsg-icon-margin-input").on("input", function () {
        let val = parseInt($(this).val(), 10);
        if (isNaN(val)) return;
        val = Math.min(40, Math.max(0, val));
        getConfig().iconMarginRight = val;
        saveConfig();
        applyButtonStyle();
    });

    $("#fakemsg-clear-input").on("change", function () {
        getConfig().clearInput = $(this).prop("checked");
        saveConfig();
    });
}

// ---------- 초기화 ----------

jQuery(async () => {
    buildButton();
    buildSettingsPanel();
});
