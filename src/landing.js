// Served at / so anyone who opens the addon in a browser is told exactly what
// to do, for the address they actually reached it on.

const escape = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * @param secure true when the request arrived over HTTPS (directly or via a
 *   reverse proxy). The `stremio://` deep link rewrites to `https://` and
 *   discards the port, so it only works for an HTTPS host on the default
 *   port — offering it anywhere else produces a link that silently fails.
 */
export function landingPage(manifest, host, secure = false) {
  const scheme = secure ? 'https' : 'http';
  const manifestUrl = `${scheme}://${host}/manifest.json`;
  const deepLink = `stremio://${host.replace(/:443$/, '')}/manifest.json`;
  const canDeepLink = secure && !/:\d+$/.test(host.replace(/:443$/, ''));

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(manifest.name)}</title>
<style>
:root{color-scheme:dark light}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
 font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
 background:#12141a;color:#e8eaf0;padding:24px}
.card{max-width:620px;width:100%}
h1{font-size:1.6rem;margin:0 0 .3rem}
h2{font-size:1rem;margin:1.6rem 0 .4rem;color:#e8eaf0}
p{color:#a8b0c0;margin:.4rem 0}
.url{display:flex;gap:.5rem;margin:.7rem 0}
.url input{flex:1;background:#1e222c;border:1px solid #2c3140;border-radius:8px;
 padding:.75rem .9rem;color:#9ad;font-family:ui-monospace,monospace;font-size:.9rem}
button,a.btn{background:#7b5cff;color:#fff;border:0;border-radius:8px;padding:.75rem 1.2rem;
 font:inherit;font-weight:600;cursor:pointer;text-decoration:none;white-space:nowrap}
button:hover,a.btn:hover{background:#6a49f0}
ol{color:#a8b0c0;padding-left:1.3rem;margin:.4rem 0}
.warn{background:#241d10;border:1px solid #4a3a17;border-radius:8px;
 padding:.8rem 1rem;color:#e0c890;font-size:.93rem;margin-top:1.2rem}
.meta{color:#6d7488;font-size:.87rem;margin-top:1.6rem;border-top:1px solid #242835;padding-top:.9rem}
</style></head><body><div class="card">
<h1>${escape(manifest.name)}</h1>
<p>${escape(manifest.description || '')}</p>

${canDeepLink ? `<p><a class="btn" href="${escape(deepLink)}">Install in Stremio</a></p>
<h2>Or add it manually</h2>` : '<h2>Add it to Stremio</h2>'}

<div class="url">
  <input id="u" value="${escape(manifestUrl)}" readonly onclick="this.select()">
  <button id="c">Copy</button>
</div>
<ol>
  <li>Open Stremio and go to <b>Addons</b></li>
  <li>Paste the URL into the box at the top</li>
  <li>Click <b>Install</b></li>
</ol>

${canDeepLink ? '' : `<div class="warn">
<b>Installing on another device?</b> Stremio's one-click <code>stremio://</code>
link rewrites to <code>https://</code> and drops the port, so it cannot be used
for this address &mdash; paste the URL instead. For phones and TVs, serve this
behind HTTPS (Tailscale Serve or Caddy) and the one-click link will appear here.
</div>`}

<div class="meta">Catalogues: ${manifest.catalogs.map((c) => escape(c.name)).join(' &middot; ')}</div>
</div>
<script>
document.getElementById('c').onclick=async()=>{
  const i=document.getElementById('u'), b=document.getElementById('c');
  try{ await navigator.clipboard.writeText(i.value); }
  catch(e){ i.select(); document.execCommand&&document.execCommand('copy'); }
  b.textContent='Copied'; setTimeout(()=>b.textContent='Copy',1500);
};
</script>
</body></html>`;
}
