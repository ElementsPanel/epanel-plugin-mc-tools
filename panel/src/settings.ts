import { ctx, usePluginService } from "@elements-panel/sdk";
import { reactive, ref } from "vue";

export interface PingInstanceInfo {
  config?: { pingConfig?: { ip?: string; port?: number; type?: number } };
}

export const t = (...args: any[]): string => ctx.i18n.translate(...args);

export function usePingSettings(instanceUuid: string, daemonId: string) {
  const instance = usePluginService("instance")!;
  const form = reactive({ ip: "", port: "", type: 1 });
  const loading = ref(false);
  const error = ref("");
  const saved = ref(false);
  const { execute } = instance.api.updateInstanceConfig();

  function load(info?: PingInstanceInfo) {
    const config = info?.config?.pingConfig;
    form.ip = config?.ip || "";
    form.port = String(config?.port || "");
    form.type = config?.type ?? 1;
    error.value = "";
    saved.value = false;
  }

  async function save() {
    if (loading.value) return false;
    error.value = "";
    saved.value = false;
    const port = Number(form.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      error.value = t("TXT_CODE_2ab036a4");
      return false;
    }
    loading.value = true;
    try {
      await execute({
        params: { uuid: instanceUuid, daemonId },
        data: { pingConfig: { ip: form.ip.trim(), port, type: form.type } }
      });
      saved.value = true;
      return true;
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : String(reason);
      return false;
    } finally {
      loading.value = false;
    }
  }

  return { form, loading, error, saved, load, save };
}
