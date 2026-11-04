import dgram from "node:dgram";
import type { MinecraftPingResponse } from "./mcping";

const MAGIC = Buffer.from("00ffff00fefefefefdfdfdfd12345678", "hex");
const PING = Buffer.from(
  "01000000000006182000ffff00fefefefefdfdfdfd12345678a3611cf8ba8fd560",
  "hex"
);

export function parseBedrockStatus(data: Buffer, host: string, port: number): MinecraftPingResponse {
  if (data.length < 35 || data[0] !== 0x1c || !data.subarray(17, 33).equals(MAGIC)) {
    throw new Error("Invalid Minecraft Bedrock status packet");
  }
  const length = data.readUInt16BE(33);
  if (data.length < 35 + length) throw new Error("Incomplete Minecraft Bedrock status response");
  const fields = data.subarray(35, 35 + length).toString("utf8").split(";");
  if (
    fields.length < 6 || fields[0] !== "MCPE" ||
    !/^\d+$/.test(fields[4]) || !/^\d+$/.test(fields[5]) ||
    !Number.isSafeInteger(Number(fields[4])) || !Number.isSafeInteger(Number(fields[5]))
  ) {
    throw new Error("Invalid Minecraft Bedrock status response");
  }
  return {
    host,
    port,
    online: true,
    version: fields[3],
    motd: fields[1],
    current_players: Number(fields[4]),
    max_players: Number(fields[5]),
    latency: 0
  };
}

export function requestBedrockStatus(host: string, port: number, signal?: AbortSignal): Promise<MinecraftPingResponse> {
  if (signal?.aborted) return Promise.reject(new Error("Minecraft Bedrock status request cancelled"));
  const client = dgram.createSocket("udp4");
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, result?: MinecraftPingResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      try { client.close(); } catch { /* The socket may not have bound yet. */ }
      if (error) reject(error);
      else resolve(result!);
    };
    const timeout = setTimeout(
      () => finish(new Error("Minecraft Bedrock status request timeout")),
      3000
    );
    const abort = () => finish(new Error("Minecraft Bedrock status request cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    client.once("error", (error) => finish(error));
    client.once("message", (data) => {
      try { finish(undefined, parseBedrockStatus(data, host, port)); }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    try {
      client.connect(port, host, () => {
        if (settled) return;
        try { client.send(PING, (error) => { if (error) finish(error); }); }
        catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
