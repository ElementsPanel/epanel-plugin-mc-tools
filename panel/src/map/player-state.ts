import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { EnableRconResult, MapPlayerRoster } from "../../../shared/map-players";
import { t } from "../settings";
import { useWorldClock } from "./world-clock";

export interface MapPlayersApi {
  /** `time` asks the daemon to calibrate the world clock over RCON. */
  players?(signal: AbortSignal, time?: boolean): Promise<MapPlayerRoster>;
  enableRcon?(signal: AbortSignal): Promise<EnableRconResult>;
}

export function useMapPlayers(api: MapPlayersApi, errorText: (error: unknown) => string) {
  const roster = ref<MapPlayerRoster>(), reading = ref(false), enabling = ref(false), prompt = ref(false);
  const worldTimes = useWorldClock(roster);
  const error = ref(""), success = ref(""), search = ref("");
  const abort = new AbortController();
  // One RCON calibration per page visit; the browser extrapolates afterwards.
  let calibrated = false;
  let prompted = false, timer: ReturnType<typeof setInterval> | undefined;
  let enableError = "";
  const players = computed(() => (roster.value?.players ?? []).filter(player => player.name.toLowerCase().includes(search.value.trim().toLowerCase())));
  async function load() {
    if (!api.players || reading.value || enabling.value || prompt.value || abort.signal.aborted) return;
    reading.value = true;
    try {
      const value = await api.players(abort.signal, !calibrated);
      if (abort.signal.aborted) return;
      calibrated = true;
      roster.value = value; error.value = enableError;
      if (api.enableRcon && value.edition === "java" && !value.rconEnabled && !prompted) { prompted = true; prompt.value = true; }
    } catch (reason) {
      if (!abort.signal.aborted) { error.value = errorText(reason); roster.value = undefined; }
    } finally { reading.value = false; }
  }
  async function enable() {
    if (!api.enableRcon || !prompt.value || enabling.value || reading.value || abort.signal.aborted) return;
    enabling.value = true; error.value = ""; success.value = ""; enableError = "";
    try {
      const result = await api.enableRcon(abort.signal);
      if (abort.signal.aborted) return;
      success.value = t(result.restartRequested ? "MC_MAP_RCON_RESTART_REQUESTED" : "MC_MAP_RCON_ENABLED");
      if (roster.value) { roster.value.rconEnabled = true; roster.value.players = []; delete roster.value.worldTimes; }
    } catch (reason) { if (!abort.signal.aborted) error.value = enableError = errorText(reason); }
    finally { enabling.value = false; prompt.value = false; }
    if (!abort.signal.aborted) await load();
  }
  const refresh = () => { if (typeof document === "undefined" || !document.hidden) void load(); };
  onMounted(() => {
    if (!api.players) return;
    void load(); timer = setInterval(refresh, 3000);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", refresh);
  });
  onBeforeUnmount(() => {
    abort.abort(); clearInterval(timer);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", refresh);
  });
  const dismissError = () => { error.value = enableError = ""; };
  return { roster, worldTimes, reading, enabling, prompt, error, success, search, players, load, enable, dismissError };
}
