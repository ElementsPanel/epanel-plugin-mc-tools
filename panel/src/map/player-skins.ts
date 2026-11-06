const cache = new Map<string, { until: number; skin: string | null }>();
const pending = new Map<string, Promise<string | null>>();
let active = 0;
const queue: (() => void)[] = [];
async function slot() {
  if (active >= 6) await new Promise<void>(resolve => queue.push(resolve));
  else active++;
}

export async function playerSkin(name: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) return null;
  const key = name.toLowerCase(), previous = cache.get(key);
  if (previous && previous.until > Date.now()) return previous.skin;
  const current = pending.get(key);
  if (current) return current;
  const request = slot().then(() => fetch(`./api/mc-tools/map/skin?${new URLSearchParams({ name })}`, { credentials: "omit", signal: AbortSignal.timeout(10_000) }))
    .then(async response => {
      if (!response.ok) return null;
      const result = await response.json(), skin = result.status === 200 ? result.data?.skin : null;
      return typeof skin === "string" && /^https:\/\/textures\.minecraft\.net\/texture\/[a-f0-9]{32,128}$/i.test(skin) ? skin : null;
    }).catch(() => null).then(skin => {
      cache.set(key, { skin, until: Date.now() + (skin ? 6 * 3600_000 : 300_000) });
      if (cache.size > 512) cache.delete(cache.keys().next().value!);
      return skin;
    }).finally(() => {
      pending.delete(key);
      const next = queue.shift();
      if (next) next(); else active--;
    });
  pending.set(key, request);
  return request;
}
