---
description: バージョンを更新してコミットし Cloudflare Workers へリリースする
---

以下の手順でリリースしてください。

1. `git status` と `git diff` で未コミットの変更を確認する
2. `public/js/app.js` の `VERSION` 定数を更新する
   - `date`: 今日の日付（YYYY-MM-DD 形式）
   - `count`: 現在の値に +1
3. `public/service-worker.js` の `VERSION` を `{date}-{count}`（例: `2026-10-20-7`）に更新する
   - **必須**。ここが変わらないと Service Worker が更新を検出せず、利用者の端末に古い版が残り続ける
4. ライブラリ（zxing-wasm / papaparse）を更新した場合は `npm run vendor` で `public/vendor/` を作り直す
5. `npm test` が通ることを確認する
6. 変更があれば、過去のコミット履歴（`git log --oneline -10`）のスタイルに合わせた日本語のコミットメッセージを考える
7. 変更ファイルを `git add` して `git commit` する（Co-Authored-By フッターを付ける）
8. `git push origin main` する
9. `npm run deploy` で Cloudflare Workers へ公開する（テスト → `wrangler deploy`。未ログインなら `npx wrangler login`）
10. 公開 URL（`wrangler deploy` の出力に出る `https://scan-app.<サブドメイン>.workers.dev`）と新しいバージョン番号を案内する
    - 利用者の端末では次回起動時に「新しいバージョンがあります」バナーが出て、「更新」で切り替わる

変更がなければ「リリース済みです」と伝える。
