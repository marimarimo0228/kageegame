// js/constants.js — アプリ全体で共有する定数
//
// ⚠️ 以下のキーを変更すると localStorage に保存済みの骨格データが読めなくなります。
//    変更する場合は必ず game.js の loadManualRefsFromStorage と
//    editor.js の _loadStorage / _saveDataToStorage / _removeFromStorage も
//    同時に移行処理を追加してください。

window.KAGEE_MANUAL_REFS_KEY = 'kagee_manual_refs';
