import { ref, type Ref } from "vue";
import { embedCommand, type EmbedEvent, type EmbedFocus, type MapMarker, type MapMenuItem } from "../../../shared/embed";

/** The small part of `window` the bridge needs, so it can be unit tested. */
export interface EmbedPort {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  parent: { postMessage(message: unknown, targetOrigin: string): void } | null;
}

export interface EmbedBridgeOptions {
  /** Origins allowed to talk to the map; an empty list keeps the bridge silent. */
  origins(): string[];
  ready(): Omit<Extract<EmbedEvent, { type: "mcmap:ready" }>, "type">;
  view(): Omit<Extract<EmbedEvent, { type: "mcmap:view" }>, "type">;
  focus(target: EmbedFocus): boolean;
}

export interface EmbedBridge {
  markers: Ref<MapMarker[]>;
  menu: Ref<MapMenuItem[]>;
  start(): void;
  stop(): void;
  /** Tells every allowed parent that the map is ready. */
  announce(): void;
  publishView(): void;
  notifyMarker(id: string): void;
  notifyMenu(id: string): void;
}

const VIEW_INTERVAL = 250;
const SILENT: EmbedPort = { addEventListener() {}, removeEventListener() {}, parent: null };

/** Falls back to a silent port outside a DOM (tests, prerender). */
export function embedPort(): EmbedPort {
  return typeof window === "undefined" ? SILENT : window;
}

/**
 * postMessage bridge for `?embed=1`. Only messages from a configured origin are
 * read, and only the documented command shapes are honoured.
 */
export function createEmbedBridge(port: EmbedPort, options: EmbedBridgeOptions): EmbedBridge {
  const markers = ref<MapMarker[]>([]);
  const menu = ref<MapMenuItem[]>([]);
  let reply: { source: MessageEventSource | null; origin: string } | undefined;
  let started = false;
  let lastView = Number.NEGATIVE_INFINITY;

  const send = (event: EmbedEvent, target = reply) => {
    if (!target?.source) return;
    (target.source as { postMessage(message: unknown, targetOrigin: string): void }).postMessage(event, target.origin);
  };
  const allowed = (origin: string) => options.origins().includes(origin);

  const onMessage = (event: MessageEvent) => {
    if (!allowed(event.origin)) return;
    const command = embedCommand(event.data);
    if (!command) return;
    // Every accepted message renews the reply channel for later events.
    reply = { source: event.source, origin: event.origin };
    if (command.type === "mcmap:hello") {
      send({ type: "mcmap:ready", ...options.ready() });
      send({ type: "mcmap:view", ...options.view() });
      return;
    }
    if (command.type === "mcmap:markers") markers.value = command.markers;
    else if (command.type === "mcmap:menu") menu.value = command.items;
    else if (command.type === "mcmap:focus" && !options.focus(command.focus)) {
      send({ type: "mcmap:error", code: "MC_MAP_NOT_READY" });
    }
  };

  return {
    markers,
    menu,
    start() {
      if (started) return;
      started = true;
      port.addEventListener("message", onMessage);
    },
    stop() {
      if (!started) return;
      started = false;
      port.removeEventListener("message", onMessage);
      reply = undefined;
    },
    announce() {
      const event: EmbedEvent = { type: "mcmap:ready", ...options.ready() };
      // The parent is unknown before the first message, so every allowed origin
      // receives it; others simply drop the message.
      for (const origin of options.origins()) {
        port.parent?.postMessage(event, origin);
      }
    },
    publishView() {
      const now = Date.now();
      if (now - lastView < VIEW_INTERVAL) return;
      lastView = now;
      send({ type: "mcmap:view", ...options.view() });
    },
    notifyMarker(id: string) { send({ type: "mcmap:marker", id }); },
    notifyMenu(id: string) { send({ type: "mcmap:menu", id }); }
  };
}
