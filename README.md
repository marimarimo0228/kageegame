# 影絵採点ゲーム

**▶ ブラウザですぐに遊べます → https://kageegame.vercel.app/**

カメラの前で手をかざし、お題のシルエットに合わせたポーズを作って採点を競うブラウザゲームです。

## 概要

MediaPipe Hands で手の骨格をリアルタイム検出し、Teachable Machine で学習したモデルと骨格ベクトル・シルエット照合の3つの指標を組み合わせてスコアを算出します。PWA 対応のため、インストールしてオフラインでも遊べます。

## ゲームの流れ

1. **タイトル画面** — スタートボタンを押す（初回はチュートリアルへ）
2. **カウントダウン** — 3・2・1・GO!
3. **プレイ画面** — 12秒間、左のシルエットに合わせてポーズをとる（3問）
4. **結果画面** — 平均スコアとランキング順位を表示
5. **蓄積アート画面** — 過去プレイヤーの骨格が重なったアートを表示

## お題の種類

| ポーズ | ラベル | 備考 |
|--------|--------|------|
| choki | チョキ | チュートリアル専用（本番には出題されない） |
| dog   | イヌ  | 本番出題 |
| bird  | ハト  | 本番出題・両手ポーズ |
| crab  | カニ  | 本番出題・両手ポーズ |

## スコアリング

| 指標 | 通常ゲーム | チュートリアル |
|------|-----------|---------------|
| Teachable Machine（画像分類） | 50% | 使用しない |
| 骨格ベクトルスコア | 30% | 60% |
| シルエット照合スコア | 20% | 40% |

手が検出されない場合は強制 0 点。左右ミラー・手の組み合わせ（2手ポーズ）を自動で最適化して採点します。

## 主な機能

- **チュートリアル** — 初回プレイ時に自動起動。キャラクターがルールを説明
- **骨格調整（キャリブレーション）** — ポーズごとに参照骨格をドラッグ編集して登録できる
- **ランキング** — localStorage にハイスコアを保存、タイトルに上位3件を表示
- **蓄積アート** — プレイごとに骨格スナップショットを保存し、アート画面で重ね表示
- **PWA** — manifest.json + Service Worker でインストール・オフライン動作に対応

## ファイル構成

```
kageegame/
├── index.html           # メイン HTML（全画面定義）
├── style.css            # スタイルシート
├── manifest.json        # PWA マニフェスト
├── sw.js                # Service Worker
├── js/
│   ├── camera.js        # カメラ初期化・MediaPipe Hands 制御
│   ├── classifier.js    # Teachable Machine 分類・シルエット照合・スコア合成
│   ├── poseExtractor.js # 骨格ベクトル抽出・スコア計算
│   ├── game.js          # ゲーム進行・キャリブレーション管理
│   ├── tutorial.js      # チュートリアルオーバーレイ制御
│   ├── effects.js       # パーティクル等のエフェクト
│   ├── artCanvas.js     # 蓄積アートキャンバス描画
│   ├── snapshot.js      # スナップショット保存・読込
│   └── ranking.js       # ランキング管理
├── models/
│   ├── model.json       # Teachable Machine モデル（3クラス: dog/bird/crab）
│   ├── metadata.json    # クラスラベル定義
│   └── weights.bin      # モデル重み
├── poses/
│   └── poses.json       # お題定義（name/label/image/answerImage）
└── assets/
    ├── silhouettes/     # お題シルエット画像（通常・採点用の2種）
    └── tutorial-character*.png  # チュートリアルキャラクター画像
```

## プレイ方法

### オンライン（推奨）

**https://kageegame.vercel.app/** をブラウザで開き、カメラのアクセス許可を付与するだけで遊べます。インストール不要です。

### ローカル起動

`file://` プロトコルでは TensorFlow.js モデルの読み込みが失敗するため、HTTP サーバーが必要です。

```bash
# Node.js がある場合
npx http-server .

# Python がある場合
python -m http.server 8080
```

ブラウザで `http://localhost:8080` を開き、カメラのアクセス許可を付与してください。

## 使用ライブラリ（CDN）

| ライブラリ | 用途 |
|-----------|------|
| [MediaPipe Hands](https://developers.google.com/mediapipe/solutions/vision/hand_landmarker) | 手の骨格検出（21点ランドマーク） |
| [TensorFlow.js](https://www.tensorflow.org/js) | Teachable Machine の依存ライブラリ |
| [Teachable Machine Image](https://teachablemachine.withgoogle.com/) | ポーズ画像分類モデルの推論 |
