# Giving the helper a public HTTPS address (Tailscale Funnel)

The helper (YouTube, and the optional IPTV relay) runs on the NAS and
works on the home network at `http://10.0.0.23:8799`. The car needs an
`https://` address it can reach from anywhere. This sets that up as
`https://yt-helper.tail56cd28.ts.net`, the address the app already uses.

You need: the Tailscale admin console (login.tailscale.com) and the
NAS's Docker / Compose app (TOS Docker Manager or Portainer).

## 1. Clean up old machines in Tailscale

The failed attempts each registered a new machine. If any machine named
`yt-helper` (or `yt-helper-1`, `yt-helper-2`, …) is listed under
**Machines**, remove them all. Otherwise the new one gets a different
name and the app's address won't match.

## 2. Allow Funnel and HTTPS (once per tailnet)

- **DNS** page: MagicDNS **on**, HTTPS Certificates **Enable**.
- **Access controls**: the policy must give the machine the `funnel`
  attribute. Simplest is to tag it:

  ```json
  "tagOwners": { "tag:funnel": ["autogroup:admin"] },
  "nodeAttrs": [ { "target": ["tag:funnel"], "attr": ["funnel"] } ]
  ```

## 3. Make an auth key

**Settings → Keys → Generate auth key**:
- Reusable: off is fine (the identity is saved after the first sign-in).
- Tags: `tag:funnel`.

Copy the key (starts with `tskey-auth-`).

## 4. Put the files on the NAS

Make a folder on the NAS (for example `/Docker/yt-funnel/`) containing:

```
docker-compose.funnel.yml   (from this folder)
ts-config/serve.json        (from this folder)
ts-state/                   (empty folder)
.env                        (create it - one line, your key:)
```

`.env`:

```
TS_AUTHKEY=tskey-auth-xxxxxxxxxxxx
```

Keep `.env` on the NAS only; never commit it to the repo.

`serve.json` points at `http://10.0.0.23:8799`. If the NAS's address or
the helper's port is different, change that line.

## 5. Start it

Stop and remove the old `yt-funnel` container if it still exists, then
start this compose project. Within a minute the machine `yt-helper`
appears in the admin console, tagged `tag:funnel`.

## 6. Check

From any browser (phone on mobile data is the real test):

```
https://yt-helper.tail56cd28.ts.net/health
```

It should answer `{"ok": true, ...}`. Then the YouTube tab in the app
works from the car. (DNS for a brand-new Funnel name can take a few
minutes to appear.)

## Optional: IPTV relay

To route an IPTV provider through the helper, add these to the
**helper's** container environment (not this one) and restart it:

```
IPTV_KEY=<a long random secret you make up>
IPTV_HOSTS=<your provider's host name, e.g. line.provider.example>
```

Then in the app: Settings → IPTV subscription → tick "Route through the
home helper" and enter the same `IPTV_KEY`.
