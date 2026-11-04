import { randomBytes } from "node:crypto";
import dgram from "node:dgram";
import { isIP } from "node:net";
import { playerName } from "../../../../shared/players";
import type { OnlinePlayers } from "./console";
export { javaQueryTarget } from "./query-config";

const SPLIT_HEADER = Buffer.from("splitnum\0\x80\0", "latin1");
const PLAYERS_HEADER = Buffer.from("\0\x01player_\0\0", "latin1");
const invalidResponse = () => new Error("MC_PLAYERS_QUERY_RESPONSE");

/** Decode a full-stat response, rejecting hidden or incomplete online lists. */
export function parseJavaQuery(data: Buffer): OnlinePlayers {
  if (data.length > 65507 || !data.subarray(5, 16).equals(SPLIT_HEADER)) throw invalidResponse();
  const separator = data.indexOf(PLAYERS_HEADER, 16);
  if (separator < 0) throw invalidResponse();
  const fields = data.subarray(16, separator).toString("utf8").split("\0");
  if (fields.pop() !== "" || fields.length % 2) throw invalidResponse();
  const stats = new Map<string, string>();
  for (let index = 0; index < fields.length; index += 2) {
    if (!fields[index] || stats.has(fields[index])) throw invalidResponse();
    stats.set(fields[index], fields[index + 1]);
  }
  const countValue = stats.get("numplayers") || "", maxValue = stats.get("maxplayers") || "";
  if (!/^\d{1,7}$/.test(countValue) || !/^\d{1,7}$/.test(maxValue)) throw invalidResponse();
  const count = Number(countValue), maxPlayers = Number(maxValue);
  if (count > 10_000 || maxPlayers > 1_000_000) throw invalidResponse();
  const payload = data.subarray(separator + PLAYERS_HEADER.length);
  // A nonempty list ends with a NUL for its last name and an empty-name terminator.
  if (!payload.length || payload.at(-1) !== 0 || payload.length > 1 && payload.at(-2) !== 0) throw invalidResponse();
  const names = payload.toString("utf8").split("\0");
  names.pop();
  if (names.at(-1) === "") names.pop();
  if (names.length !== count || new Set(names.map(name => name.toLowerCase())).size !== count) throw invalidResponse();
  try { for (const name of names) playerName(name); }
  catch { throw invalidResponse(); }
  return { names, maxPlayers };
}

/** GameSpy4 challenge + full-stat over a connected UDP socket, independent of console output. */
export function requestJavaQuery(host: string, port: number, signal: AbortSignal, timeout = 8000): Promise<OnlinePlayers> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket(isIP(host) === 6 ? "udp6" : "udp4");
    const session = randomBytes(4).map(byte => byte & 0x0f);
    let packet = Buffer.concat([Buffer.from([0xfe, 0xfd, 0x09]), session]);
    let stage: "challenge" | "stat" = "challenge", settled = false;
    let retry: ReturnType<typeof setInterval> | undefined;
    const finish = (error?: Error, value?: OnlinePlayers) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearInterval(retry);
      signal.removeEventListener("abort", abort);
      socket.removeAllListeners("message");
      try { socket.close(); } catch { /* A failed DNS lookup may leave the socket unbound. */ }
      if (error) reject(error); else resolve(value!);
    };
    const abort = () => finish(signal.reason instanceof Error ? signal.reason : new Error("MC_PLAYERS_UNAVAILABLE"));
    const timer = setTimeout(() => finish(new Error("MC_PLAYERS_QUERY_UNAVAILABLE")), timeout);
    const send = () => {
      if (settled) return;
      try { socket.send(packet, error => { if (error) finish(new Error("MC_PLAYERS_QUERY_UNAVAILABLE")); }); }
      catch { finish(new Error("MC_PLAYERS_QUERY_UNAVAILABLE")); }
    };
    signal.addEventListener("abort", abort, { once: true });
    socket.on("error", () => finish(new Error("MC_PLAYERS_QUERY_UNAVAILABLE")));
    socket.on("message", (data: Buffer) => {
      if (settled || data.length < 5 || !data.subarray(1, 5).equals(session)) return;
      try {
        if (stage === "challenge") {
          if (data[0] !== 0x09) return;
          const text = data.subarray(5).toString("ascii");
          if (!/^-?\d{1,10}\0$/.test(text)) throw invalidResponse();
          const challenge = Number(text.slice(0, -1));
          if (!Number.isInteger(challenge) || challenge < -2147483648 || challenge > 2147483647) throw invalidResponse();
          const token = Buffer.alloc(8); token.writeInt32BE(challenge);
          packet = Buffer.concat([Buffer.from([0xfe, 0xfd, 0x00]), session, token]);
          stage = "stat"; send();
        } else if (data[0] === 0x00) finish(undefined, parseJavaQuery(data));
      } catch { finish(invalidResponse()); }
    });
    try {
      socket.connect(port, host, () => {
        if (settled) { try { socket.close(); } catch {} return; }
        retry = setInterval(send, 1000);
        send();
      });
    } catch { finish(new Error("MC_PLAYERS_QUERY_UNAVAILABLE")); }
  });
}
