# WebDAV as the account backend (local account mode)

Readest's account features normally require signing in to the hosted backend.
This fork adds a **local account**: once a WebDAV server is connected in
Settings → Integrations → Cloud Sync → WebDAV, a signed-out device treats that
server as its account. Nothing is sent to the hosted service.

## Turning it on

Settings → Integrations → Cloud Sync → **WebDAV**. On a signed-out device the
row is deliberately **not** premium-gated (`webdavUnlocked` in
`IntegrationsPanel.tsx`): gating it would be a dead end, because the plan is
only purchasable after signing in, and signing in is exactly what this mode
replaces. Signed-in users keep the normal premium rule for every provider.

Fill in server URL + username, connect, and the mode activates on the next
render — no restart, no reload. Disconnecting (or clearing the URL) drops the
device back to a plain signed-out client.

## What works without an account

| Feature                     | Backend in local mode                                            |
| --------------------------- | ---------------------------------------------------------------- |
| Settings sync               | `settings` replica bundle on WebDAV                              |
| Collections / bookshelves   | `bookshelf` replica bundle on WebDAV                             |
| Dictionaries, fonts, textures | replica rows + binaries under `files/<accountId>/…`            |
| OPDS catalogs, ABS servers, custom translators/TTS | replica rows on WebDAV                     |
| Encrypted credentials (sync passphrase) | `replica-keys.json` + encrypted fields on WebDAV     |
| Reading statistics          | `sync/statBooks.json` + `sync/statPages.json` on WebDAV          |
| Books, reading progress, notes | the existing WebDAV file-sync engine (`library.json`, `config.json`) |
| Premium features            | unlocked — there is no store to buy from, the user owns the storage |

Still hosted-only (by design, they have no WebDAV equivalent): share links,
the Send-to-Readest email inbox, Readest Voice TTS and the hosted AI
endpoints. Those surfaces fail with a normal network/auth error instead of
being redirected to a sign-in page.

## Wire layout

Everything the account layer writes lives in one subtree, beside the file-sync
tree:

```
<rootPath>/
  Readest/
    library.json                 ← file-sync engine (books/progress/notes)
    books/<hash>/…
    account/
      replicas/<kind>.json       ← CRDT rows, one bundle per replica kind
      replica-keys.json          ← passphrase salts
      sync/statBooks.json        ← reading statistics
      sync/statPages.json
      files/<accountId>/<cloud file path>   ← replica binaries
```

`<accountId>` is `local-<uuid>` derived from `sha`-free FNV hashing of
`serverUrl | username | rootPath`, so two devices pointed at the same WebDAV
account derive the same id and therefore share replica rows and storage keys.

## How it plugs in

| Concern | Seam |
| ------- | ---- |
| Identity, token, plan | `src/services/localAccount/config.ts` + `src/utils/access.ts` |
| Session shape (`useAuth`) | `src/context/AuthContext.tsx` — a synthetic user is exposed while local mode is active |
| Replica transport | `src/libs/replicaSyncClient.ts` delegates to `WebDAVReplicaClient` |
| Row transport (statistics) | `src/libs/sync.ts` delegates to `WebDAVLegacySyncClient` |
| Object storage | `src/libs/storage.ts` delegates to `src/services/localAccount/storage.ts` |
| Entitlement | `isCustomizationAllowed()` returns true while local mode is active |

Local mode is **only** active when there is no hosted session: a signed-in user
keeps the hosted backend even with WebDAV configured, so connecting WebDAV can
never silently move an existing account's data.

## Merge semantics

- Replica rows use the same client-side CRDT merge the hosted server applies
  (`mergeReplica` in `src/libs/crdt.ts`): per-field last-writer-wins on HLC
  stamps, tombstones never revived by a later field write.
- A push is read-modify-write on one JSON bundle per kind, serialised
  in-process. Two devices pushing concurrently each merge into what they read,
  and the loser's rows are re-sent on its next flush because its cursor never
  advanced past them.
- Statistics rows are last-writer-wins per row, server-stamped with
  `updated_at = now()` exactly like the hosted upsert, so the client's
  `updated_at_ms` cursor keeps advancing.

## Known limits

- The `books` / `configs` / `notes` legacy rows are intentionally not mirrored
  here: `syncCategories.ts` switches those channels off whenever Readest Cloud
  is not the selected provider, and the WebDAV file-sync engine owns them.
- WebDAV reports no quota; the storage panel shows usage against a 1 TiB
  ceiling.
- Bundles grow with the account. A library with tens of thousands of
  collections would make each pull re-download a large bundle; the hosted
  backend's per-row rows are the reason it does not have that ceiling.

## Testing

```bash
pnpm --filter @readest/readest-app test --run \
  src/__tests__/services/localAccount \
  src/__tests__/utils/access-local-account.test.ts \
  src/__tests__/context/auth-context-local-account.test.tsx \
  src/__tests__/components/IntegrationsPanel-webdav-unlock.test.tsx
```

The tests drive the real code paths against an in-memory `FileSyncProvider`
(`src/__tests__/services/localAccount/fakeProvider.ts`), so path layout, JSON
round trips and merge behaviour are covered without a WebDAV server. The
IntegrationsPanel suite pins the unlock rule in both directions: signed out the
WebDAV row has no Premium chip and opens its config form; signed in on a free
plan it keeps the chip and routes to the upgrade page.
