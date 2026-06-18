// Tally → Slack 通知用の Vercel サーバーレス関数
// Tally のフォーム送信 Webhook を受け取り、Slack の Incoming Webhook に整形して転送する。
//
// 必要な環境変数 (Vercel の Project Settings → Environment Variables):
//   SLACK_WEBHOOK_URL  … Slack Incoming Webhook の URL (必須)
//   WEBHOOK_TOKEN      … 任意。設定した場合、?token=... が一致しないリクエストは拒否(簡易保護)
//
// Tally 側: Integrations → Webhooks に
//   https://<your-domain>/api/tally-webhook?token=<WEBHOOK_TOKEN>
// を登録する。

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  const slackUrl = process.env.SLACK_WEBHOOK_URL;
  if (!slackUrl) {
    res.status(500).json({ error: 'SLACK_WEBHOOK_URL is not configured' });
    return;
  }

  // 簡易トークン保護(任意)
  const token = process.env.WEBHOOK_TOKEN;
  if (token && req.query && req.query.token !== token) {
    res.status(401).json({ error: 'invalid token' });
    return;
  }

  // 本文をパース(Vercel は JSON を自動パースするが、文字列で来る場合にも備える)
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const data = body.data || {};
  const fields = Array.isArray(data.fields) ? data.fields : [];

  // 選択肢(optionId)→ テキストへの変換に対応しつつ値を文字列化
  const renderValue = (f) => {
    let v = f.value;
    if (v === null || v === undefined || v === '') return '—';
    const optMap = Array.isArray(f.options)
      ? Object.fromEntries(f.options.map((o) => [o.id, o.text]))
      : null;
    if (Array.isArray(v)) {
      return v.map((x) => (optMap && optMap[x] != null ? optMap[x] : x)).join(', ') || '—';
    }
    if (typeof v === 'object') {
      try { return JSON.stringify(v); } catch { return String(v); }
    }
    if (optMap && optMap[v] != null) return optMap[v];
    if (v === true) return '✓';
    if (v === false) return '—';
    return String(v);
  };

  const lines = fields
    .filter((f) => f && f.label)
    .map((f) => `*${f.label}*: ${renderValue(f)}`);

  // 流入元サイト: Webhook URL のクエリ (?source=...&url=...) から取得
  const q = req.query || {};
  const srcName = q.source || q.src || data.formName || body.formName || '';
  const srcUrl = q.url || q.source_url || '';
  const srcLink = srcUrl
    ? `<${srcUrl}|${srcName || srcUrl}>`
    : (srcName || '不明');

  const formName = data.formName || body.formName || '明朗会計AI フォーム';
  const when = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

  const bodyText = [`🌐 *流入元*: ${srcLink}`, '', ...(lines.length ? lines : ['(入力項目なし)'])].join('\n');

  const slackPayload = {
    text: `📩 新しい資料請求がありました（${srcName || formName}）`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '📩 新しい資料請求', emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: bodyText } },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `${formName} ・ ${when}` }],
      },
    ],
  };

  try {
    const r = await fetch(slackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(slackPayload),
    });
    if (!r.ok) {
      const t = await r.text();
      res.status(502).json({ error: 'slack responded ' + r.status, detail: t });
      return;
    }
  } catch (e) {
    res.status(502).json({ error: 'failed to post to slack', detail: String(e && e.message || e) });
    return;
  }

  res.status(200).json({ ok: true });
};
