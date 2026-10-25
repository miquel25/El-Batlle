# Repetidor de sales (Cloudflare)

Fa de pont entre els jugadors del mode «Juga amb amics», perquè funcioni des de qualsevol xarxa. Cada sala és un Durable Object que només passa missatges: no guarda res. Funciona amb el pla gratuït de Cloudflare.

Es desplega sol amb GitHub Actions (`.github/workflows/sales.yml`) cada vegada que canvia aquesta carpeta a `main`. Cal haver configurat una vegada els dos secrets del repositori:

## 1. L'identificador del compte de Cloudflare

1. Entra a https://dash.cloudflare.com.
2. Menú de l'esquerra: **Compute (Workers)** → **Workers & Pages**.
3. A la dreta hi ha **Account ID**. Copia'l.

## 2. Un token de Cloudflare per desplegar

1. Ves a https://dash.cloudflare.com/profile/api-tokens → **Create Token**.
2. A la plantilla **Edit Cloudflare Workers**, clica **Use template**.
3. **Account Resources**: *Include* → el teu compte. **Zone Resources**: *All zones* (no en tens cap, no passa res).
4. **Continue to summary** → **Create Token** i copia'l. **No l'enviïs pel xat.**

## 3. Els secrets a GitHub

1. Ves a https://github.com/miquel25/El-Batlle/settings/secrets/actions → **New repository secret**.
2. Nom `CLOUDFLARE_API_TOKEN`, valor: el token del pas 2. **Add secret**.
3. Un altre: nom `CLOUDFLARE_ACCOUNT_ID`, valor: l'identificador del pas 1.

## 4. Desplegar

- Si fusiones la PR després de posar els secrets, es desplega sol.
- Si no, ves a https://github.com/miquel25/El-Batlle/actions → **Desplega el repetidor de sales** → **Run workflow**.

Quan acabi en verd, obre https://el-batlle-sales.miquel-delaiglesia.workers.dev: si diu «Origen no permès», el repetidor ja funciona (només accepta el joc de miquel25.github.io).

Si el repetidor no hi és o no respon, el joc prova de connectar els navegadors directament, com abans.
