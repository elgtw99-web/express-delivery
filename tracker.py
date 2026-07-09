# -*- coding: utf-8 -*-
"""
快遞物流狀態查詢系統 - 核心引擎
- kuaidi100 實時查詢 API（自動辨識快遞公司、查詢物流狀態）
- LINE Messaging API 推播（簽收/異常時第一時間通知）

作者備註：
  查詢簽名規則  sign = 大寫(MD5(param + key + customer))
  簽收判斷      回傳 state == "3" 代表已簽收
"""
import hashlib
import json
import requests

KUAIDI_QUERY_URL = "https://poll.kuaidi100.com/poll/query.do"
KUAIDI_AUTO_URL = "https://www.kuaidi100.com/autonumber/auto"
LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push"

# kuaidi100 基礎物流狀態值對照（state）
STATE_NAMES = {
    "0": "在途中",
    "1": "已攬收",
    "2": "疑難件",
    "3": "已簽收",
    "4": "退簽",
    "5": "派件中",
    "6": "退回",
    "7": "轉投",
    "8": "清關中",
    "10": "待清關",
    "11": "清關完成",
    "12": "清關異常",
    "13": "拒收",
    "14": "拒簽",
}

# 觸發 LINE 通知的狀態（進入這些狀態時通知一次）
# 3 簽收 / 4 退簽 / 14 拒簽 / 2 疑難 -> 都需要你處理後續
NOTIFY_STATES = {"3", "4", "14", "2"}
SIGNED_STATE = "3"

# 常用大陸快遞公司代碼（自動辨識失敗時可手動選）
COMMON_COMPANIES = {
    "shunfeng": "順豐速運",
    "yuantong": "圓通速遞",
    "zhongtong": "中通快遞",
    "shentong": "申通快遞",
    "yunda": "韻達速遞",
    "jtexpress": "極兔速遞",
    "jd": "京東物流",
    "ems": "郵政EMS",
    "youzhengguonei": "郵政包裹/平郵",
    "debangkuaidi": "德邦快遞",
    "debangwuliu": "德邦物流",
    "huitongkuaidi": "百世快遞",
    "zhaijisong": "宅急送",
    "youshuwuliu": "優速快遞",
    "annengwuliu": "安能物流",
    "kuayue": "跨越速運",
}


class KuaidiError(Exception):
    pass


def _md5_upper(s: str) -> str:
    return hashlib.md5(s.encode("utf-8")).hexdigest().upper()


def detect_company(num: str, key: str, timeout: int = 10):
    """用 kuaidi100 自動辨識單號所屬快遞公司，回傳候選代碼清單 [(code, name), ...]。"""
    try:
        r = requests.get(
            KUAIDI_AUTO_URL,
            params={"num": num.strip(), "key": key},
            timeout=timeout,
        )
        data = r.json()
        result = []
        for item in data:
            code = item.get("comCode") or item.get("comcode")
            name = item.get("name") or COMMON_COMPANIES.get(code, code)
            if code:
                result.append((code, name))
        return result
    except Exception:
        return []


def query_one(num, com, key, customer, phone="", timeout: int = 15):
    """
    查詢單一單號物流狀態。
    回傳 dict: {ok, state, state_name, last_time, last_context, message, raw}
    """
    num = (num or "").strip()
    com = (com or "").strip()
    if not (key and customer):
        return {"ok": False, "message": "尚未設定 kuaidi100 API 金鑰（key / customer）"}
    if not com:
        return {"ok": False, "message": "缺少快遞公司代碼（com）"}

    param_dict = {"com": com, "num": num, "resultv2": "4"}
    if phone:
        param_dict["phone"] = str(phone).strip()
    # param 必須是「送出去的那個字串」與簽名字串完全一致
    param_str = json.dumps(param_dict, ensure_ascii=False, separators=(",", ":"))
    sign = _md5_upper(param_str + key + customer)

    payload = {
        "customer": customer,
        "sign": sign,
        "param": param_str,
    }
    try:
        r = requests.post(KUAIDI_QUERY_URL, data=payload, timeout=timeout)
        data = r.json()
    except Exception as e:
        return {"ok": False, "message": f"查詢連線失敗：{e}"}

    # 失敗回傳格式：{"result":false,"returnCode":"xxx","message":"..."}
    if isinstance(data, dict) and data.get("returnCode") and data.get("returnCode") not in ("200", 200):
        return {
            "ok": False,
            "message": f"{data.get('message','查詢失敗')}（代碼 {data.get('returnCode')}）",
            "raw": data,
        }

    state = str(data.get("state", "")).strip()
    state_name = STATE_NAMES.get(state, f"狀態{state}" if state else "未知")
    items = data.get("data") or []
    last_time = items[0].get("ftime") or items[0].get("time") if items else ""
    last_context = items[0].get("context") if items else ""
    return {
        "ok": True,
        "state": state,
        "state_name": state_name,
        "last_time": last_time,
        "last_context": last_context,
        "message": "查詢成功",
        "raw": data,
    }


def send_line(token, to, text, timeout: int = 10):
    """透過 LINE Messaging API 推播文字訊息。"""
    if not (token and to):
        return {"ok": False, "message": "尚未設定 LINE 憑證（token / userId）"}
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    body = {"to": to, "messages": [{"type": "text", "text": text[:4900]}]}
    try:
        r = requests.post(LINE_PUSH_URL, headers=headers, json=body, timeout=timeout)
        if r.status_code == 200:
            return {"ok": True, "message": "推播成功"}
        return {"ok": False, "message": f"LINE 推播失敗（{r.status_code}）：{r.text[:200]}"}
    except Exception as e:
        return {"ok": False, "message": f"LINE 連線失敗：{e}"}


def build_notify_text(item):
    """組出要推播的通知文字。"""
    state = item.get("state", "")
    if state == SIGNED_STATE:
        head = "✅ 已簽收"
    elif state == "2":
        head = "⚠️ 疑難件，請留意"
    elif state in ("4", "14"):
        head = "❌ 退簽 / 拒簽，需要處理"
    else:
        head = "📦 物流狀態更新"
    lines = [
        f"{head}",
        f"單號：{item.get('num','')}",
        f"快遞：{item.get('com_name') or item.get('com','')}",
    ]
    if item.get("note"):
        lines.append(f"備註：{item['note']}")
    if item.get("last_context"):
        lines.append(f"最新動態：{item['last_context']}")
    if item.get("last_time"):
        lines.append(f"時間：{item['last_time']}")
    return "\n".join(lines)
