<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from "vue";
import { VAlert, VBtn, VCard, VCardActions, VCardText, VDialog, VIcon, VList, VListItem, VMenu, VProgressLinear, VSpacer, VTextField } from "vuetify/components";
import type { MapWorld, MapViewOptions } from "../../../shared/map";
import type { MapPlayer } from "../../../shared/map-players";
import { MAP_LIMIT } from "../../../shared/map";
import type { MapMarker, MapMenuItem } from "../../../shared/embed";
import { t } from "../settings";
import { notification } from "@elementspanel/epanel-plugin-console/tools/vuetifyToast";
import { mapError, publicWorldMapApi, worldMapApi } from "./api";
import { MapViewport, type MapViewState } from "./viewport";
import MapControls from "./MapControls.vue";
import PlayerAvatar from "./PlayerAvatar.vue";
import SpawnMarker from "./SpawnMarker.vue";
import { useMapPlayers } from "./player-state";
import { playerMarkers, worldForPlayer } from "./player-markers";

const props = withDefaults(defineProps<{
  instanceUuid?: string; daemonId?: string; publicMap?: string; initialView?: MapViewOptions;
  fullscreen?: boolean; sidebarOpen?: boolean;
  /** Pins injected by the embedding page through the postMessage bridge. */
  customMarkers?: MapMarker[];
  /** Sidebar entries injected by the embedding page. */
  menuItems?: MapMenuItem[];
}>(), { sidebarOpen: undefined, customMarkers: () => [], menuItems: () => [] });
const emit = defineEmits<{ view: [value: MapViewOptions]; "update:sidebarOpen": [value: boolean]; marker: [id: string]; menu: [id: string] }>();
const api = props.publicMap ? publicWorldMapApi(props.publicMap) : worldMapApi(props.instanceUuid!, props.daemonId!);
const { roster, worldTimes, reading: readingPlayers, enabling, prompt: rconPrompt, error: playerError, success: playerSuccess,
  search: playerSearch, players, load: loadPlayers, enable: enableRcon } = useMapPlayers(api, mapError);
const abort = new AbortController();
const canvas = ref<HTMLCanvasElement>();
const mapRoot = ref<HTMLElement>();
const toolsOpen = ref(false);
const worlds = ref<MapWorld[]>([]);
const selected = ref("");
const worldTimeIcon = computed(() => worldTimes.value[selected.value] === undefined ? "mdi-clock-outline"
  : worldTimes.value[selected.value] < 12000 ? "mdi-white-balance-sunny" : "mdi-weather-night");
const worldTime = computed(() => {
  const ticks = worldTimes.value[selected.value];
  if (ticks === undefined || !Number.isInteger(ticks) || ticks < 0 || ticks >= 24000) return;
  // A Minecraft day starts at 06:00; 1,000 ticks equal one in-game hour.
  const minutes = (Math.floor(ticks * 60 / 1000) + 360) % 1440;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
});
const worldTimeLabel = computed(() => `${t("MC_MAP_WORLD_TIME")}: ${worldTime.value ?? t("MC_MAP_TIME_UNAVAILABLE")}`);
const loading = ref(true);
const error = ref("");
const x = ref(String(props.initialView?.x ?? 0)), z = ref(String(props.initialView?.z ?? 0));
const renderMode = ref<"2d" | "3d">(props.initialView?.render ?? "2d");
const state = reactive({ x: 0, z: 0, zoom: 2, bearing: 0, loading: 0, warnings: 0, limited: false, empty: false });
const heading = computed(() => ((Math.round(state.bearing * 180 / Math.PI) % 360) + 360) % 360);
const headingLabel = computed(() => `${t("MC_MAP_HEADING")}: ${heading.value}° · ${t("MC_MAP_RESET_NORTH")}`);
let viewport: MapViewport | undefined;
let nextCenter: { x: number; z: number } | undefined;
const markers = shallowRef<ReturnType<typeof playerMarkers>>([]);
const spawnMarker = shallowRef<{ x: number; y: number }>();
const customPoints = shallowRef<{ id: string; x: number; y: number; icon?: string; color?: string; label?: string }[]>([]);
function updateMarkers() {
  markers.value = viewport ? playerMarkers(roster.value?.players ?? [], worlds.value, selected.value, point => viewport?.project(point)) : [];
  spawnMarker.value = viewport?.projectSpawn?.();
  const points = [];
  for (const marker of props.customMarkers) {
    // A marker without a world belongs to every world the map can show.
    if (marker.world && marker.world !== selected.value) continue;
    const point = viewport?.project({ x: marker.x, y: marker.y ?? 64, z: marker.z });
    if (point) points.push({ id: marker.id, x: point.x, y: point.y, icon: marker.icon, color: marker.color, label: marker.label });
  }
  customPoints.value = points;
}
let nextZoom: number | undefined;
/** Centres the map on a point, optionally switching world, zoom and render mode. */
function focus(target: { x: number; z: number; world?: string; zoom?: number; render?: "2d" | "3d" }) {
  const world = target.world ? worlds.value.find((item) => item.id === target.world) : current.value;
  if (!world || loading.value) return false;
  const targetX = Math.max(-MAP_LIMIT, Math.min(MAP_LIMIT, Math.round(target.x)));
  const targetZ = Math.max(-MAP_LIMIT, Math.min(MAP_LIMIT, Math.round(target.z)));
  x.value = String(targetX); z.value = String(targetZ);
  if (target.render) renderMode.value = target.render === "3d" ? "3d" : "2d";
  if (target.zoom !== undefined) {
    // The viewport of another world is recreated by the watcher, which applies it.
    nextZoom = target.zoom;
    if (viewport) viewport.camera.zoom = target.zoom;
    state.zoom = target.zoom;
  }
  if (selected.value !== world.id) { nextCenter = { x: targetX, z: targetZ }; selected.value = world.id; }
  else if (viewport) { viewport.center(targetX, targetZ); nextZoom = undefined; }
  return true;
}
function chooseMenuItem(item: MapMenuItem) {
  if (item.x !== undefined && item.z !== undefined) focus({ x: item.x, z: item.z, world: item.world, zoom: item.zoom });
  emit("menu", item.id);
}
defineExpose({ focus, view: () => view(), world: () => selected.value, render: () => renderMode.value });
function locatePlayer(player: MapPlayer) {
  const world = worldForPlayer(player, worlds.value);
  if (!world || !player.position || loading.value) return;
  const position = player.position;
  x.value = String(Math.floor(position.x)); z.value = String(Math.floor(position.z));
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
const view = (): MapViewOptions => ({ x: state.x, z: state.z, zoom: state.zoom, ...(renderMode.value === "3d" ? { render: "3d" } : {}) });
const items = computed(() => worlds.value.map((world) => {
  const key = ({ "minecraft:overworld": "MC_MAP_OVERWORLD", "minecraft:the_nether": "MC_MAP_NETHER", "minecraft:the_end": "MC_MAP_END" } as Record<string, string>)[world.dimension];
  return { value: world.id, title: `${world.name} · ${key ? t(key) : world.dimension}` };
}));

async function draw(center?: { x: number; z: number }, zoom?: number, bearing = state.bearing) {
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
  viewport = new MapViewport(canvas.value, current.value, api.tile, changed, api.scene);
  if (zoom !== undefined) viewport.camera.zoom = zoom;
  if (bearing) viewport.setBearing(bearing);
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

watch(selected, () => {
  if (loading.value) return;
  error.value = "";
  const zoom = nextZoom;
  nextZoom = undefined;
  void draw(nextCenter, zoom);
  nextCenter = undefined;
}, { flush: "sync" });
watch([roster, current], updateMarkers);
watch(() => props.customMarkers, updateMarkers);
watch(renderMode, value => viewport?.setMode(value));
watch([() => state.x, () => state.z, () => state.zoom, renderMode], () => emit("view", view()));
// Polling re-clears and re-sets the same failure, so each distinct message is
// announced once instead of every few seconds.
let lastError = "", lastPlayerError = "", lastPlayerSuccess = "";
watch(error, value => {
  if (!value || value === lastError) return;
  lastError = value; notification.error(value);
});
watch(playerError, value => {
  if (!value || value === lastPlayerError) return;
  lastPlayerError = value; notification.error(value);
});
watch(playerSuccess, value => {
  if (!value) { lastPlayerSuccess = ""; return; }
  if (value === lastPlayerSuccess) return;
  lastPlayerSuccess = value; notification.success(value);
});
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
    <MapControls :open="sidebarOpen" players :menu="menuItems.length > 0" @update:open="emit('update:sidebarOpen', $event)">
      <template #menu>
        <VList nav :aria-label="t('MC_MAP_EMBED_MENU')">
          <VListItem v-for="item in menuItems" :key="item.id" :title="item.label" :prepend-icon="item.icon || 'mdi-map-marker-radius'" @click="chooseMenuItem(item)" />
        </VList>
      </template>
      <template #players>
        <div class="mc-map-players-toolbar">
          <VTextField v-model="playerSearch" :label="t('MC_MAP_PLAYERS_SEARCH')" hide-details density="compact" variant="outlined" />
          <VBtn variant="text" :loading="readingPlayers" :disabled="enabling" @click="loadPlayers">{{ t('MC_PLAYERS_REFRESH') }}</VBtn>
        </div>
        <div class="mc-map-players-status" role="status">
          <p>{{ t('MC_PLAYERS_ONLINE') }}: {{ roster?.rconEnabled && roster.running && (!roster.warnings.length || roster.players.length) ? roster.players.length : '—' }}</p>
          <p v-if="roster && !roster.running">{{ t('MC_MAP_PLAYERS_STOPPED') }}</p>
          <template v-if="roster?.edition === 'java' && roster.rconConfigured !== false && !roster.rconEnabled">
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
      <div v-if="current && !loading && worldTime" class="mc-map-time" role="timer" :aria-label="worldTimeLabel" :title="worldTimeLabel">
        <VIcon :icon="worldTimeIcon" size="18" aria-hidden="true" />
        <span>{{ worldTime }}</span>
      </div>
      <div v-if="state.warnings || state.limited" class="mc-map-notice">
        <VAlert type="warning" density="compact">{{ t(state.limited ? "MC_MAP_SCENE_LIMIT" : "MC_MAP_PARTIAL") }}</VAlert>
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
      <div class="mc-map-custom-overlay">
        <button v-for="point in customPoints" :key="point.id" type="button" class="mc-map-custom-marker"
          :style="{ left: point.x + 'px', top: point.y + 'px' }" :aria-label="point.label || point.id"
          :title="point.label || undefined" @click="emit('marker', point.id)" @keydown.enter.prevent="emit('marker', point.id)">
          <span class="mc-map-custom-pin" :style="{ background: point.color || '#e0533d' }" aria-hidden="true">
            <VIcon :icon="point.icon || 'mdi-map-marker'" size="15" />
          </span>
          <span v-if="point.label" class="mc-map-custom-label">{{ point.label }}</span>
        </button>
      </div>
      <VMenu v-model="toolsOpen" location="top start" :offset="12" :close-on-content-click="false" :attach="mapRoot" contained>
        <template #activator="{ props: menuProps }">
          <VBtn v-bind="menuProps" class="mc-map-position" prepend-icon="mdi-tune-variant" :title="t('MC_MAP_POSITION_SETTINGS')" :aria-label="t('MC_MAP_POSITION_SETTINGS')" :aria-expanded="toolsOpen">
            <template v-if="current">X: {{ state.x }} · Z: {{ state.z }} · {{ t("MC_MAP_SURFACE") }} · {{ state.zoom.toFixed(1) }}×</template>
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
        </VCard>
      </VMenu>
      <template v-if="current && !loading">
        <div class="mc-map-view-controls">
          <VBtn class="mc-map-render-toggle" :width="48" :height="48" :title="t(renderMode === '2d' ? 'MC_MAP_3D_ENTER' : 'MC_MAP_3D_EXIT')" :aria-label="t(renderMode === '2d' ? 'MC_MAP_3D_ENTER' : 'MC_MAP_3D_EXIT')" :aria-pressed="renderMode === '3d'" @click="error = ''; renderMode = renderMode === '2d' ? '3d' : '2d'">{{ renderMode === '2d' ? '3D' : '2D' }}</VBtn>
          <VBtn class="mc-map-heading" :width="48" :height="48" :title="headingLabel" :aria-label="headingLabel" @click="viewport?.resetBearing()">
            <span class="mc-map-heading-content" aria-hidden="true">
              <svg class="mc-map-heading-needle" viewBox="0 0 24 24" :style="{ transform: `rotate(${-state.bearing}rad)` }"><path d="M12 1 18 12H6Z" fill="#ef5350" /><path d="m12 23 6-11H6Z" fill="currentColor" /></svg>
              <span>{{ heading }}°</span>
            </span>
          </VBtn>
        </div>
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
.mc-map-surface { position: relative; flex: 1; min-height: 280px; background: #19252a; overflow: hidden; }
.mc-map-surface canvas { display: block; width: 100%; height: 100%; position: absolute; inset: 0; cursor: grab; touch-action: none; }
.mc-map-progress { position: absolute; inset: 0 0 auto; z-index: 2; }
.mc-map-player-overlay { position: absolute; inset: 0; z-index: 1; pointer-events: none; overflow: hidden; }
.mc-map-player-marker { position: absolute; width: 28px; height: 28px; transform: translate(-50%, -50%); }
.mc-map-player-name { position: absolute; top: 34px; left: 50%; transform: translateX(-50%); color: #fff; background: rgba(0, 0, 0, 0.5); border-radius: 0; padding: 1px 5px; font-size: 11px; white-space: nowrap; }
.mc-map-player-facing { position: absolute; inset: 0; }
.mc-map-player-facing::before { content: ""; position: absolute; left: 9px; top: -12px; border: 5px solid transparent; border-top: 0; border-bottom: 8px solid #fff; }
/* Pins injected by the embedding page; the overlay stays click-through except the pins. */
.mc-map-custom-overlay { position: absolute; inset: 0; z-index: 2; pointer-events: none; overflow: hidden; }
.mc-map-custom-marker { position: absolute; transform: translate(-50%, -100%); display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 0; border: 0; background: none; pointer-events: auto; cursor: pointer; color: inherit; }
.mc-map-custom-marker:focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: 3px; border-radius: 10px; }
.mc-map-custom-pin { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; color: #fff; box-shadow: 0 2px 6px #0006; }
.mc-map-custom-label { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 1px 6px; border-radius: 0; font-size: 11px; color: #fff; background: rgba(0, 0, 0, 0.55); }
.mc-map-players-toolbar { display: flex; align-items: center; gap: 8px; padding: 12px; }
.mc-map-players-status { padding: 0 16px; font-size: 13px; }
.mc-map-players-status p { margin: 8px 0; }
.mc-map-list-avatar { margin-right: 12px; }
.mc-map-locate-hint { font-size: 12px; opacity: 0.7; margin-left: 8px; }
.mc-map-time { position: absolute; top: var(--mc-map-control-gap); left: 50%; transform: translateX(-50%); z-index: 3; display: flex; align-items: center; gap: 6px; padding: 8px 12px; border-radius: var(--mc-map-control-radius); font-size: 14px; line-height: 20px; font-variant-numeric: tabular-nums; white-space: nowrap; user-select: none; pointer-events: none; }
.mc-map-notice { position: absolute; top: 60px; left: 84px; right: 84px; z-index: 3; max-width: 620px; }
.mc-map-view-controls { position: absolute; top: var(--mc-map-control-gap); right: var(--mc-map-control-gap); z-index: 3; display: flex; flex-direction: column; gap: 8px; }
.mc-map-render-toggle, .mc-map-heading { min-width: 48px; padding: 8px; font-weight: 600; }
.mc-map-heading-content { display: flex; flex-direction: column; align-items: center; gap: 2px; font-size: 10px; line-height: 1; font-variant-numeric: tabular-nums; }
.mc-map-heading-needle { width: 20px; height: 20px; }
/* Outrank desktop mode's injected !important radius reset, regardless of load order. */
.mc-map-surface .mc-map-render-toggle, .mc-map-surface .mc-map-heading { border-radius: var(--mc-map-control-radius) !important; }
.mc-map-scene-empty { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(420px, 90%); text-align: center; padding: 16px; border-radius: 16px; color: rgb(var(--v-theme-on-surface)); background: rgba(var(--v-theme-surface), 0.96); pointer-events: none; }
.mc-map-empty { display: grid; place-items: center; height: 100%; min-height: 280px; color: #dbe5e5; padding: 24px; text-align: center; }
.mc-map-surface .mc-map-position { position: absolute; z-index: 3; border-radius: var(--mc-map-control-radius) !important; height: auto; min-height: 44px; padding: 12px 16px; text-transform: none; }
.mc-map-position { left: var(--mc-map-control-gap); bottom: var(--mc-map-control-gap); max-width: calc(100% - 96px); font-size: 12px; font-variant-numeric: tabular-nums; }
.mc-map-zoom { position: absolute; right: var(--mc-map-control-gap); bottom: var(--mc-map-control-gap); display: flex; flex-direction: column; gap: 4px; padding: 8px; border-radius: var(--mc-map-control-radius); overflow: hidden; }
.mc-map-tools-card.v-card { width: min(400px, calc(100vw - 24px)); max-height: min(70dvh, 540px); overflow-y: auto; overscroll-behavior: contain; border-radius: 18px !important; }
.mc-map-position :deep(.v-btn__content) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
.mc-map-position, .mc-map-zoom, .mc-map-render-toggle, .mc-map-heading, .mc-map-time { color: rgb(var(--v-theme-on-surface)); background: rgba(var(--v-theme-surface), 0.96); box-shadow: 0 3px 16px #0004; }
.mc-map-zoom :deep(.v-btn) { color: inherit; }
.mc-world-map-fullscreen { position: absolute; inset: 0; min-height: 0; }
.mc-world-map-fullscreen .mc-map-surface { position: absolute; inset: 0; min-height: 0; }
</style>
