# 初級大人手冊 · 百科公開網站（產物）

這個 repo **只放對外公開的百科網頁產物**（HTML＋圖片），提供給搜尋引擎與 AI 索引。

## 鐵律（安全）

- **只放 `build_site.py` 產出的成品**：`index.html`、`a/*.html`、`assets/*.png`。
- **絕不放**：App 原始碼、查證腳本、`build_site.py` 本身、任何金鑰／`.env`／備份／Supabase 匯出的 `.json`。
- 這些都留在**私有主 repo**（`初級大人手冊/`）。這個公開 repo 被任何人下載都不會外洩程式碼。

## 內容從哪來

私有主 repo 的 `web版/build_site.py` 從 Supabase `encyclopedia_articles` 生成。
唯一事實來源是 Supabase，不在這裡直接改 HTML。

## 更新流程

1. 在 Supabase 改內容（走既有查證／校對台紀律）。
2. 私有主 repo 跑 `python3 web版/build_site.py`。
3. 把 `web版/site/` 的內容覆蓋到這個 repo。
4. `git commit` → `git push`（對外發佈，需站長確認）。

## 部署（GitHub Pages）

- Settings → Pages → Source：`main` branch、根目錄 `/`。
- `.nojekyll` 已放，避免 Jekyll 處理。
- 之後掛自有網域：Pages → Custom domain。

## 圖片授權

banner 為 AI 生成，站長確認可商用／公開。
