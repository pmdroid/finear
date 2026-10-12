import { createHash } from "node:crypto";

interface ConsentChoice {
  userId: string;
  userName: string;
  workspaceId: string;
  workspaceName: string;
  teams: { id: string; name: string }[];
}

interface ConsentPage {
  clientName: string;
  actor: string;
  scopes: string[];
  nonce: string;
  callbackUrl: URL;
  choices: ConsentChoice[];
}

function html(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

const styles = `
:root {
  color-scheme: light;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #202126;
  background: #f7f7f8;
  font-size: 16px;
  line-height: 1.5;
}
* { box-sizing: border-box; }
body { margin: 0; padding: 40px 24px 64px; }
main { max-width: 640px; margin: 0 auto; }
.brand { margin: 0 0 32px; font-size: 16px; font-weight: 650; }
h1 { margin: 0 0 12px; font-size: 26px; line-height: 1.25; letter-spacing: -0.025em; text-wrap: balance; }
h2 { margin: 0; font-size: 18px; line-height: 1.4; letter-spacing: -0.015em; }
p { margin: 0; }
.request { color: #555761; overflow-wrap: anywhere; }
.request strong { color: #202126; font-weight: 600; }
.details { margin: 24px 0 32px; padding: 20px 0; border-block: 1px solid #dedee3; }
dl { display: flex; gap: 12px; margin: 0 0 16px; }
dt, .permissions-title { color: #555761; font-size: 14px; font-weight: 500; }
dd { margin: 0; font-size: 14px; font-weight: 600; }
.permissions { display: flex; flex-wrap: wrap; gap: 8px; padding: 0; margin: 10px 0 0; list-style: none; }
.permissions li { max-width: 100%; padding: 4px 8px; border: 1px solid #dedee3; border-radius: 6px; background: #fff; }
code { font-size: 13px; overflow-wrap: anywhere; }
.choices { display: grid; gap: 16px; }
form { min-width: 0; padding: 24px; background: #fff; border: 1px solid #dedee3; border-radius: 12px; }
.workspace { margin-bottom: 4px; color: #555761; font-size: 14px; overflow-wrap: anywhere; }
h2 { overflow-wrap: anywhere; }
fieldset { min-width: 0; padding: 0; margin: 20px 0; border: 0; }
legend { padding: 0; margin-bottom: 8px; color: #555761; font-size: 14px; }
.team { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 8px 10px; margin-inline: -10px; border-radius: 6px; cursor: pointer; overflow-wrap: anywhere; }
.team:hover { background: #f3f3f6; }
input[type="checkbox"] { flex: 0 0 auto; width: 18px; height: 18px; margin: 0; accent-color: #6150c4; cursor: pointer; }
.actions { display: flex; gap: 10px; }
button { min-height: 44px; padding: 10px 16px; border: 1px solid #d5d5dd; border-radius: 7px; background: #fff; color: #36373f; font: inherit; font-size: 14px; font-weight: 600; line-height: 1.5; cursor: pointer; overflow-wrap: anywhere; }
button[value="allow"] { flex: 1; border-color: #6150c4; background: #6150c4; color: #fff; }
button:hover { background: #f3f3f6; }
button[value="allow"]:hover { border-color: #5141ae; background: #5141ae; }
button:active { background: #e9e9ef; }
button[value="allow"]:active { border-color: #443694; background: #443694; }
:focus-visible { outline: 3px solid #433294; outline-offset: 3px; }
.team:has(:focus-visible) { outline: 3px solid #433294; outline-offset: 2px; }
::selection { background: #e6e0ff; color: #202126; }
@media (max-width: 480px) {
  body { padding: 24px 16px 40px; }
  .brand { margin-bottom: 24px; }
  h1 { font-size: 24px; }
  form { padding: 20px; }
  .actions { flex-direction: column; }
  button { width: 100%; }
}
`;

export function renderConsent(page: ConsentPage): Response {
  const choices = page.choices
    .map(
      (
        choice,
        index,
      ) => `<form method="post" action="/oauth/authorize" aria-labelledby="choice-${index}">
<input type="hidden" name="consent" value="${html(page.nonce)}">
<input type="hidden" name="user_id" value="${html(choice.userId)}">
<input type="hidden" name="workspace_id" value="${html(choice.workspaceId)}">
<p class="workspace">${html(choice.workspaceName)}</p>
<h2 id="choice-${index}">${html(choice.userName)}</h2>
<fieldset><legend>Team access</legend>${choice.teams
        .map(
          (team) =>
            `<label class="team"><input type="checkbox" name="team_id" value="${html(team.id)}" checked><span>${html(team.name)}</span></label>`,
        )
        .join("")}</fieldset>
<div class="actions"><button type="submit" name="decision" value="allow">Authorize ${html(page.clientName)}</button><button type="submit" name="decision" value="deny">Deny</button></div>
</form>`,
    )
    .join("");
  const styleHash = createHash("sha256").update(styles).digest("base64");
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Local OAuth consent · Finear</title>
<style>${styles}</style>
</head>
<body><main>
<p class="brand">Finear</p>
<h1>Choose a fixture user and workspace</h1>
<p class="request"><strong>${html(page.clientName)}</strong> requests access.</p>
<section class="details" aria-label="Requested access">
<dl><dt>Acting as</dt><dd>${html(page.actor)}</dd></dl>
<h2 class="permissions-title">Requested permissions</h2>
<ul class="permissions">${page.scopes.map((scope) => `<li><code>${html(scope)}</code></li>`).join("")}</ul>
</section>
<div class="choices">${choices}</div>
</main></body>
</html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": `default-src 'none'; style-src 'sha256-${styleHash}'; form-action 'self' ${page.callbackUrl.origin}; frame-ancestors 'none'; base-uri 'none'`,
        "referrer-policy": "same-origin",
      },
    },
  );
}
