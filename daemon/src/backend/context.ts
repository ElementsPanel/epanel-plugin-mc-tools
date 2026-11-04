import type { Context } from "cordis";

export interface MinecraftInstance {
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
}
