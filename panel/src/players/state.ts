import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { playerOperation, type ManagedPlayer, type PlayerAction, type PlayerGameMode, type PlayerRoster } from "../../../shared/players";
import { playersApi, playersError } from "./api";
import { t } from "../settings";

export function usePlayers(instanceUuid: string, daemonId: string) {
  const api = playersApi(instanceUuid, daemonId);
  const abort = new AbortController();
  const roster = ref<PlayerRoster>();
  const reading = ref(false), loading = ref(false), acting = ref(false);
  const error = ref(""), success = ref("");
  const queryPrompt = ref(false), enablingQuery = ref(false);
  let queryPrompted = false;
  const search = ref(""), filter = ref("all"), page = ref(1);
  const form = reactive({ player: "", action: "kick" as PlayerAction, reason: "", mode: "survival" as PlayerGameMode, destination: "coordinates", target: "", x: "0", y: "64", z: "0" });
  const names = computed(() => (roster.value?.players || []).map(player => player.name).filter(Boolean).slice(0, 500));
  const online = computed(() => roster.value?.players.filter(player => player.online).length || 0);
  const filtered = computed(() => (roster.value?.players || []).filter(player => {
    if (filter.value === "online" && player.online !== true || filter.value === "whitelist" && !player.whitelisted || filter.value === "banned" && !player.banned || filter.value === "operators" && !player.operator) return false;
    const query = String(search.value || "").trim().toLowerCase();
    return !query || [player.name, player.uuid, player.xuid].some(value => value?.toLowerCase().includes(query));
  }));
  const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / 25)));
  const players = computed(() => filtered.value.slice((page.value - 1) * 25, page.value * 25));
  watch([search, filter], () => { page.value = 1; });
  watch(pages, value => { page.value = Math.min(page.value, value); });

  async function load(silent = false) {
    if (reading.value || acting.value || enablingQuery.value || queryPrompt.value || abort.signal.aborted) return;
    reading.value = true;
    if (!silent) { loading.value = true; error.value = ""; }
    try {
      const value = await api.list(abort.signal);
      if (abort.signal.aborted) return;
      roster.value = value;
      if (!value.actions.includes(form.action)) form.action = value.actions[0] || "kick";
      if (value.edition === "bedrock" && filter.value === "banned") filter.value = "all";
      if (value.edition === "java" && value.queryEnabled === false && !queryPrompted) {
        queryPrompted = true;
        queryPrompt.value = true;
      }
    } catch (reason) {
      if (!abort.signal.aborted) error.value = playersError(reason);
    } finally { reading.value = false; loading.value = false; }
  }

  async function enableQuery() {
    if (!queryPrompt.value || enablingQuery.value || reading.value || acting.value || abort.signal.aborted || roster.value?.edition !== "java") return;
    enablingQuery.value = true;
    error.value = ""; success.value = "";
    try {
      const result = await api.enableQuery(abort.signal);
      if (abort.signal.aborted) return;
      success.value = t(result.restartRequested ? "MC_PLAYERS_QUERY_RESTART_REQUESTED" : "MC_PLAYERS_QUERY_ENABLED");
      if (roster.value) roster.value.queryEnabled = true;
    } catch (reason) {
      if (!abort.signal.aborted) error.value = playersError(reason);
    } finally {
      enablingQuery.value = false;
      queryPrompt.value = false;
    }
    if (!abort.signal.aborted) await load(true);
  }

  function manage(player: ManagedPlayer) {
    if (!player.name) return;
    form.player = player.name;
    error.value = ""; success.value = "";
  }

  async function execute() {
    if (acting.value || reading.value || enablingQuery.value || queryPrompt.value || abort.signal.aborted) return;
    error.value = ""; success.value = "";
    let completed = false;
    try {
      if (!roster.value?.running) throw new Error("MC_PLAYERS_NOT_RUNNING");
      const operation = playerOperation({
        action: form.action, player: String(form.player || "").trim(), reason: form.reason, mode: form.mode,
        destination: form.destination === "player" ? { player: String(form.target || "").trim() } : {
          x: form.x.trim() ? Number(form.x) : NaN, y: form.y.trim() ? Number(form.y) : NaN, z: form.z.trim() ? Number(form.z) : NaN
        }
      });
      acting.value = true;
      const result = await api.action(operation, abort.signal);
      if (abort.signal.aborted) return;
      if (result.ok) { success.value = result.message || t("MC_PLAYERS_DONE"); completed = true; }
      else error.value = result.message || t("MC_PLAYERS_COMMAND_FAILED");
    } catch (reason) {
      if (!abort.signal.aborted) error.value = playersError(reason);
    } finally { acting.value = false; }
    if (completed) await load(true);
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  onMounted(() => {
    void load();
    timer = setInterval(() => { if (!document.hidden) void load(true); }, 15_000);
  });
  onBeforeUnmount(() => { abort.abort(); clearInterval(timer); });
  return { roster, reading, loading, acting, error, success, queryPrompt, enablingQuery, enableQuery, search, filter, page, form, names, online, filtered, pages, players, load, manage, execute };
}
