import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { mapSource, parseMapSource, publicMapId, type MapInstance, type MapNode, type MapSettings, type MapWorld } from "../../../shared/map";
import { t } from "../settings";
import { mapError, mapSettingsApi } from "./api";

export function worldLabel(world: MapWorld) {
  const key = ({ "minecraft:overworld": "MC_MAP_OVERWORLD", "minecraft:the_nether": "MC_MAP_NETHER", "minecraft:the_end": "MC_MAP_END" } as Record<string, string>)[world.dimension];
  return `${world.name} · ${key ? t(key) : world.dimension}`;
}

export function useMapSettings() {
  const api = mapSettingsApi();
  const abort = new AbortController();
  let instanceAbort = new AbortController(), worldAbort = new AbortController();
  const settings = ref<MapSettings>({ mapPageEnabled: false, publicMaps: [] });
  const nodes = ref<MapNode[]>([]), instances = ref<MapInstance[]>([]), worlds = ref<MapWorld[]>([]);
  const loading = ref(false), ready = ref(false), saving = ref(false), saved = ref(false), error = ref("");
  const dialog = ref(false), loadingInstances = ref(false), loadingWorlds = ref(false);
  const instanceError = ref(""), worldError = ref(""), editorError = ref("");
  const search = ref(""), page = ref(1), maxPage = ref(0);
  const draft = reactive({ index: -1, id: "", name: "", daemonId: "", instanceUuid: "", world: "" });
  let originalSource = "", suggestedName = "", baseline = "";
  const dirty = computed(() => ready.value && JSON.stringify(settings.value) !== baseline);
  const nodeItems = computed(() => nodes.value.map((node) => ({
    value: node.id, title: node.name + (node.available ? "" : ` · ${t("MC_MAP_NODE_OFFLINE")}`), props: { disabled: !node.available }
  })));
  const instanceItems = computed(() => instances.value.map((item) => ({ value: item.id, title: item.name })));
  const worldItems = computed(() => worlds.value.map((world) => ({ value: world.id, title: worldLabel(world) })));
  const validSource = computed(() => Boolean(draft.daemonId && draft.instanceUuid && draft.world) &&
    (mapSource(draft.daemonId, draft.instanceUuid, draft.world) === originalSource || worlds.value.some((world) => world.id === draft.world)));
  const canApply = computed(() => validSource.value && Boolean(draft.name.trim()) && !loadingInstances.value && !loadingWorlds.value);

  async function load() {
    if (loading.value || saving.value) return;
    loading.value = true; error.value = "";
    try {
      const [values, list] = await Promise.all([api.read(abort.signal), api.nodes(abort.signal)]);
      if (abort.signal.aborted) return;
      settings.value = values; nodes.value = list; baseline = JSON.stringify(values); ready.value = true;
    } catch (reason) { if (!abort.signal.aborted) error.value = mapError(reason); }
    finally { loading.value = false; }
  }

  async function loadInstances(targetPage = 1) {
    instanceAbort.abort();
    const request = instanceAbort = new AbortController();
    instances.value = []; instanceError.value = ""; maxPage.value = 0; page.value = targetPage;
    if (!draft.daemonId || !dialog.value) { loadingInstances.value = false; return; }
    loadingInstances.value = true;
    try {
      const result = await api.instances(draft.daemonId, targetPage, search.value, draft.instanceUuid, request.signal);
      if (request.signal.aborted) return;
      instances.value = result.data;
      if (result.selected && !instances.value.some((item) => item.id === result.selected!.id)) instances.value.unshift(result.selected);
      maxPage.value = result.maxPage;
    } catch (reason) { if (!request.signal.aborted) instanceError.value = mapError(reason); }
    finally { if (!request.signal.aborted) loadingInstances.value = false; }
  }

  async function loadWorlds() {
    worldAbort.abort();
    const request = worldAbort = new AbortController();
    worlds.value = []; worldError.value = "";
    if (!draft.instanceUuid || !dialog.value) { loadingWorlds.value = false; return; }
    loadingWorlds.value = true;
    try {
      const result = await api.worlds(draft.daemonId, draft.instanceUuid, request.signal);
      if (request.signal.aborted) return;
      worlds.value = result;
    } catch (reason) { if (!request.signal.aborted) worldError.value = mapError(reason); }
    finally { if (!request.signal.aborted) loadingWorlds.value = false; }
  }

  function selectNode(value: string) {
    if (value === draft.daemonId) return;
    draft.daemonId = value; draft.instanceUuid = ""; draft.world = ""; search.value = "";
    void loadWorlds(); void loadInstances();
  }
  function selectInstance(value: string) {
    if (value === draft.instanceUuid) return;
    draft.instanceUuid = value; draft.world = "";
    void loadWorlds();
  }
  function selectWorld(value: string) {
    draft.world = value;
    const world = worlds.value.find((world) => world.id === value);
    if (!world) return;
    const name = instances.value.find((item) => item.id === draft.instanceUuid)?.name;
    const suggested = `${name ? name + " · " : ""}${worldLabel(world)}`.slice(0, 100);
    if (!draft.name || draft.name === suggestedName) draft.name = suggested;
    suggestedName = suggested;
  }

  function edit(index = -1) {
    if (!ready.value || saving.value || (index < 0 && settings.value.publicMaps.length >= 32)) return;
    const entry = settings.value.publicMaps[index];
    const source = entry ? parseMapSource(entry.source) : undefined;
    originalSource = entry?.source ?? ""; suggestedName = ""; search.value = ""; editorError.value = "";
    Object.assign(draft, { index, id: entry?.id ?? "", name: entry?.name ?? "", daemonId: source?.daemonId ?? "", instanceUuid: source?.instanceUuid ?? "", world: source?.world ?? "" });
    dialog.value = true;
    const available = nodes.value.filter((node) => node.available);
    if (!draft.daemonId && available.length === 1) draft.daemonId = available[0].id;
    void loadInstances(); void loadWorlds();
  }

  function apply() {
    if (!canApply.value) return;
    try {
      if (draft.name.length > 100 || /[\x00-\x1f\x7f]/.test(draft.name)) throw new Error("MC_MAP_PAGE_SETTINGS_INVALID");
      if (draft.id) publicMapId(draft.id);
      if (draft.id && settings.value.publicMaps.some((map, index) => index !== draft.index && map.id === draft.id)) throw new Error("MC_MAP_PAGE_SETTINGS_INVALID");
      const entry = { id: draft.id, name: draft.name.trim(), source: mapSource(draft.daemonId, draft.instanceUuid, draft.world) };
      if (draft.index < 0) settings.value.publicMaps.push(entry);
      else settings.value.publicMaps[draft.index] = entry;
      dialog.value = false;
    } catch { editorError.value = t("MC_MAP_PAGE_SETTINGS_INVALID"); }
  }

  function remove(index: number) { if (!saving.value) settings.value.publicMaps.splice(index, 1); }
  async function save() {
    if (!ready.value || saving.value || dialog.value || !dirty.value) return;
    saving.value = true; error.value = ""; saved.value = false;
    try {
      const values = JSON.parse(JSON.stringify(settings.value));
      const result = await api.save(values, abort.signal);
      if (abort.signal.aborted) return;
      settings.value = result; baseline = JSON.stringify(result); saved.value = true;
    } catch (reason) { if (!abort.signal.aborted) error.value = mapError(reason); }
    finally { saving.value = false; }
  }

  watch(settings, () => { saved.value = false; }, { deep: true, flush: "sync" });
  watch(dialog, (open) => { if (!open) { instanceAbort.abort(); worldAbort.abort(); loadingInstances.value = loadingWorlds.value = false; } }, { flush: "sync" });
  onMounted(() => void load());
  onBeforeUnmount(() => { abort.abort(); instanceAbort.abort(); worldAbort.abort(); });
  return { settings, nodes, instances, worlds, loading, ready, saving, saved, error, dirty, dialog, draft,
    loadingInstances, loadingWorlds, instanceError, worldError, editorError, search, page, maxPage,
    nodeItems, instanceItems, worldItems, canApply, load, loadInstances, selectNode, selectInstance, selectWorld, edit, apply, remove, save };
}
