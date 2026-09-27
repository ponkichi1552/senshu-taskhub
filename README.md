# 課題通知Hub

Google Classroomや専修大学のinCampusから届く課題・連絡をまとめ、締切と対応状況を確認するWebアプリです。Gmailの通知をGoogle Apps Scriptで取り込み、Googleスプレッドシートに保存します。Chrome拡張機能を使うと、ログイン中のClassroomやinCampusから締切時刻・提出状況などを補えます。

このREADMEのスクリーンショットは画面説明用のサンプルです。表示データはすべて架空です。

## 画面例

<table>
  <tr>
    <td><img src="docs/screenshots/taskhub-demo-home.png" alt="ホーム画面。今日まで・明日までの課題とメニューを表示" width="100%"></td>
    <td><img src="docs/screenshots/taskhub-demo-assignments.png" alt="未完了課題を締切ごとに表示" width="100%"></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/taskhub-demo-course-filter.png" alt="授業ごとの課題フィルター" width="100%"></td>
    <td><img src="docs/screenshots/taskhub-demo-university-notices.png" alt="大学からのお知らせ一覧と本文" width="100%"></td>
  </tr>
</table>

## できること

- Google ClassroomとinCampusの課題通知を、締切の近い順にまとめて表示します。
- 「今日まで」「明日まで」「今週中」などの区分、授業別フィルター、未完了・完了済み表示で課題を探せます。
- 課題の詳細を確認し、元の課題ページを開いたり、完了・未完了を切り替えたりできます。
- 新しい課題のブラウザー通知を利用できます。通知はブラウザーの許可設定が必要です。
- Google Classroomの締切時刻・提出状況を拡張機能から取り込み、保存済みの課題通知に反映します。
- 大学からのお知らせを検索し、未読・保存済みで絞り込めます。既読・保存状態はアカウントごとに保持します。
- スマートフォン幅の画面では、課題一覧やお知らせを読みやすい縦型表示で確認できます。

## 連携のしくみ

1. Apps Script Webアプリが、Gmailに届いたGoogle Classroom・inCampusの通知を読み取ります。
2. 通知と課題の状態は、アクセスしたGoogleアカウントごとのスプレッドシートに保存します。
3. Chrome拡張機能は、ログイン中のClassroomやinCampusの画面から不足する締切・課題情報を取得し、設定したWebアプリへ送ります。
4. Webアプリが保存済みの通知と照合し、課題一覧や大学からのお知らせに表示します。

このリポジトリの現行実装はGoogle Apps Script、Gmail、Googleスプレッドシート、Chrome拡張機能で構成されています。Supabase連携は含まれていません。

## 主な修正・改修

Codexの会話履歴と現在のソースを照合し、現行実装で確認できた変更をまとめています。

- **Classroom同期の照合を改善**：Classroomから来た課題だけをGmailに保存済みの課題と照合します。完了同期は一致した既存行の状態だけを更新し、未保存の課題を誤って完了扱いにしたり、別の課題を新規作成したりしないようにしました。
- **課題の重複・取り違えを抑制**：通知IDや課題キーを使って再送を判定します。ClassroomのURL・授業ID・課題IDなどで照合し、同期先が曖昧な場合は更新せず未一致として返します。
- **inCampusの複数更新メールに対応**：1通のメールに複数の授業・課題更新が含まれる場合、画面では更新単位に扱います。科目名・曜日時限・課題名を照合し、提出記録の再取得で完了状態が別の課題へ移らないようにしました。
- **締切時刻の扱いを修正**：時刻付きの0:00は前日の23:59として扱います。Classroomから時刻だけ届いた場合は、保存済みの日付を維持します。
- **同期失敗の見落としを防止**：拡張機能v2.5.8ではClassroomの各区分を集約し、送信量が大きい場合は分割します。プレビューや失敗を同期成功として記録せず、読み込み途中を「0件成功」と判定しないようにしました。
- **Gmail取り込みのロック待ちを短縮**：2026-09-27のApps Script更新では、時間のかかるGmail検索中に共有ロックを保持しない構成にしました。保存直前にメッセージIDを再確認し、重複追記を避けます。変更のない行はシートへ書き戻しません。
- **保存データを整理**：通知は受信日時の新しい順に並べ、2暦月より古い通知行をシート整理時に削除します。Gmail上のメールは削除しません。期限切れ課題や期限不明のまま1週間経過した課題は未完了一覧から外します。
- **大学からのお知らせ画面を追加**：Gmailの通知を基準に、本文・既読・保存状態を確認できる画面を追加しました。検索と未読・保存済みの絞り込みに対応します。
- **APIトークンの扱いを改善**：拡張機能から送るトークンをURLへ含めません。保存済みのトークンは画面に再表示せず、発行直後にだけコピーできるようにしています。

## ファイル構成

- [`課題hub/taskhub-split/taskhub-split/`](./課題hub/taskhub-split/taskhub-split/) — Apps Script Webアプリ本体
- [`課題hub/taskhub-split/workspace/taskhub-split/`](./課題hub/taskhub-split/workspace/taskhub-split/) — 本体ソースのworkspaceミラー
- [`課題hub/taskhub-extension-v2.5/`](./課題hub/taskhub-extension-v2.5/) — Chrome拡張機能 v2.5.8
- [`課題hub/taskhub-split/taskhub-split/MAIL_LINKING.md`](./課題hub/taskhub-split/taskhub-split/MAIL_LINKING.md) — Gmail通知と拡張機能データの照合仕様
- [`課題hub/taskhub-split/taskhub-split/STORAGE.md`](./課題hub/taskhub-split/taskhub-split/STORAGE.md) — 保存期間・状態管理・移行時の注意
- [`課題hub/taskhub-extension-v2.5/README.md`](./課題hub/taskhub-extension-v2.5/README.md) — 拡張機能の導入・設定方法

## 利用を始める

本体のファイルをApps Scriptへ反映してWebアプリとしてデプロイし、Chromeでは拡張機能フォルダーを「パッケージ化されていない拡張機能」として読み込みます。拡張機能には、自分のWebアプリURLと本体で発行したAPIトークンを設定します。詳しい手順とClassroom・inCampusの対応範囲は[拡張機能README](./課題hub/taskhub-extension-v2.5/README.md)を参照してください。

このアプリはGoogleアカウントのGmail・スプレッドシート権限を使います。利用者ごとの設定でWebアプリをデプロイし、各自のGoogleアカウントで承認して使用してください。APIトークンや実データを公開リポジトリやスクリーンショットへ含めないでください。
