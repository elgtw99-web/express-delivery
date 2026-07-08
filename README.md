# 快遞物流狀態查詢系統

快遞100 即時查詢 + 簽收自動 LINE 通知。前端單頁 `index.html`，後端單檔 `server.js`。

## 功能
- 輸入**快遞單號 + 快遞公司**（可自動識別），即時查詢物流軌跡。
- 訂閱單號後交給快遞100監控，狀態變為**已簽收**時，自動用 **LINE Messaging API** 推播通知。
- 金鑰全部保存在後端 `.env`，前端不接觸密鑰。
- 示範模式：不需後端也能打開 `index.html` 預覽畫面與假資料。

## 你需要準備
1. **快遞100 企業版**：後台的 `customer`、`key`（及訂閱授權 key）。
2. **LINE Messaging API**：到 [LINE Developers](https://developers.line.biz/) 建立 Provider → Messaging API channel，取得 **Channel access token**；用 webhook 或加好友事件取得你的 **userId**（Uxxxx）。
   > ⚠️ LINE Notify 已於 2025/3/31 停用，本系統改用官方推薦的 Messaging API。
3. **一個公網網址**（給快遞100推送回呼用），需 HTTPS，例如自有網域、雲主機，或本機用 ngrok 對外。

## 安裝與啟動
```bash
# 1. 安裝套件（需 Node.js 18+）
npm install

# 2. 設定金鑰
cp .env.example .env
#   編輯 .env，填入快遞100與 LINE 的值
#   CALLBACK_URL 需為：https://你的網域/api/kd100/callback

# 3. 啟動
npm start
#   打開 http://localhost:3000
```

## 使用
1. 打開網頁，關閉右上「示範模式」。
2. 輸入單號、選快遞公司 → 按「查詢物流」看即時狀態。
3. 在「簽收 LINE 通知」區按「測試 LINE」確認能收到訊息。
4. 按「訂閱此單號」；簽收時系統會自動 LINE 通知你。

## 部署（GitHub → Render，推薦）
本專案已附 `render.yaml`，用 GitHub 一鍵部署最省事：

1. 把整個資料夾推上 GitHub（`.env` 已被 `.gitignore` 排除，金鑰不會外洩）：
   ```bash
   git init && git add . && git commit -m "init"
   git branch -M main
   git remote add origin https://github.com/你的帳號/你的repo.git
   git push -u origin main
   ```
2. 到 [Render](https://render.com/) → New → Blueprint → 連結這個 repo，它會讀取 `render.yaml` 自動建立服務。
3. 在 Render 服務的 **Environment** 頁填入密鑰（不要寫進程式碼）：
   `KD100_CUSTOMER`、`KD100_KEY`、`KD100_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`、`LINE_DEFAULT_TO`。
4. 部署完成後會得到固定網址 `https://<服務名>.onrender.com`；回到 Environment 把
   `CALLBACK_URL` 設為 `https://<服務名>.onrender.com/api/kd100/callback`，儲存後服務會自動重啟。
5. 打開 `https://<服務名>.onrender.com` 即可使用，前後端同網域、有固定 https、24 小時運作。

> Railway、Fly.io、自有 VPS 同理：設好上述環境變數、`node server.js` 即可。

## 本機測試（選用）
```bash
npm install
cp .env.example .env   # 填入金鑰
npm start              # http://localhost:3000
```
若要在本機測試簽收推送回呼，用 `ngrok http 3000` 取得臨時 https 網址，填進 `CALLBACK_URL`。

## 只要預覽畫面
不需後端時，直接雙擊 `index.html`（示範模式）即可看介面與假資料。

## 檔案
| 檔案 | 說明 |
|---|---|
| `index.html` | 前端查詢介面（單檔） |
| `server.js` | 後端：查詢代理 / 訂閱 / 快遞100回呼 / LINE 推播 |
| `.env.example` | 環境變數範本 |
| `package.json` | 相依套件 |
| `render.yaml` | Render 一鍵部署藍圖 |
| `.gitignore` | 排除金鑰/node_modules（保護密鑰） |
| `subscriptions.json` | 自動產生，儲存訂閱與通知狀態 |

## 快遞公司代碼
順豐 `shunfeng`、圓通 `yuantong`、中通 `zhongtong`、申通 `shentong`、韻達 `yunda`、京東 `jd`、EMS `ems`、百世 `huitongkuaidi`。
