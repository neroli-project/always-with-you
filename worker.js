/**
 * My Sweet AI - Cloudflare Workers バックエンド＋静的サイト配信合体版 (worker.js)
 * 
 * 【GitHubリポジトリのファイル構成（すべて一番上の階層に並べるだけ！）】
 * 1. index.html    (ai_boyfriend_app.html の中身)
 * 2. worker.js     (このファイル)
 * 3. wrangler.toml (設定ファイル)
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  // ==========================================
  // 1. アプリ画面の配信 ＆ APIリクエスト処理
  // ==========================================
  async fetch(request, env, ctx) {
    // プリフライトリクエスト（CORS）対応
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    try {
      // 【API 1】接続テスト用ヘルスチェック
      if (request.method === "GET" && url.pathname === "/api/health") {
        return jsonResponse({ status: "My Sweet AI Worker is running!" });
      }

      // 【API 2】KVに保存された最新データ（Cronで届いたメッセージ等）を取得
      if (request.method === "GET" && (url.pathname === "/api/sync" || url.pathname === "/sync")) {
        if (!env.BOYFRIEND_KV) {
          return jsonResponse({ synced: false, reason: "KV_NOT_BOUND" });
        }
        const savedData = await env.BOYFRIEND_KV.get("app_state", { type: "json" });
        return jsonResponse({ synced: true, state: savedData || null });
      }

      // 【API 3】アプリ側の状態（彼氏プロンプトや履歴）をKVへバックアップ保存
      if (request.method === "POST" && (url.pathname === "/api/save-state" || url.pathname === "/save-state")) {
        if (!env.BOYFRIEND_KV) {
          return jsonResponse({ saved: false, reason: "KV_NOT_BOUND" });
        }
        const body = await request.json();
        const lightBoyfriends = (body.boyfriends || []).map(bf => ({
          id: bf.id,
          name: bf.name,
          prompt: bf.prompt,
          messages: (bf.messages || []).slice(-30)
        }));
        await env.BOYFRIEND_KV.put("app_state", JSON.stringify({
          activeBfId: body.activeBfId,
          boyfriends: lightBoyfriends,
          updatedAt: new Date().toISOString()
        }));
        return jsonResponse({ saved: true });
      }

      // 【API 4】チャット返信・自発メッセージ生成（写真認識にも対応）
      if (request.method === "POST" && (url.pathname === "/api/chat" || url.pathname === "/")) {
        const body = await request.json();
        const { apiKey, prompt, message, image, history = [] } = body;
        const effectiveApiKey = env.GEMINI_API_KEY || (apiKey ? apiKey.trim() : "");

        if (!effectiveApiKey) {
          return jsonResponse({ error: "APIキーが未設定です。アプリ設定画面またはWorkersのSecretsにGEMINI_API_KEYを設定してください" }, 500);
        }

        const geminiReply = await generateGeminiReply(effectiveApiKey, prompt, message, history, image);
        return jsonResponse({ reply: geminiReply });
      }

      // 【画面配信】通常のブラウザアクセス（GET / など）は index.html を返す
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return jsonResponse({ status: "My Sweet AI Worker is running!" });
    } catch (err) {
      return jsonResponse({ error: err.message || "Internal Server Error" }, 500);
    }
  },

  // ==========================================
  // 2. 定期実行処理 (Cron Triggers)
  // ==========================================
  async scheduled(event, env, ctx) {
    if (!env.GEMINI_API_KEY || !env.BOYFRIEND_KV) {
      console.log("Cron skipped: GEMINI_API_KEY or BOYFRIEND_KV is missing.");
      return;
    }

    const state = await env.BOYFRIEND_KV.get("app_state", { type: "json" });
    if (!state || !state.boyfriends || state.boyfriends.length === 0) return;

    const activeBf = state.boyfriends.find(b => b.id === state.activeBfId) || state.boyfriends[0];

    const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const hours = jstNow.getUTCHours().toString().padStart(2, "0");
    const minutes = jstNow.getUTCMinutes().toString().padStart(2, "0");
    const timeStr = `${hours}:${minutes}`;

    const history = (activeBf.messages || []).slice(-10).map(m => ({
      role: m.sender === "user" ? "user" : "model",
      parts: [{ text: m.text }]
    }));

    const systemInstruction = `${activeBf.prompt}\n\n【重要ルール】\n・LINEのような自然な短文（1〜2文）で返信してください。\n・現在の日本時間は ${timeStr} です。`;
    const triggerPrompt = `（システム指示：現在時刻は${timeStr}です。ユーザーから連絡が来る前に、彼氏であるあなたの方から時間帯に合った自然なメッセージ（「おはよう」「お昼食べた？」「お疲れ様」「そろそろ寝る？」など）を1通送ってください。メッセージ本文のみ出力してください。）`;

    try {
      const reply = await generateGeminiReply(env.GEMINI_API_KEY, systemInstruction, triggerPrompt, history);

      activeBf.messages = activeBf.messages || [];
      activeBf.messages.push({
        sender: "bf",
        text: reply,
        time: timeStr,
        fromCron: true
      });

      await env.BOYFRIEND_KV.put("app_state", JSON.stringify(state));
      console.log(`Cron message generated at ${timeStr}: ${reply}`);
    } catch (e) {
      console.error("Cron generation failed:", e);
    }
  }
};

// ==========================================
// 3. Google Gemini API 呼び出し共通関数（テキスト＆画像対応）
// ==========================================
async function generateGeminiReply(apiKey, systemPrompt, userMessage, history, imageBase64 = "") {
  const userParts = [{ text: userMessage }];
  if (imageBase64 && imageBase64.includes(",")) {
    const [meta, dataPart] = imageBase64.split(",");
    const mimeMatch = meta.match(/data:(.*?);base64/);
    userParts.push({
      inlineData: {
        mimeType: mimeMatch ? mimeMatch[1] : "image/jpeg",
        data: dataPart
      }
    });
  }

  const payload = {
    contents: [...history, { role: "user", parts: userParts }],
    systemInstruction: {
      parts: [{ text: systemPrompt }]
    }
  };

  // 1. まず利用可能な軽量・高速モデルを優先順に試す（混雑時でもしっかり待つため25秒に設定）
  let models = ["gemini-2.5-flash-lite", "gemini-3-flash-preview", "gemini-3.8-flash"];
  let lastError = null;

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000); // 25秒待つ

    try {
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      const data = await res.json();
      if (!data.error) {
        return data.candidates?.[0]?.content?.parts?.[0]?.text || "ごめん、ちょっと電波悪かったみたい！";
      }
      lastError = new Error(data.error.message);
    } catch (e) {
      clearTimeout(timeoutId);
      lastError = e;
    }
  }

  throw lastError || new Error("現在AIサーバーが混み合っています。少し待ってからもう一度送ってみてね！");
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS
    }
  });
}