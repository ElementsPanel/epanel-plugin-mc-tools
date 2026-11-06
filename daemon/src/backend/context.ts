import type { Context } from "cordis";

export interface MinecraftInstance {
  /** The identifier the panel and the protocol use for this instance. */
  instanceUuid?: string;
  config: {
    type?: string;
    pingConfig?: { ip?: string; port?: number; type?: number };
  };
  info: {
    mcPingOnline?: boolean;
    currentPlayers?: number;
    maxPlayers?: number;
    version?: string;
    latency?: number;
  };
  resetPingInfo(): void;
  absoluteCwdPath(): string;
  execPreset(name: string, parameter?: unknown): Promise<unknown>;
  getPreset(name: string): unknown;
  setPreset(name: string, command: unknown): void;
  status(): number;
  on(event: string, callback: (...args: any[]) => void): unknown;
  off(event: string, callback: (...args: any[]) => void): unknown;
  lifeCycleTaskManager: {
    lifeCycleTask: MinecraftStatusTask[];
    registerLifeCycleTask(task: MinecraftStatusTask): void;
  };
}

export interface MinecraftStatusTask {
  name: string;
  status: number;
  start(instance: MinecraftInstance): Promise<void>;
  stop(instance: MinecraftInstance): Promise<void>;
}

/** The host supplies these services; this package has no runtime imports from it. */
export interface McToolsDaemonContext extends Context {
  instances: {
    Command: new (name: string) => object;
    Instance: { STATUS_RUNNING: number };
    subsystem: { getInstances(): MinecraftInstance[]; getInstance(id: string): MinecraftInstance | undefined };
  };
  features: { add(name: string): () => void };
  presets: {
    entries(): ReadonlyMap<string, () => unknown>;
    register(name: string, factory: () => unknown): () => void;
  };
  instanceLifecycle: {
    register(factory: (instance: MinecraftInstance) => MinecraftStatusTask | undefined): () => void;
  };
  protocol: {
    on(event: string, handler: (request: any, data: unknown) => void): () => void;
    response(request: any, data: unknown): void;
    responseError(request: any, error: Error, options?: { disablePrint: boolean }): void;
  };
  /** The host's entity storage; optional so the plugin still runs without it. */
  storage?: {
    load<T>(category: string, type: new () => T, entity: string): T | null;
    store(category: string, entity: string, value: unknown): unknown;
  };
}
