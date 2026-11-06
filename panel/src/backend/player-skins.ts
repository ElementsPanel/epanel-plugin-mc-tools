const MAX_JSON = 64 * 1024;
export class PlayerSkinService {
  private readonly cache = new Map<string, { until: number; skin: string | null }>();
  private readonly pending = new Map<string, Promise<string | null>>();
  private readonly abort = new AbortController();

  async get(name: unknown): Promise<string | null> {
    if (this.abort.signal.aborted || typeof name !== "string" || !/^[A-Za-z0-9_]{1,16}$/.test(name)) return null;
    const key = name.toLowerCase(), cached = this.cache.get(key);
    if (cached && cached.until > Date.now()) return cached.skin;
    const pending = this.pending.get(key);
    if (pending) return pending;
    if (this.pending.size >= 16) return null;
    const request = this.lookup(key).catch(() => null).then(skin => {
      if (!this.abort.signal.aborted) {
        this.cache.set(key, { skin, until: Date.now() + (skin ? 6 * 3600_000 : 300_000) });
        if (this.cache.size > 512) this.cache.delete(this.cache.keys().next().value!);
      }
      return skin;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }

  private async json(url: string) {
    const response = await fetch(url, { signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(4000)]), redirect: "error" });
    if (!response.ok || Number(response.headers.get("content-length")) > MAX_JSON || !response.body) throw new Error("unavailable");
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_JSON) throw new Error("size");
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally { await reader.cancel().catch(() => {}); }
  }

  private async lookup(name: string) {
    const profile = await this.json("https://api.mojang.com/users/profiles/minecraft/" + encodeURIComponent(name));
    if (typeof profile.id !== "string" || !/^[a-f0-9]{32}$/i.test(profile.id)) return null;
    const session = await this.json("https://sessionserver.mojang.com/session/minecraft/profile/" + profile.id);
    const value = session.properties?.find((property: any) => property.name === "textures")?.value;
    if (typeof value !== "string" || value.length > 32768) return null;
    const textures = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
    const url = textures.textures?.SKIN?.url;
    if (typeof url !== "string" || !/^https?:\/\/textures\.minecraft\.net\/texture\/[a-f0-9]{32,128}$/i.test(url)) return null;
    return url.replace(/^http:/, "https:");
  }

  dispose() { this.abort.abort(); this.cache.clear(); }
}
