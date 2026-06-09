---
description: バージョンを更新してコミットし GitHub Pages へリリースする
---

以下の手順でリリースしてください。

1. `git status` と `git diff` で未コミットの変更を確認する
2. `js/app.js` の `VERSION` 定数を更新する
   - `date`: 今日の日付（YYYY-MM-DD 形式）
   - `count`: 現在の値に +1
3. `index.html` の CSS・JS 参照のクエリ文字列を更新する（キャッシュバスティング）
   - `css/style.css?v=YYYY-MM-DD-N` の `v=` の値を新しいバージョンに合わせる
   - `js/app.js?v=YYYY-MM-DD-N` の `v=` の値を新しいバージョンに合わせる
   - バージョン形式: `{date}-{count}`（例: `2026-06-09-18`）
4. 変更があれば、過去のコミット履歴（`git log --oneline -10`）のスタイルに合わせた日本語のコミットメッセージを考える
5. 変更ファイルを `git add` して `git commit` する（Co-Authored-By フッターを付ける）
6. `git push origin main` で GitHub Pages へリリースする
7. リリース先 URL `https://nobuyuki-inaba.github.io/scan-app/` と新しいバージョン番号を案内する

変更がなければ「リリース済みです」と伝える。
