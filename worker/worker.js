// Cloudflare Worker: rep propostes de lleis del joc i les desa com a issues a GitHub.
// Secret necessari: GITHUB_TOKEN (token fine-grained amb Issues: write només a miquel25/El-Batlle).
// KV opcional: RATE (si està lligat, limita a 5 propostes per IP i hora).

const REPO = "miquel25/El-Batlle";
const ORIGENS = ["https://miquel25.github.io"];
const MAX_TITOL = 120;
const MAX_TEXT = 4000;
const MAX_NOM = 60;
const LIMIT_PER_HORA = 5;

function cors(origen) {
  return {
    "Access-Control-Allow-Origin": origen,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function resposta(cos, estat, origen) {
  return new Response(JSON.stringify(cos), {
    status: estat,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors(origen) },
  });
}

const net = (v, max) => String(v ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);

export default {
  async fetch(req, env) {
    const origen = req.headers.get("Origin") || "";
    if (!ORIGENS.includes(origen)) return new Response("Origen no permès", { status: 403 });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origen) });
    if (req.method !== "POST") return resposta({ error: "Mètode no permès" }, 405, origen);

    let dades;
    try {
      dades = await req.json();
    } catch {
      return resposta({ error: "Dades no vàlides" }, 400, origen);
    }

    // Parany per a robots: el camp "web" és invisible al formulari i ha d'arribar buit.
    if (dades.web) return resposta({ ok: true }, 200, origen);

    const titol = net(dades.titol, MAX_TITOL);
    const text = net(dades.text, MAX_TEXT);
    const nom = net(dades.nom, MAX_NOM);
    if (titol.length < 3 || text.length < 10) {
      return resposta({ error: "Cal un títol i una descripció una mica més llargs." }, 400, origen);
    }

    if (env.RATE) {
      const ip = req.headers.get("CF-Connecting-IP") || "desconeguda";
      const clau = `ip:${ip}:${Math.floor(Date.now() / 3600000)}`;
      const n = parseInt((await env.RATE.get(clau)) || "0", 10);
      if (n >= LIMIT_PER_HORA) {
        return resposta({ error: "Massa propostes seguides. Torna-ho a provar d'aquí una estona." }, 429, origen);
      }
      await env.RATE.put(clau, String(n + 1), { expirationTtl: 3700 });
    }

    const cos = [
      text,
      "",
      "---",
      `Proposada per: ${nom || "anònim"}`,
      "_Enviada des del formulari del joc._",
    ].join("\n");

    const gh = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "el-batlle-propostes",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: `[Proposta] ${titol}`, body: cos, labels: ["proposta"] }),
    });

    if (!gh.ok) {
      console.log("GitHub ha respost", gh.status, await gh.text());
      return resposta({ error: "No s'ha pogut desar la proposta. Torna-ho a provar més tard." }, 502, origen);
    }
    const issue = await gh.json();
    return resposta({ ok: true, numero: issue.number, url: issue.html_url }, 200, origen);
  },
};
