// Cloudflare Worker: repetidor de les sales del mode «Juga amb amics».
// Cada sala és un Durable Object que fa de pont entre l'amfitrió i els altres jugadors: no guarda res ni entén el joc,
// només passa missatges. Així es pot jugar des de qualsevol xarxa, també les que no deixen connectar dos navegadors
// directament. Es desplega sol amb GitHub Actions (.github/workflows/sales.yml).
import { DurableObject } from 'cloudflare:workers';

const ORIGENS = ['https://miquel25.github.io'];
const MAX_JUGADORS = 12, MAX_MISSATGE = 64 * 1024;

export default {
  async fetch(req, env) {
    const origen = req.headers.get('Origin') || '';
    if (!ORIGENS.includes(origen) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origen)) return new Response('Origen no permès', { status: 403 });
    const m = new URL(req.url).pathname.match(/^\/sala\/([A-Z0-9]{5})$/);
    if (!m || req.headers.get('Upgrade') !== 'websocket') return new Response('El batlle: repetidor de sales', { status: 400 });
    return env.SALES.get(env.SALES.idFromName(m[1])).fetch(req);
  },
};

// l'amfitrió envia {to: id o '*', m} i {kick: id}; rep {sys: 'join'|'leave', id} i {from: id, m}.
// Un jugador envia el missatge tal qual i rep tal qual el que li envia l'amfitrió.
export class Sala extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.host = null; this.guests = new Map(); this.next = 1; }
  async fetch(req) {
    const role = new URL(req.url).searchParams.get('role');
    const [client, ws] = Object.values(new WebSocketPair());
    ws.accept();
    const send = (s, t) => { try { s.send(t); } catch (e) {} };
    if (role === 'host') {
      if (this.host) { ws.close(4001, 'Ja hi ha una sala amb aquest codi'); return new Response(null, { status: 101, webSocket: client }); }
      this.host = ws; send(ws, '{"sys":"ready"}');
      ws.addEventListener('message', e => {
        let d; try { d = JSON.parse(e.data); } catch (err) { return; }
        if (d.kick != null) { const g = this.guests.get(d.kick); if (g) try { g.close(4002, 'Fora de la sala'); } catch (err) {} return; }
        const t = JSON.stringify(d.m);
        if (d.to === '*') for (const g of this.guests.values()) send(g, t); else { const g = this.guests.get(d.to); if (g) send(g, t); }
      });
      const bye = () => {
        if (this.host !== ws) return;
        this.host = null;
        for (const g of this.guests.values()) try { g.close(4000, 'La sala s\'ha tancat'); } catch (err) {}
        this.guests.clear();
      };
      ws.addEventListener('close', bye); ws.addEventListener('error', bye);
    } else {
      if (!this.host || this.guests.size >= MAX_JUGADORS) { ws.close(4004, this.host ? 'La sala és plena' : 'No hi ha cap sala amb aquest codi'); return new Response(null, { status: 101, webSocket: client }); }
      const id = this.next++;
      this.guests.set(id, ws); send(ws, '{"sys":"ready"}'); send(this.host, JSON.stringify({ sys: 'join', id }));
      ws.addEventListener('message', e => {
        if (typeof e.data !== 'string' || e.data.length > MAX_MISSATGE || !this.host) return;
        let m; try { m = JSON.parse(e.data); } catch (err) { return; }
        send(this.host, JSON.stringify({ from: id, m }));
      });
      const bye = () => { if (this.guests.delete(id) && this.host) send(this.host, JSON.stringify({ sys: 'leave', id })); };
      ws.addEventListener('close', bye); ws.addEventListener('error', bye);
    }
    return new Response(null, { status: 101, webSocket: client });
  }
}
