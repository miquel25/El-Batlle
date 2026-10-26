# Comptes i partides desades (Cloudflare)

Permet crear un compte amb un nom de jugador i una contrasenya i desar-hi fins a 5 partides, per continuar-les des de qualsevol navegador. Cada compte és un Durable Object amb la seva pròpia base de dades SQLite. Funciona amb el pla gratuït de Cloudflare (5 GB en total; una partida ocupa entre 30 i 300 KB comprimida).

- La contrasenya no surt mai del navegador: el joc n'envia una clau derivada (PBKDF2) i aquí se'n desa un altre hash amb sal pròpia.
- El correu és opcional i només serveix per recuperar la contrasenya. No es desa tal qual, només un hash: quan algú el torna a escriure, es comprova i s'hi envia un codi de 6 xifres que val 30 minuts.
- Límits contra abusos: 5 comptes nous per hora i connexió, bloqueig de 15 minuts després de 10 contrasenyes errònies, 5 partides per compte i fins a ~1,9 MB per partida.
- Els noms no es poden repetir, encara que canviïn les majúscules: cada nom (en minúscules) té el seu propi Durable Object, i només el primer que el reclama el pot fer servir.
- Des de «El meu usuari» es pot canviar el nom (el compte i les partides passen al nom nou, que ha d'estar lliure, i el vell queda lliure), posar, canviar o treure el correu, i esborrar el compte amb totes les partides.

## Desplegar

Es desplega sol amb GitHub Actions (`.github/workflows/comptes.yml`) cada vegada que canvia aquesta carpeta a `main`, amb els mateixos secrets que el repetidor de sales (`CLOUDFLARE_API_TOKEN` i `CLOUDFLARE_ACCOUNT_ID`, vegeu [`worker/sales`](../sales/README.md)). També es pot llançar a mà: https://github.com/miquel25/El-Batlle/actions → **Desplega els comptes i les partides desades** → **Run workflow**.

Quan acabi en verd, https://el-batlle-comptes.miquel-delaiglesia.workers.dev ha de dir «Origen no permès».

## Recuperar la contrasenya per correu (opcional)

Sense aquests dos secrets tot funciona igual, però el joc dirà que ara no es poden enviar correus. Amb [Brevo](https://www.brevo.com) (pla gratuït, 300 correus al dia):

1. Crea un compte a Brevo.
2. **Senders, Domains & Dedicated IPs** → **Senders** → **Add a sender**: posa-hi el teu correu i confirma'l des del missatge que t'enviaran.
3. **SMTP & API** → **API Keys** → **Generate a new API key**. Copia-la (no l'enviïs pel xat).
4. A Cloudflare: **Workers & Pages** → `el-batlle-comptes` → **Settings** → **Variables and Secrets** → **Add**, dues vegades, de tipus *Secret*:
   - `BREVO_API_KEY`: la clau del pas 3.
   - `CORREU_REMITENT`: el correu verificat del pas 2.

Els secrets es mantenen encara que el Worker es torni a desplegar.

## Provar-ho en local

`npx wrangler dev` dins d'aquesta carpeta, i obre el joc des de `http://localhost` amb `?comptes=http://localhost:8787`.
