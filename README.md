# Audio Spectrum Analyzer & Recorder (GitHub Pages)

静的サイトで動く、音楽解析スペクトラム（棒/波形/円形）＋背景画像合成＋録画→MP4出力ツールです。

## 使い方
1. `音楽ファイル（Audio）` を選択
2. `初期化` をクリック（Web Audioの解析を有効化）
3. `Play` で再生
4. `Record` で録画開始（録画中もグラフ種類の切替OK）
5. `Stop` で停止
6. `MP4をダウンロード`

## 注意
- 多くのブラウザは `MediaRecorder` の `video/mp4` を直接サポートしません。
  - その場合、本ツールは WebM で録画し、ページ内で `ffmpeg.wasm` により MP4へ変換します（重い処理）。
- 推奨: Chrome / Edge
- Safari は MediaRecorder/codec 周りが不安定なことがあります。

## GitHub Pages 公開
- このフォルダをそのままリポジトリにpush
- GitHub > Settings > Pages > Deploy from a branch
- Branch: `main` / Folder: `/root`
