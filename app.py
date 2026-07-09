# -*- coding: utf-8 -*-
"""
快遞物流狀態查詢系統 - 網頁小工具
在你自己的電腦上執行，瀏覽器開 http://127.0.0.1:5000

功能：
  1. 貼上/上傳快遞單號（自動辨識快遞公司）
  2. 表格檢視每筆物流狀態
  3. 背景自動定時檢查，簽收/異常時 LINE 第一時間推播
  4. 設定頁填入 kuaidi100 與 LINE 憑證（存本機 config.json）
"""
import json
import os
import threading
import time
import uuid
from datetime import datetime

from flask import Flask, request, redirect, url_for, jsonify, render_template_string

import tracker

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(BASE_DIR, "config.json")
DATA_FILE = os.path.join(BASE_DIR, "data.json")

DEFAULT_CONFIG = {
    "kuaidi_key": "",
    "kuaidi_customer": "",
    "line_token": "",
    "line_to": "",
    "poll_interval_min": 60,
    "auto_poll": True,
}

_lock = threading.Lock()
app = Flask(__name__)


# ----------------------- 資料存取 -----------------------
def load_json(path, default):
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return json.loads(json.dumps(default))
    return json.loads(json.dumps(default))


def save_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def get_config():
    cfg = load_json(CONFIG_FILE, DEFAULT_CONFIG)
    for k, v in DEFAULT_CONFIG.items():
        cfg.setdefault(k, v)
    return cfg


def get_items():
    return load_json(DATA_FILE, [])


def save_items(items):
    save_json(DATA_FILE, items)


# ----------------------- 核心動作 -----------------------
def add_numbers(raw_text):
    """raw_text 每行一筆，格式：單號  或  單號,備註  或  單號,備註,電話"""
    cfg = get_config()
    items = get_items()
    existing = {i["num"] for i in items}
    added, skipped = 0, 0
    for line in raw_text.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = [p.strip() for p in line.replace("\t", ",").split(",")]
        num = parts[0]
        note = parts[1] if len(parts) > 1 else ""
        phone = parts[2] if len(parts) > 2 else ""
        if not num or len(num) < 6:
            continue
        if num in existing:
            skipped += 1
            continue
        # 自動辨識快遞公司
        com, com_name = "", ""
        if cfg.get("kuaidi_key"):
            cands = tracker.detect_company(num, cfg["kuaidi_key"])
            if cands:
                com, com_name = cands[0]
        items.append({
            "id": uuid.uuid4().hex[:8],
            "num": num,
            "com": com,
            "com_name": com_name or tracker.COMMON_COMPANIES.get(com, ""),
            "phone": phone,
            "note": note,
            "state": "",
            "state_name": "尚未查詢",
            "last_time": "",
            "last_context": "",
            "notified": False,
            "error": "",
            "added_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
            "signed_at": "",
        })
        existing.add(num)
        added += 1
    save_items(items)
    return added, skipped


def check_all(only_active=True):
    """查詢所有（未結案的）單號，必要時 LINE 推播。回傳 (檢查數, 新通知數)"""
    with _lock:
        cfg = get_config()
        items = get_items()
        checked, notified = 0, 0
        for it in items:
            if only_active and it.get("state") in ("3", "4", "14"):
                continue  # 已結案不再查
            if not it.get("com"):
                # 沒有公司代碼，嘗試再辨識一次
                if cfg.get("kuaidi_key"):
                    cands = tracker.detect_company(it["num"], cfg["kuaidi_key"])
                    if cands:
                        it["com"], it["com_name"] = cands[0][0], cands[0][1]
                if not it.get("com"):
                    it["error"] = "無法辨識快遞公司，請手動指定代碼"
                    continue
            res = tracker.query_one(
                it["num"], it["com"], cfg.get("kuaidi_key", ""),
                cfg.get("kuaidi_customer", ""), it.get("phone", ""),
            )
            checked += 1
            if not res.get("ok"):
                it["error"] = res.get("message", "查詢失敗")
                continue
            it["error"] = ""
            new_state = res.get("state", "")
            it["state"] = new_state
            it["state_name"] = res.get("state_name", "")
            it["last_time"] = res.get("last_time", "")
            it["last_context"] = res.get("last_context", "")
            # 進入需通知狀態，且尚未通知過 -> 推播
            if new_state in tracker.NOTIFY_STATES and not it.get("notified"):
                text = tracker.build_notify_text(it)
                push = tracker.send_line(cfg.get("line_token", ""), cfg.get("line_to", ""), text)
                if push.get("ok"):
                    it["notified"] = True
                    notified += 1
                    if new_state == tracker.SIGNED_STATE:
                        it["signed_at"] = datetime.now().strftime("%Y-%m-%d %H:%M")
                else:
                    it["error"] = push.get("message", "")
            time.sleep(0.3)  # 輕微間隔，避免打太快
        save_items(items)
        return checked, notified


# ----------------------- 背景自動檢查 -----------------------
def background_loop():
    while True:
        try:
            cfg = get_config()
            if cfg.get("auto_poll") and cfg.get("kuaidi_key") and cfg.get("kuaidi_customer"):
                check_all()
        except Exception as e:
            print("背景檢查錯誤:", e)
        interval = max(10, int(get_config().get("poll_interval_min", 60))) * 60
        time.sleep(interval)


# ----------------------- 網頁 -----------------------
PAGE = """
<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>快遞物流狀態查詢系統</title>
<style>
  body{font-family:"Microsoft JhengHei","PingFang TC",sans-serif;margin:0;background:#f4f6f8;color:#222}
  header{background:#0b6b3a;color:#fff;padding:16px 24px;display:flex;justify-content:space-between;align-items:center}
  header h1{font-size:20px;margin:0}
  header a{color:#cdefd8;text-decoration:none;font-size:14px;margin-left:16px}
  .wrap{max-width:1080px;margin:20px auto;padding:0 16px}
  .card{background:#fff;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.08);padding:18px 20px;margin-bottom:18px}
  textarea{width:100%;box-sizing:border-box;min-height:90px;border:1px solid #ccc;border-radius:6px;padding:10px;font-size:14px}
  .btn{background:#0b6b3a;color:#fff;border:0;border-radius:6px;padding:9px 18px;font-size:14px;cursor:pointer}
  .btn.gray{background:#667}
  .btn.small{padding:4px 10px;font-size:12px}
  .hint{color:#666;font-size:12.5px;margin:6px 0}
  table{width:100%;border-collapse:collapse;font-size:13.5px}
  th,td{border-bottom:1px solid #eee;padding:8px 6px;text-align:left;vertical-align:top}
  th{background:#fafafa;color:#555;font-weight:600}
  .tag{display:inline-block;padding:2px 9px;border-radius:20px;font-size:12px;color:#fff;white-space:nowrap}
  .s3{background:#188a42}.s5{background:#e08e0b}.s0,.s1{background:#3577c2}.s2,.s4,.s14{background:#c0392b}.sx{background:#999}
  .banner{padding:10px 14px;border-radius:8px;margin-bottom:14px;font-size:14px}
  .warn{background:#fff4e5;border:1px solid #ffcf8b;color:#8a5a00}
  .ok{background:#e8f6ee;border:1px solid #bfe6cd;color:#0b6b3a}
  .err{color:#c0392b;font-size:12px}
  code{background:#eef;padding:1px 5px;border-radius:4px}
</style></head><body>
<header>
  <h1>📦 快遞物流狀態查詢系統</h1>
  <div><a href="/">首頁</a><a href="/settings">設定</a></div>
</header>
<div class="wrap">
  {% if not configured %}
  <div class="banner warn">尚未完成設定：請先到 <a href="/settings">設定頁</a> 填入 kuaidi100 的 key/customer 與 LINE 憑證，系統才能查詢與推播。</div>
  {% else %}
  <div class="banner ok">設定完成 ✓ 背景每 {{cfg.poll_interval_min}} 分鐘自動檢查一次{% if cfg.auto_poll %}（已開啟）{% else %}（目前關閉）{% endif %}。</div>
  {% endif %}

  <div class="card">
    <h3 style="margin-top:0">➕ 新增快遞單號</h3>
    <form method="post" action="/add">
      <textarea name="numbers" placeholder="每行一筆，可只貼單號，或用逗號帶備註與電話：&#10;780123456789&#10;SF1234567890,A客戶洋裝,0912345678&#10;773998877665,B批發鞋"></textarea>
      <div class="hint">格式：<code>單號</code> 或 <code>單號,備註</code> 或 <code>單號,備註,收件電話</code>（順豐/中通建議填電話）。系統會自動辨識快遞公司。</div>
      <button class="btn" type="submit">加入清單</button>
    </form>
  </div>

  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3 style="margin:0">📋 追蹤清單（{{items|length}} 筆）</h3>
      <form method="post" action="/check" style="margin:0">
        <button class="btn" type="submit">🔄 立即檢查全部</button>
      </form>
    </div>
    {% if msg %}<div class="hint" style="color:#0b6b3a">{{msg}}</div>{% endif %}
    <table>
      <tr><th>狀態</th><th>單號</th><th>快遞公司</th><th>備註</th><th>最新動態</th><th>加入時間</th><th></th></tr>
      {% for it in items %}
      <tr>
        <td><span class="tag s{{it.state or 'x'}}">{{it.state_name}}</span>{% if it.notified %}<div class="hint">已推播 ✓</div>{% endif %}</td>
        <td>{{it.num}}</td>
        <td>{{it.com_name or it.com or '—'}}</td>
        <td>{{it.note}}</td>
        <td>{{it.last_context}}<div class="hint">{{it.last_time}}</div>{% if it.error %}<div class="err">{{it.error}}</div>{% endif %}</td>
        <td class="hint">{{it.added_at}}</td>
        <td><a class="btn gray small" href="/delete/{{it.id}}" onclick="return confirm('刪除這筆？')">刪除</a></td>
      </tr>
      {% endfor %}
      {% if not items %}<tr><td colspan="7" class="hint">清單是空的，先在上面新增單號吧。</td></tr>{% endif %}
    </table>
  </div>
</div>
<script>
  // 每 60 秒自動重新整理狀態
  setTimeout(function(){location.reload();}, 60000);
</script>
</body></html>
"""

SETTINGS_PAGE = """
<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>設定</title>
<style>
  body{font-family:"Microsoft JhengHei","PingFang TC",sans-serif;margin:0;background:#f4f6f8;color:#222}
  header{background:#0b6b3a;color:#fff;padding:16px 24px;display:flex;justify-content:space-between;align-items:center}
  header h1{font-size:20px;margin:0}header a{color:#cdefd8;text-decoration:none;margin-left:16px;font-size:14px}
  .wrap{max-width:720px;margin:20px auto;padding:0 16px}
  .card{background:#fff;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.08);padding:20px 22px;margin-bottom:18px}
  label{display:block;font-weight:600;margin:14px 0 4px;font-size:14px}
  input{width:100%;box-sizing:border-box;border:1px solid #ccc;border-radius:6px;padding:9px;font-size:14px}
  .btn{background:#0b6b3a;color:#fff;border:0;border-radius:6px;padding:10px 20px;font-size:14px;cursor:pointer}
  .btn.gray{background:#667}
  .hint{color:#666;font-size:12.5px;margin:4px 0}
  .row{display:flex;gap:14px}.row>div{flex:1}
  .msg{padding:10px 14px;border-radius:8px;margin-bottom:14px;font-size:14px;background:#e8f6ee;border:1px solid #bfe6cd;color:#0b6b3a}
</style></head><body>
<header><h1>⚙️ 設定</h1><div><a href="/">首頁</a><a href="/settings">設定</a></div></header>
<div class="wrap">
  {% if msg %}<div class="msg">{{msg}}</div>{% endif %}
  <form method="post" action="/settings">
    <div class="card">
      <h3 style="margin-top:0">kuaidi100 查詢憑證</h3>
      <div class="hint">於 kuaidi100 API 開放平台 → 我的 → 授權碼取得（免費申請）。</div>
      <label>API Key（授權 key）</label>
      <input name="kuaidi_key" value="{{cfg.kuaidi_key}}" placeholder="例如 abcdEFGH...">
      <label>Customer（授權碼 customer）</label>
      <input name="kuaidi_customer" value="{{cfg.kuaidi_customer}}" placeholder="例如 A1B2C3D4E5...">
    </div>
    <div class="card">
      <h3 style="margin-top:0">LINE 推播憑證</h3>
      <div class="hint">於 LINE Developers 建立 Messaging API 頻道取得 Channel access token；userId 為你的 LINE 使用者 ID。</div>
      <label>Channel access token</label>
      <input name="line_token" value="{{cfg.line_token}}" placeholder="長字串 token">
      <label>推播對象 userId</label>
      <input name="line_to" value="{{cfg.line_to}}" placeholder="U 開頭的一長串">
    </div>
    <div class="card">
      <h3 style="margin-top:0">自動檢查</h3>
      <div class="row">
        <div>
          <label>檢查間隔（分鐘）</label>
          <input name="poll_interval_min" type="number" min="10" value="{{cfg.poll_interval_min}}">
          <div class="hint">越短越即時，但會消耗較多查詢次數。建議 30～60。</div>
        </div>
        <div>
          <label>啟用背景自動檢查</label>
          <select name="auto_poll" style="width:100%;padding:9px;border:1px solid #ccc;border-radius:6px">
            <option value="1" {{'selected' if cfg.auto_poll else ''}}>開啟</option>
            <option value="0" {{'' if cfg.auto_poll else 'selected'}}>關閉</option>
          </select>
        </div>
      </div>
    </div>
    <button class="btn" type="submit">儲存設定</button>
    <a class="btn gray" href="/test-line" style="text-decoration:none">送測試 LINE 推播</a>
  </form>
</div></body></html>
"""


def is_configured(cfg):
    return bool(cfg.get("kuaidi_key") and cfg.get("kuaidi_customer")
               and cfg.get("line_token") and cfg.get("line_to"))


@app.route("/")
def index():
    cfg = get_config()
    return render_template_string(
        PAGE, items=get_items(), cfg=cfg,
        configured=is_configured(cfg), msg=request.args.get("msg", ""),
    )


@app.route("/add", methods=["POST"])
def add():
    added, skipped = add_numbers(request.form.get("numbers", ""))
    return redirect(url_for("index", msg=f"已新增 {added} 筆，略過重複 {skipped} 筆。"))


@app.route("/check", methods=["POST"])
def check():
    checked, notified = check_all()
    return redirect(url_for("index", msg=f"檢查 {checked} 筆，本次推播 {notified} 則通知。"))


@app.route("/delete/<item_id>")
def delete(item_id):
    items = [i for i in get_items() if i["id"] != item_id]
    save_items(items)
    return redirect(url_for("index", msg="已刪除。"))


@app.route("/settings", methods=["GET", "POST"])
def settings():
    cfg = get_config()
    msg = ""
    if request.method == "POST":
        cfg["kuaidi_key"] = request.form.get("kuaidi_key", "").strip()
        cfg["kuaidi_customer"] = request.form.get("kuaidi_customer", "").strip()
        cfg["line_token"] = request.form.get("line_token", "").strip()
        cfg["line_to"] = request.form.get("line_to", "").strip()
        try:
            cfg["poll_interval_min"] = max(10, int(request.form.get("poll_interval_min", 60)))
        except ValueError:
            cfg["poll_interval_min"] = 60
        cfg["auto_poll"] = request.form.get("auto_poll", "1") == "1"
        save_json(CONFIG_FILE, cfg)
        msg = "設定已儲存 ✓"
    return render_template_string(SETTINGS_PAGE, cfg=cfg, msg=msg)


@app.route("/test-line")
def test_line():
    cfg = get_config()
    res = tracker.send_line(cfg.get("line_token", ""), cfg.get("line_to", ""),
                            "🔔 快遞物流狀態查詢系統：這是一則測試推播，收到代表設定成功！")
    return render_template_string(SETTINGS_PAGE, cfg=cfg,
                                  msg=("測試推播成功 ✓" if res.get("ok") else "測試失敗：" + res.get("message", "")))


if __name__ == "__main__":
    # 啟動背景自動檢查執行緒
    t = threading.Thread(target=background_loop, daemon=True)
    t.start()
    print("=" * 46)
    print("  快遞物流狀態查詢系統已啟動")
    print("  請用瀏覽器開啟： http://127.0.0.1:5000")
    print("  （關閉此視窗即停止服務）")
    print("=" * 46)
    app.run(host="127.0.0.1", port=5000, debug=False)
