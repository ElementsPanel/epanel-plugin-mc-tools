import MCServerStatus from "./mcping";
import { requestBedrockStatus } from "./bedrock";
import type { McToolsDaemonContext, MinecraftInstance } from "./context";

const JAVA_TYPE = "minecraft/java";
const BEDROCK_TYPE = "minecraft/bedrock";

export function isMinecraft(instance: MinecraftInstance) {
  const type = String(instance.config?.type ?? "");
  return type.startsWith(JAVA_TYPE) || type.startsWith(BEDROCK_TYPE);
}

export function createMinecraftStatusCommandClass(ctx: McToolsDaemonContext) {
  const { Command } = ctx.instances;
  return class MinecraftStatusCommand extends Command {
    private readonly pending = new WeakMap<MinecraftInstance, AbortController>();

    constructor() { super("MinecraftStatusCommand"); }

    async exec(instance: MinecraftInstance) {
      const type = String(instance.config?.type ?? "");
      const ip = instance.config?.pingConfig?.ip || "localhost";
      const port = Number(instance.config?.pingConfig?.port || 0);
      if (!ctx.scope.isActive || !isMinecraft(instance)) return null;
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        instance.resetPingInfo();
        return null;
      }
      this.pending.get(instance)?.abort();
      const request = new AbortController();
      this.pending.set(instance, request);
      const current = () => ctx.scope.isActive && this.pending.get(instance) === request &&
        String(instance.config?.type ?? "") === type &&
        (instance.config?.pingConfig?.ip || "localhost") === ip &&
        Number(instance.config?.pingConfig?.port || 0) === port;
      try {
        const result = type.startsWith(JAVA_TYPE)
          ? await new MCServerStatus(port, ip).getStatus(request.signal)
          : await requestBedrockStatus(ip, port, request.signal);
        if (!current()) return null;
        if (!result.online) {
          instance.resetPingInfo();
          return result;
        }
        Object.assign(instance.info, {
          mcPingOnline: true,
          currentPlayers: result.current_players,
          maxPlayers: result.max_players,
          version: result.version || "",
          latency: result.latency
        });
        return result;
      } catch {
        if (current()) instance.resetPingInfo();
        return null;
      } finally {
        if (this.pending.get(instance) === request) this.pending.delete(instance);
      }
    }

    async stop(instance: MinecraftInstance) {
      const request = this.pending.get(instance);
      this.pending.delete(instance);
      request?.abort();
      instance.resetPingInfo();
    }
  };
}

export function registerMinecraftStatus(ctx: McToolsDaemonContext) {
  // instance <= 1.0.11 already owns this preset. Retain its single poller until
  // that plugin is upgraded to a version with Minecraft status extracted.
  if (ctx.presets.entries().has("refreshPlayers")) return;

  const instancesService = ctx.instances;
  const Command = createMinecraftStatusCommandClass(ctx);
  const tasks = new Map<MinecraftInstance, Set<MinecraftStatusTask>>();
  class MinecraftStatusTask {
    status = 0;
    name = "MinecraftStatus";
    private stopTask?: () => void;

    async start(instance: MinecraftInstance) {
      this.stopTask?.();
      if (!ctx.scope.isActive) return;
      if (!tasks.has(instance)) tasks.set(instance, new Set());
      tasks.get(instance)!.add(this);
      this.stopTask = ctx.setInterval(() => {
        if (ctx.scope.isActive) void instance.execPreset("refreshPlayers").catch(() => {});
      }, 60_000);
    }

    async stop(instance: MinecraftInstance) {
      this.stopTask?.();
      this.stopTask = undefined;
      const command = instance.getPreset("refreshPlayers");
      if (command instanceof Command) await command.stop(instance);
      else instance.resetPingInfo();
      const active = tasks.get(instance);
      active?.delete(this);
      if (!active?.size) tasks.delete(instance);
    }
  }

  const createTask = (instance: MinecraftInstance) => {
    if (!isMinecraft(instance)) return;
    const task = new MinecraftStatusTask();
    if (!tasks.has(instance)) tasks.set(instance, new Set());
    tasks.get(instance)!.add(task);
    return task;
  };
  ctx.features.add("mcstats");
  ctx.presets.register("refreshPlayers", () => new Command());
  ctx.instanceLifecycle.register(createTask);

  // An external plugin can load after instances have been restored. Attach its
  // contributions to those instances as well as future dispatcher runs.
  for (const instance of instancesService.subsystem.getInstances()) {
    if (!isMinecraft(instance)) continue;
    instance.setPreset("refreshPlayers", new Command());
    const task = createTask(instance)!;
    instance.lifeCycleTaskManager.registerLifeCycleTask(task);
    if (instance.status() === instancesService.Instance.STATUS_RUNNING) {
      void task.start(instance).then(() => { task.status = 1; });
    }
  }

  ctx.on("dispose", async () => {
    const instances = new Set([...instancesService.subsystem.getInstances(), ...tasks.keys()]);
    for (const instance of instances) {
      const registered = instance.lifeCycleTaskManager.lifeCycleTask;
      const active = new Set([
        ...registered.filter((task) => task instanceof MinecraftStatusTask),
        ...(tasks.get(instance) ?? [])
      ]);
      await Promise.all([...active].map((task) => task.stop(instance)));
      for (let i = registered.length - 1; i >= 0; i--) {
        if (registered[i] instanceof MinecraftStatusTask) registered.splice(i, 1);
      }
      const command = instance.getPreset("refreshPlayers");
      if (command instanceof Command) await command.stop(instance);
    }
    tasks.clear();
  });
}
