# Coldcase CMS — veilige testopstelling

Deze map bevat de serverkant van het CMS.

## Architectuur

`admin.html` → Cloudflare Worker → GitHub `cms-v2/cases.json`

De browser krijgt **nooit** het GitHub-token. De Worker bewaart het token als Cloudflare Secret. Cloudflare ondersteunt hiervoor versleutelde Worker secrets; gevoelige waarden horen niet in gewone configuratie of Git te staan.

## 1. Cloudflare Worker maken

Maak in Cloudflare een nieuwe Worker, bijvoorbeeld:

`coldcase-cms`

Plak de inhoud van `worker.js` in de Worker en deploy hem.

## 2. Twee secrets toevoegen

Ga bij de Worker naar **Settings → Variables and Secrets → Add** en voeg toe:

- `GITHUB_TOKEN` = een GitHub fine-grained token
- `CMS_KEY` = een zelfgekozen lange geheime code

De waarden worden niet in deze repository gezet.

### GitHub token

Maak een fine-grained token voor alleen repository `caspervangorkom/map`.

Geef alleen:

- Repository access: `Only select repositories` → `caspervangorkom/map`
- Repository permissions → `Contents` → `Read and write`

Geen andere repository-permissies zijn nodig voor het opslaan van `cases.json`.

## 3. Worker-URL in admin.html zetten

Open `admin.html` en vul bij `WORKER_URL` de URL van de Worker in.

Voorbeeld:

`https://coldcase-cms.jouw-account.workers.dev`

## 4. Eerst alleen testen

De Worker schrijft bewust naar branch `cms-v2`.

De live `main`-branch wordt dus niet aangeraakt.

Testvolgorde:

1. Open `admin.html` via de testomgeving.
2. Laad een bestaande zaak.
3. Pas bijvoorbeeld alleen de titel aan.
4. Klik op **Opslaan naar CMS**.
5. Controleer in GitHub dat `cms-v2/cases.json` is gewijzigd.
6. Controleer daarna de testkaart.

## 5. Daarna pas live

Als alles goed werkt, veranderen we één instelling van `cms-v2` naar `main`.

De bestaande kaart hoeft daarvoor niet opnieuw gebouwd te worden.

## Veiligheidsregels

- Nooit een GitHub-token in `admin.html` zetten.
- Nooit een GitHub-token in `cases.json` zetten.
- `CMS_KEY` niet in GitHub zetten.
- Eerst testen op `cms-v2`.
- De Worker controleert titel, link en coördinaten voordat hij schrijft.
- De Worker leest eerst de actuele SHA van `cases.json`; daardoor kan een gelijktijdige wijziging niet stilletjes worden overschreven.
- GitHub houdt automatisch commitgeschiedenis bij, zodat eerdere versies terug te vinden zijn.
