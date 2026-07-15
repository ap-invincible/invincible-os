"use node";

export async function notifyTeams(title: string, detail: string, requestId: string) {
  const webhook = process.env.TEAMS_WEBHOOK_URL;
  if (!webhook) return;
  const baseUrl = process.env.APP_URL ?? "";
  await fetch(webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: { "$schema": "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.5", body: [{ type: "TextBlock", weight: "Bolder", text: title }, { type: "TextBlock", wrap: true, text: detail }], actions: baseUrl ? [{ type: "Action.OpenUrl", title: "Open request", url: `${baseUrl}/audit?request=${requestId}` }] : [] } }] }) });
}
