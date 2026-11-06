<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from "vue";
import { VAlert, VBtn, VCard, VCardActions, VCardText, VDialog, VList, VListItem, VMenu, VProgressLinear, VSelect, VSlider, VSpacer, VTextField } from "vuetify/components";
import type { MapWorld, MapViewOptions } from "../../../shared/map";
import type { MapPlayer } from "../../../shared/map-players";
import { MAP_LIMIT, MAP_MIN_Y, MAP_MAX_Y } from "../../../shared/map";
import { t } from "../settings";
import { mapError, publicWorldMapApi, worldMapApi } from "./api";
import { MapViewport, type MapViewState } from "./viewport";
import MapControls from "./MapControls.vue";
import PlayerAvatar from "./PlayerAvatar.vue";
import SpawnMarker from "./SpawnMarker.vue";
import { useMapPlayers } from "./player-state";
import { playerMarkers, worldForPlayer } from "./player-markers";

const props = withDefaults(defineProps<{ instanceUuid?: string; daemonId?: string; publicMap?: string; initialView?: MapViewOptions; fullscreen?: boolean; sidebarOpen?: boolean }>(), { sidebarOpen: undefined });
const emit = defineEmits<{ view: [value: MapViewOptions]; "update:sidebarOpen": [value: boolean] }>();
const api = props.publicMap ? publicWorldMapApi(props.publicMap) : worldMapApi(props.instanceUuid!, props.daemonId!);
const { roster, reading: readingPlayers, enabling, prompt: rconPrompt, error: playerError, success: playerSuccess,
  search: playerSearch, players, load: loadPlayers, enable: enableRcon, dismissError: dismissPlayerError } = useMapPlayers(api, mapError);
const abort = new AbortController();
const canvas = ref<HTMLCanvasElement>();
const mapRoot = ref<HTMLElement>();
const toolsOpen = ref(false);
const worlds = ref<MapWorld[]>([]);
const selected = ref("");
const loading = ref(true);
const error = ref("");
const x = ref(String(props.initialView?.x ?? 0)), z = ref(String(props.initialView?.z ?? 0));
const mode = ref<"surface" | "slice">(props.initialView?.y === undefined ? "surface" : "slice");
const renderMode = ref<"2d" | "3d">(props.initialView?.render ?? "2d");
const height = ref(props.initialView?.y ?? 64);
const y = ref(String(height.value));
const heightError = ref("");
const range = reactive({ min: -64, max: 319 });
const layer = computed(() => mode.value === "slice" ? height.value : undefined);
const modes = computed(() => [
  { value: "surface", title: t("MC_MAP_SURFACE") },
  { value: "slice", title: t("MC_MAP_SLICE") }
]);
const state = reactive({ x: 0, z: 0, zoom: 2, loading: 0, warnings: 0, limited: false, empty: false });
let viewport: MapViewport | undefined;
let nextCenter: { x: number; z: number } | undefined;
const markers = shallowRef<ReturnType<typeof playerMarkers>>([]);
const spawnMarker = shallowRef<{ x: number; y: number }>();
function updateMarkers() {
  markers.value = viewport ? playerMarkers(roster.value?.players ?? [], worlds.value, selected.value, point => viewport?.project(point)) : [];
  spawnMarker.value = viewport?.projectSpawn?.();
}
function locatePlayer(player: MapPlayer) {
  const world = worldForPlayer(player, worlds.value);
  if (!world || !player.position || loading.value) return;
  const position = player.position;
  x.value = String(Math.floor(position.x)); z.value = String(Math.floor(position.z));
  if (mode.value === "slice" && height.value < position.y + 1) height.value = Math.min(MAP_MAX_Y, Math.ceil(position.y + 1));
  if (selected.value !== world.id) { nextCenter = position; selected.value = world.id; }
  else viewport?.center(position.x, position.z);
}
function playerLocation(player: MapPlayer) {
  if (!player.position) return t("MC_MAP_PLAYERS_POSITION_UNAVAILABLE");
  const position = player.position;
  const dimension = ({ "minecraft:overworld": "MC_MAP_OVERWORLD", "minecraft:the_nether": "MC_MAP_NETHER", "minecraft:the_end": "MC_MAP_END" } as Record<string, string>)[position.dimension];
  return `${dimension ? t(dimension) : position.dimension} · X: ${Math.floor(position.x)} · Y: ${Math.floor(position.y)} · Z: ${Math.floor(position.z)}`;
}
let drawing = 0;
let reading = false;
let firstLoad = true;
const current = computed(() => worlds.value.find((world) => world.id === selected.value));
const view = (): MapViewOptions => ({ x: state.x, z: state.z, zoom: state.zoom, y: layer.value, ...(renderMode.value === "3d" ? { render: "3d" } : {}) });
const items = computed(() => worlds.value.map((world) => {
  const key = ({ "minecraft:overworld": "MC_MAP_OVERWORLD", "minecraft:the_nether": "MC_MAP_NETHER", "minecraft:the_end": "MC_MAP_END" } as Record<string, string>)[world.dimension];
  return { value: world.id, title: `${world.name} · ${key ? t(key) : world.dimension}` };
}));

async function draw(center?: { x: number; z: number }, zoom?: number) {
  const generation = ++drawing;
  viewport?.dispose();
  viewport = undefined;
  updateMarkers();
  await nextTick();
  if (generation !== drawing || abort.signal.aborted || !canvas.value || !current.value) return;
  Object.assign(state, { warnings: 0, loading: 0, limited: false, empty: false });
  const changed = (value: MapViewState) => {
    if (generation !== drawing || abort.signal.aborted) return;
    Object.assign(state, value);
    updateMarkers();
    if (value.error) {
      error.value = mapError(value.error);
      if (value.error instanceof Error && value.error.message === "MC_MAP_WEBGL_UNAVAILABLE") renderMode.value = "2d";
    }
  };
  viewport = new MapViewport(canvas.value, current.value, api.tile, changed, layer.value, api.scene);
  if (zoom !== undefined) viewport.camera.zoom = zoom;
  if (center) viewport.center(center.x, center.z);
  else { x.value = String(current.value.spawn.x); z.value = String(current.value.spawn.z); }
  viewport.setMode(renderMode.value);
  updateMarkers();
}

async function load(refresh = false) {
  if (reading) return;
  reading = true;
  const previous = selected.value;
  const center = { x: state.x, z: state.z };
  const zoom = state.zoom;
  loading.value = true;
  drawing++;
  error.value = "";
  viewport?.dispose();
  viewport = undefined;
  updateMarkers();
  try {
    worlds.value = await api.worlds(abort.signal, refresh);
    if (abort.signal.aborted) return;
    selected.value = worlds.value.some((world) => world.id === previous) ? previous : worlds.value[0]?.id || "";
    loading.value = false;
    const initial = firstLoad ? props.initialView : undefined;
    const initialCenter = initial?.x !== undefined && initial?.z !== undefined ? { x: initial.x, z: initial.z } : undefined;
    await draw(refresh && selected.value === previous ? center : initialCenter, refresh && selected.value === previous ? zoom : initial?.zoom);
    firstLoad = false;
  } catch (reason) {
    if (!abort.signal.aborted) error.value = mapError(reason);
  } finally { loading.value = false; reading = false; }
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
watch(selected, () => { if (!loading.value) { error.value = ""; void draw(nextCenter); nextCenter = undefined; } }, { flush: "sync" });
watch([roster, current], updateMarkers);
watch(renderMode, value => viewport?.setMode(value));
watch([() => state.x, () => state.z, () => state.zoom, layer, renderMode], () => emit("view", view()));
onMounted(() => { void load(); });
onBeforeUnmount(() => { abort.abort(); viewport?.dispose(); });
</script>

<template>
  <div ref="mapRoot" class="mc-world-map" :class="{ 'mc-world-map-fullscreen': fullscreen }">
    <VDialog v-if="!publicMap" v-model="rconPrompt" max-width="520" :persistent="enabling">
      <VCard :title="t('MC_MAP_RCON_PROMPT_TITLE')">
        <VCardText>{{ t('MC_MAP_RCON_PROMPT_TEXT') }}</VCardText>
        <VCardActions>
          <VSpacer />
          <VBtn :disabled="enabling" @click="rconPrompt = false">{{ t('MC_MAP_CANCEL') }}</VBtn>
          <VBtn :loading="enabling" :disabled="readingPlayers" @click="enableRcon">{{ t('MC_PLAYERS_QUERY_ENABLE') }}</VBtn>
        </VCardActions>
      </VCard>
    </VDialog>
    <MapControls :open="sidebarOpen" players @update:open="emit('update:sidebarOpen', $event)">
      <template #players>
        <div class="mc-map-players-toolbar">
          <VTextField v-model="playerSearch" :label="t('MC_MAP_PLAYERS_SEARCH')" hide-details density="compact" variant="outlined" />
          <VBtn variant="text" :loading="readingPlayers" :disabled="enabling" @click="loadPlayers">{{ t('MC_PLAYERS_REFRESH') }}</VBtn>
        </div>
        <div class="mc-map-players-status" role="status">
          <p>{{ t('MC_PLAYERS_ONLINE') }}: {{ roster?.rconEnabled && roster.running && (!roster.warnings.length || roster.players.length) ? roster.players.length : '—' }}</p>
          <p v-if="roster && !roster.running">{{ t('MC_MAP_PLAYERS_STOPPED') }}</p>
          <template v-if="roster?.edition === 'java' && !roster.rconEnabled">
            <p>{{ t('MC_MAP_RCON_DISABLED') }}</p>
            <VBtn v-if="!publicMap" variant="text" @click="rconPrompt = true">{{ t('MC_MAP_RCON_PROMPT_TITLE') }}</VBtn>
          </template>
          <p v-for="warning in roster?.warnings ?? []" :key="warning">{{ t(warning) }}</p>
        </div>
        <VList nav :aria-label="t('MC_MAP_PLAYERS_MENU')">
          <VListItem v-for="player in players" :key="player.name" :title="player.name" :subtitle="playerLocation(player)" :disabled="loading || !worldForPlayer(player, worlds)" @click="locatePlayer(player)">
            <template #prepend><PlayerAvatar :name="player.name" class="mc-map-list-avatar" /></template>
            <template v-if="worldForPlayer(player, worlds)" #append><span class="mc-map-locate-hint">{{ t('MC_MAP_GO') }}</span></template>
          </VListItem>
        </VList>
        <p v-if="!players.length && roster?.running && roster.rconEnabled && !roster.warnings.length" class="mc-map-players-status">{{ t(playerSearch ? 'MC_PLAYERS_NO_MATCH' : 'MC_MAP_PLAYERS_EMPTY') }}</p>
      </template>
      <slot name="settings" />
      <VList v-if="!publicMap" nav :aria-label="t('MC_MAP_WORLDS_MENU')">
        <VListItem v-for="item in items" :key="item.value" :title="item.title" :active="selected === item.value" :disabled="loading" prepend-icon="mdi-earth" @click="selected = item.value" />
      </VList>
    </MapControls>
    <div class="mc-map-surface">
      <div v-if="error || state.warnings || state.limited || playerError || playerSuccess" class="mc-map-notice">
        <VAlert v-if="error" type="error" density="compact" role="alert">{{ error }}</VAlert>
        <VAlert v-else-if="state.warnings || state.limited" type="warning" density="compact">{{ t(state.limited ? "MC_MAP_SCENE_LIMIT" : "MC_MAP_PARTIAL") }}</VAlert>
        <VAlert v-if="playerError" type="error" density="compact" closable @click:close="dismissPlayerError">{{ playerError }}</VAlert>
        <VAlert v-if="playerSuccess" type="success" density="compact" closable @click:close="playerSuccess = ''">{{ playerSuccess }}</VAlert>
      </div>
      <VProgressLinear v-if="loading || state.loading" indeterminate color="primary" class="mc-map-progress" :aria-label="t(renderMode === '3d' ? 'MC_MAP_3D_LOADING' : 'MC_MAP_LOADING')" />
      <canvas v-if="!loading && current" ref="canvas" :data-renderer="renderMode" :aria-label="t(renderMode === '3d' ? 'MC_MAP_3D_SCENE' : 'MC_MAP_TITLE')" tabindex="0" role="img" />
      <div v-else class="mc-map-empty" role="status">{{ loading ? t("MC_MAP_LOADING") : error ? "" : t("MC_MAP_NO_WORLDS") }}</div>
      <div class="mc-map-player-overlay" aria-hidden="true">
        <SpawnMarker v-if="spawnMarker" :x="spawnMarker.x" :y="spawnMarker.y" />
        <div v-for="marker in markers" :key="marker.name" class="mc-map-player-marker" :style="{ left: marker.x + 'px', top: marker.y + 'px' }">
          <span v-if="marker.angle !== undefined" class="mc-map-player-facing" :style="{ transform: `rotate(${marker.angle}deg)` }" />
          <PlayerAvatar :name="marker.name" :size="28" />
          <span class="mc-map-player-name">{{ marker.name }}</span>
        </div>
      </div>
      <VMenu v-model="toolsOpen" location="top start" :offset="12" :close-on-content-click="false" :attach="mapRoot" contained>
        <template #activator="{ props: menuProps }">
          <VBtn v-bind="menuProps" class="mc-map-position" prepend-icon="mdi-tune-variant" :title="t('MC_MAP_POSITION_SETTINGS')" :aria-label="t('MC_MAP_POSITION_SETTINGS')" :aria-expanded="toolsOpen">
            <template v-if="current">X: {{ state.x }} · Z: {{ state.z }} · {{ layer === undefined ? t("MC_MAP_SURFACE") : 'Y: ' + layer }} · {{ state.zoom.toFixed(1) }}×</template>
            <template v-else>{{ t("MC_MAP_POSITION_SETTINGS") }}</template>
          </VBtn>
        </template>
        <VCard class="mc-map-tools-card" :title="t('MC_MAP_POSITION_SETTINGS')">
          <template #append><VBtn icon="mdi-close" variant="text" size="small" :aria-label="t('MC_MAP_CONTROLS_CLOSE')" @click="toolsOpen = false" /></template>
          <div class="mc-map-toolbar">
            <form class="mc-map-coordinates" @submit.prevent="go">
              <VTextField v-model="x" label="X" type="number" :min="-MAP_LIMIT" :max="MAP_LIMIT" step="1" hide-details density="compact" variant="outlined" />
              <VTextField v-model="z" label="Z" type="number" :min="-MAP_LIMIT" :max="MAP_LIMIT" step="1" hide-details density="compact" variant="outlined" />
              <VBtn type="submit" variant="text" :disabled="!current">{{ t("MC_MAP_GO") }}</VBtn>
            </form>
            <VBtn variant="text" :disabled="!current" @click="spawn">{{ t("MC_MAP_SPAWN") }}</VBtn>
            <VBtn variant="text" :loading="loading" @click="load(true)">{{ t("MC_MAP_REFRESH") }}</VBtn>
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
          <p v-if="mode === 'slice'" class="mc-map-layer-hint">{{ t(renderMode === '3d' ? "MC_MAP_3D_SLICE_HINT" : "MC_MAP_SLICE_HINT") }}</p>
          <p v-if="renderMode === '3d'" class="mc-map-layer-hint">{{ t("MC_MAP_3D_HINT") }}</p>
        </VCard>
      </VMenu>
      <template v-if="current && !loading">
        <VBtn class="mc-map-render-toggle" :width="48" :height="48" :title="t(renderMode === '2d' ? 'MC_MAP_3D_ENTER' : 'MC_MAP_3D_EXIT')" :aria-label="t(renderMode === '2d' ? 'MC_MAP_3D_ENTER' : 'MC_MAP_3D_EXIT')" :aria-pressed="renderMode === '3d'" @click="error = ''; renderMode = renderMode === '2d' ? '3d' : '2d'">{{ renderMode === '2d' ? '3D' : '2D' }}</VBtn>
        <div v-if="renderMode === '3d' && state.empty" class="mc-map-scene-empty" role="status">{{ t("MC_MAP_3D_EMPTY") }}</div>
        <div class="mc-map-zoom">
          <VBtn variant="text" size="small" min-width="36" :title="t('MC_MAP_ZOOM_IN')" :aria-label="t('MC_MAP_ZOOM_IN')" @click="viewport?.zoom(1.5)">+</VBtn>
          <VBtn variant="text" size="small" min-width="36" :title="t('MC_MAP_ZOOM_OUT')" :aria-label="t('MC_MAP_ZOOM_OUT')" @click="viewport?.zoom(1 / 1.5)">−</VBtn>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.mc-world-map { --mc-map-control-radius: 16px; --mc-map-control-gap: 12px; position: relative; display: flex; flex-direction: column; height: 100%; min-height: 400px; }
.mc-map-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 12px; }
.mc-map-coordinates { display: flex; align-items: center; gap: 8px; flex: 1 0 100%; min-width: 0; }
.mc-map-coordinates :deep(.v-input) { min-width: 60px; flex: 1; }
.mc-map-layers { display: flex; align-items: center; gap: 8px; padding: 0 12px 12px; }
.mc-map-mode-select { flex: 0 0 112px; min-width: 0; }
.mc-map-layer-slider { flex: 1; min-width: 0; }
.mc-map-range, .mc-map-layer-slider :deep(.v-input__prepend), .mc-map-layer-slider :deep(.v-input__append) { display: none; }
.mc-map-height { flex: 0 0 76px; }
.mc-map-layer-hint { margin: -4px 12px 12px; font-size: 12px; opacity: 0.75; }
.mc-map-surface { position: relative; flex: 1; min-height: 280px; background: #19252a; overflow: hidden; }
.mc-map-surface canvas { display: block; width: 100%; height: 100%; position: absolute; inset: 0; cursor: grab; touch-action: none; }
.mc-map-progress { position: absolute; inset: 0 0 auto; z-index: 2; }
.mc-map-player-overlay { position: absolute; inset: 0; z-index: 1; pointer-events: none; overflow: hidden; }
.mc-map-player-marker { position: absolute; width: 28px; height: 28px; transform: translate(-50%, -50%); }
.mc-map-player-name { position: absolute; top: 34px; left: 50%; transform: translateX(-50%); color: #fff; background: rgba(0, 0, 0, 0.5); border-radius: 0; padding: 1px 5px; font-size: 11px; white-space: nowrap; }
.mc-map-player-facing { position: absolute; inset: 0; }
.mc-map-player-facing::before { content: ""; position: absolute; left: 9px; top: -12px; border: 5px solid transparent; border-top: 0; border-bottom: 8px solid #fff; }
.mc-map-players-toolbar { display: flex; align-items: center; gap: 8px; padding: 12px; }
.mc-map-players-status { padding: 0 16px; font-size: 13px; }
.mc-map-players-status p { margin: 8px 0; }
.mc-map-list-avatar { margin-right: 12px; }
.mc-map-locate-hint { font-size: 12px; opacity: 0.7; margin-left: 8px; }
.mc-map-notice { position: absolute; top: 12px; left: 84px; right: 84px; z-index: 3; max-width: 620px; }
.mc-map-render-toggle { position: absolute; top: var(--mc-map-control-gap); right: var(--mc-map-control-gap); z-index: 3; min-width: 48px; padding: 8px; font-weight: 600; }
/* Outrank desktop mode's injected !important radius reset, regardless of load order. */
.mc-map-surface .mc-map-render-toggle { border-radius: var(--mc-map-control-radius) !important; }
.mc-map-scene-empty { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(420px, 90%); text-align: center; padding: 16px; border-radius: 16px; color: rgb(var(--v-theme-on-surface)); background: rgba(var(--v-theme-surface), 0.96); pointer-events: none; }
.mc-map-empty { display: grid; place-items: center; height: 100%; min-height: 280px; color: #dbe5e5; padding: 24px; text-align: center; }
.mc-map-surface .mc-map-position { position: absolute; z-index: 3; border-radius: var(--mc-map-control-radius) !important; height: auto; min-height: 44px; padding: 12px 16px; text-transform: none; }
.mc-map-position { left: var(--mc-map-control-gap); bottom: var(--mc-map-control-gap); max-width: calc(100% - 96px); font-size: 12px; font-variant-numeric: tabular-nums; }
.mc-map-zoom { position: absolute; right: var(--mc-map-control-gap); bottom: var(--mc-map-control-gap); display: flex; flex-direction: column; gap: 4px; padding: 8px; border-radius: var(--mc-map-control-radius); overflow: hidden; }
.mc-map-tools-card.v-card { width: min(400px, calc(100vw - 24px)); max-height: min(70dvh, 540px); overflow-y: auto; overscroll-behavior: contain; border-radius: 18px !important; }
.mc-map-position :deep(.v-btn__content) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
.mc-map-position, .mc-map-zoom, .mc-map-render-toggle { color: rgb(var(--v-theme-on-surface)); background: rgba(var(--v-theme-surface), 0.96); box-shadow: 0 3px 16px #0004; }
.mc-map-zoom :deep(.v-btn) { color: inherit; }
.mc-world-map-fullscreen { position: absolute; inset: 0; min-height: 0; }
.mc-world-map-fullscreen .mc-map-surface { position: absolute; inset: 0; min-height: 0; }
</style>
