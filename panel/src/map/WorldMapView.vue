<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { VAlert, VBtn, VProgressLinear, VSelect, VSlider, VTextField } from "vuetify/components";
import type { MapWorld, MapViewOptions, PublicMapLinks } from "../../../shared/map";
import { MAP_LIMIT, MAP_MIN_Y, MAP_MAX_Y } from "../../../shared/map";
import { t } from "../settings";
import { mapError, publicWorldMapApi, worldMapApi } from "./api";
import { MapViewport } from "./viewport";
import { publicMapUrl, mapSettingsUrl } from "./page";
import MapControls from "./MapControls.vue";

const props = withDefaults(defineProps<{ instanceUuid?: string; daemonId?: string; publicMap?: string; initialView?: MapViewOptions; fullscreen?: boolean; sidebarOpen?: boolean }>(), { sidebarOpen: undefined });
const emit = defineEmits<{ view: [value: MapViewOptions]; "update:sidebarOpen": [value: boolean] }>();
const privateApi = props.publicMap ? undefined : worldMapApi(props.instanceUuid!, props.daemonId!);
const api = privateApi ?? publicWorldMapApi(props.publicMap!);
const abort = new AbortController();
const canvas = ref<HTMLCanvasElement>();
const worlds = ref<MapWorld[]>([]);
const selected = ref("");
const loading = ref(true);
const error = ref("");
const x = ref(String(props.initialView?.x ?? 0)), z = ref(String(props.initialView?.z ?? 0));
const mode = ref<"surface" | "slice">(props.initialView?.y === undefined ? "surface" : "slice");
const height = ref(props.initialView?.y ?? 64);
const y = ref(String(height.value));
const heightError = ref("");
const range = reactive({ min: -64, max: 319 });
const layer = computed(() => mode.value === "slice" ? height.value : undefined);
const modes = computed(() => [
  { value: "surface", title: t("MC_MAP_SURFACE") },
  { value: "slice", title: t("MC_MAP_SLICE") }
]);
const state = reactive({ x: 0, z: 0, zoom: 2, loading: 0, warnings: 0 });
let viewport: MapViewport | undefined;
let drawing = 0;
let reading = false;
let firstLoad = true;
const publicLinks = ref<PublicMapLinks>({ enabled: false, canConfigure: false, maps: [] });
const current = computed(() => worlds.value.find((world) => world.id === selected.value));
const view = () => ({ x: state.x, z: state.z, zoom: state.zoom, y: layer.value });
const pageHref = computed(() => {
  const map = publicLinks.value.maps.find((item) => item.world === selected.value);
  return publicLinks.value.enabled && map ? publicMapUrl(map.id, view()) : "";
});
const settingsHref = computed(() => publicLinks.value.canConfigure ? mapSettingsUrl() : "");
const items = computed(() => worlds.value.map((world) => {
  const key = ({ "minecraft:overworld": "MC_MAP_OVERWORLD", "minecraft:the_nether": "MC_MAP_NETHER", "minecraft:the_end": "MC_MAP_END" } as Record<string, string>)[world.dimension];
  return { value: world.id, title: `${world.name} · ${key ? t(key) : world.dimension}` };
}));

async function draw(center?: { x: number; z: number }, zoom?: number) {
  const generation = ++drawing;
  viewport?.dispose();
  viewport = undefined;
  await nextTick();
  if (generation !== drawing || abort.signal.aborted || !canvas.value || !current.value) return;
  state.warnings = 0;
  viewport = new MapViewport(canvas.value, current.value, api.tile, (value) => {
    Object.assign(state, value);
    if (value.error) error.value = mapError(value.error);
  }, layer.value);
  if (zoom !== undefined) viewport.camera.zoom = zoom;
  if (center) viewport.center(center.x, center.z);
  else { x.value = String(current.value.spawn.x); z.value = String(current.value.spawn.z); }
}

async function load(refresh = false) {
  if (reading) return;
  if (refresh) void readPublicLinks();
  reading = true;
  const previous = selected.value;
  const center = { x: state.x, z: state.z };
  loading.value = true;
  drawing++;
  error.value = "";
  viewport?.dispose();
  viewport = undefined;
  try {
    worlds.value = await api.worlds(abort.signal, refresh);
    if (abort.signal.aborted) return;
    selected.value = worlds.value.some((world) => world.id === previous) ? previous : worlds.value[0]?.id || "";
    loading.value = false;
    const initial = firstLoad ? props.initialView : undefined;
    const initialCenter = initial?.x !== undefined && initial?.z !== undefined ? { x: initial.x, z: initial.z } : undefined;
    await draw(refresh && selected.value === previous ? center : initialCenter, initial?.zoom);
    firstLoad = false;
  } catch (reason) {
    if (!abort.signal.aborted) error.value = mapError(reason);
  } finally { loading.value = false; reading = false; }
}

async function readPublicLinks() {
  if (!privateApi) return;
  try {
    const result = await privateApi.publicLinks(abort.signal);
    if (!abort.signal.aborted) publicLinks.value = result;
  } catch { publicLinks.value = { enabled: false, canConfigure: false, maps: [] }; }
}

function go() {
  const targetX = Number(x.value), targetZ = Number(z.value);
  if (!Number.isInteger(targetX) || !Number.isInteger(targetZ) || Math.abs(targetX) > MAP_LIMIT || Math.abs(targetZ) > MAP_LIMIT || !x.value.trim() || !z.value.trim()) {
    error.value = t("MC_MAP_COORDINATES");
    return;
  }
  error.value = "";
  viewport?.center(targetX, targetZ);
}

function spawn() {
  if (!current.value) return;
  x.value = String(current.value.spawn.x);
  z.value = String(current.value.spawn.z);
  go();
}

function applyHeight() {
  const input = String(y.value ?? "").trim();
  const value = Number(input);
  if (!input || !Number.isInteger(value) || value < MAP_MIN_Y || value > MAP_MAX_Y) {
    heightError.value = t("MC_MAP_HEIGHT_INVALID");
    return;
  }
  heightError.value = "";
  range.min = Math.min(range.min, value);
  range.max = Math.max(range.max, value);
  height.value = value;
  y.value = String(value);
}

watch(current, (world) => {
  if (!world) return;
  const overworld = world.dimension === "minecraft:overworld";
  const custom = !["minecraft:overworld", "minecraft:the_nether", "minecraft:the_end"].includes(world.dimension);
  range.min = Math.min(custom ? MAP_MIN_Y : overworld ? -64 : 0, height.value);
  range.max = Math.max(custom ? MAP_MAX_Y : overworld ? 319 : 255, height.value);
}, { flush: "sync" });
watch(layer, (value) => {
  y.value = String(height.value);
  heightError.value = "";
  error.value = "";
  state.warnings = 0;
  viewport?.setLayer(value);
}, { flush: "sync" });
watch(selected, () => { if (!loading.value) { error.value = ""; void draw(); } }, { flush: "sync" });
watch([() => state.x, () => state.z, () => state.zoom, layer], () => emit("view", view()));
onMounted(() => { void readPublicLinks(); void load(); });
onBeforeUnmount(() => { abort.abort(); viewport?.dispose(); });
</script>

<template>
  <div class="mc-world-map" :class="{ 'mc-world-map-fullscreen': fullscreen }">
    <MapControls :open="sidebarOpen" @update:open="emit('update:sidebarOpen', $event)">
      <slot name="settings" />
      <div class="mc-map-toolbar">
        <p v-if="publicMap && current" class="mc-map-current-world">{{ t("MC_MAP_WORLD") }}: {{ items[0]?.title }}</p>
        <VSelect v-if="!publicMap" v-model="selected" :items="items" :label="t('MC_MAP_WORLD')" :disabled="loading || !worlds.length" hide-details density="compact" variant="outlined" class="mc-map-world-select" />
        <form class="mc-map-coordinates" @submit.prevent="go">
          <VTextField v-model="x" label="X" type="number" :min="-MAP_LIMIT" :max="MAP_LIMIT" step="1" hide-details density="compact" variant="outlined" />
          <VTextField v-model="z" label="Z" type="number" :min="-MAP_LIMIT" :max="MAP_LIMIT" step="1" hide-details density="compact" variant="outlined" />
          <VBtn type="submit" variant="text" :disabled="!current">{{ t("MC_MAP_GO") }}</VBtn>
        </form>
        <VBtn variant="text" :disabled="!current" @click="spawn">{{ t("MC_MAP_SPAWN") }}</VBtn>
        <VBtn variant="text" :loading="loading" @click="load(true)">{{ t("MC_MAP_REFRESH") }}</VBtn>
        <VBtn v-if="pageHref" :href="pageHref" target="_blank" rel="noopener noreferrer" variant="text">{{ t("MC_MAP_PUBLIC_OPEN") }}</VBtn>
        <VBtn v-if="settingsHref" :href="settingsHref" target="_blank" rel="noopener noreferrer" variant="text">{{ t("MC_MAP_MANAGE") }}</VBtn>
      </div>
      <div class="mc-map-layers">
        <VSelect v-model="mode" :items="modes" :label="t('MC_MAP_VIEW')" :disabled="loading || !current" hide-details density="compact" variant="outlined" class="mc-map-mode-select" />
        <template v-if="mode === 'slice'">
          <VSlider v-model="height" :min="range.min" :max="range.max" :step="1" thumb-label :aria-label="t('MC_MAP_HEIGHT')" :disabled="loading || !current" hide-details color="primary" class="mc-map-layer-slider">
            <template #prepend><span class="mc-map-range">{{ range.min }}</span></template>
            <template #append><span class="mc-map-range">{{ range.max }}</span></template>
          </VSlider>
          <form class="mc-map-height" @submit.prevent="applyHeight">
            <VTextField v-model="y" :label="t('MC_MAP_HEIGHT')" type="number" :min="MAP_MIN_Y" :max="MAP_MAX_Y" step="1" :disabled="loading || !current" :error-messages="heightError" hide-details="auto" density="compact" variant="outlined" @change="applyHeight" @keydown.enter.prevent="applyHeight" />
          </form>
        </template>
      </div>
      <p v-if="mode === 'slice'" class="mc-map-layer-hint">{{ t("MC_MAP_SLICE_HINT") }}</p>
    </MapControls>
    <div class="mc-map-surface">
      <div v-if="error || state.warnings" class="mc-map-notice">
        <VAlert v-if="error" type="error" density="compact" role="alert">{{ error }}</VAlert>
        <VAlert v-else type="warning" density="compact">{{ t("MC_MAP_PARTIAL") }}</VAlert>
      </div>
      <VProgressLinear v-if="loading || state.loading" indeterminate color="primary" class="mc-map-progress" :aria-label="t('MC_MAP_LOADING')" />
      <canvas v-if="!loading && current" ref="canvas" :aria-label="t('MC_MAP_TITLE')" role="img" />
      <div v-else class="mc-map-empty" role="status">{{ loading ? t("MC_MAP_LOADING") : error ? "" : t("MC_MAP_NO_WORLDS") }}</div>
      <template v-if="current && !loading">
        <div class="mc-map-zoom">
          <VBtn variant="text" size="small" min-width="36" :title="t('MC_MAP_ZOOM_IN')" :aria-label="t('MC_MAP_ZOOM_IN')" @click="viewport?.zoom(1.5)">+</VBtn>
          <VBtn variant="text" size="small" min-width="36" :title="t('MC_MAP_ZOOM_OUT')" :aria-label="t('MC_MAP_ZOOM_OUT')" @click="viewport?.zoom(1 / 1.5)">−</VBtn>
        </div>
        <span class="mc-map-position">X: {{ state.x }} · Z: {{ state.z }} · {{ layer === undefined ? t("MC_MAP_SURFACE") : 'Y: ' + layer }} · {{ state.zoom.toFixed(1) }}×</span>
      </template>
    </div>
  </div>
</template>

<style scoped>
.mc-world-map { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 400px; }
.mc-map-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 12px; }
.mc-map-world-select { min-width: 0; flex: 1 0 100%; }
.mc-map-current-world { flex: 1 0 100%; margin: 0; font-size: 13px; overflow-wrap: anywhere; }
.mc-map-coordinates { display: flex; align-items: center; gap: 8px; flex: 1 0 100%; min-width: 0; }
.mc-map-coordinates :deep(.v-input) { min-width: 60px; flex: 1; }
.mc-map-layers { display: flex; align-items: center; gap: 8px; padding: 0 12px 12px; }
.mc-map-mode-select { flex: 0 0 112px; min-width: 0; }
.mc-map-layer-slider { flex: 1; min-width: 0; }
.mc-map-range, .mc-map-layer-slider :deep(.v-input__prepend), .mc-map-layer-slider :deep(.v-input__append) { display: none; }
.mc-map-height { flex: 0 0 76px; }
.mc-map-layer-hint { margin: -4px 12px 12px; font-size: 12px; opacity: 0.75; }
.mc-map-surface { position: relative; flex: 1; min-height: 280px; background: #19252a; border-radius: 16px; overflow: hidden; }
.mc-map-surface canvas { display: block; width: 100%; height: 100%; position: absolute; inset: 0; cursor: grab; touch-action: none; }
.mc-map-progress { position: absolute; inset: 0 0 auto; z-index: 2; }
.mc-map-notice { position: absolute; top: 12px; left: 72px; right: 12px; z-index: 3; max-width: 620px; }
.mc-map-empty { display: grid; place-items: center; height: 100%; min-height: 280px; color: #dbe5e5; padding: 24px; text-align: center; }
.mc-map-position { position: absolute; border-radius: 6px; padding: 5px 9px; pointer-events: none; }
.mc-map-position { left: 12px; bottom: 12px; max-width: calc(100% - 84px); font-size: 12px; font-variant-numeric: tabular-nums; }
.mc-map-zoom { position: absolute; right: 12px; bottom: 12px; display: flex; flex-direction: column; gap: 4px; padding: 4px; border-radius: 6px; }
.mc-map-position, .mc-map-zoom { color: rgb(var(--v-theme-on-surface)); background: rgba(var(--v-theme-surface), 0.96); box-shadow: 0 3px 16px #0004; }
.mc-map-zoom :deep(.v-btn) { color: inherit; }
.mc-world-map-fullscreen { position: absolute; inset: 0; min-height: 0; }
.mc-world-map-fullscreen .mc-map-surface { position: absolute; inset: 0; min-height: 0; border-radius: 0; }
.mc-world-map-fullscreen .mc-map-position { left: 16px; bottom: 16px; }
.mc-world-map-fullscreen .mc-map-zoom { right: 16px; bottom: 16px; }
</style>
