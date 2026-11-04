<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { VAlert, VBtn, VProgressLinear, VSelect, VTextField } from "vuetify/components";
import type { MapWorld } from "../../../shared/map";
import { MAP_LIMIT } from "../../../shared/map";
import { t } from "../settings";
import { mapError, worldMapApi } from "./api";
import { MapViewport } from "./viewport";

const props = defineProps<{ instanceUuid: string; daemonId: string }>();
const api = worldMapApi(props.instanceUuid, props.daemonId);
const abort = new AbortController();
const canvas = ref<HTMLCanvasElement>();
const worlds = ref<MapWorld[]>([]);
const selected = ref("");
const loading = ref(true);
const error = ref("");
const x = ref("0"), z = ref("0");
const state = reactive({ x: 0, z: 0, zoom: 2, loading: 0, warnings: 0 });
let viewport: MapViewport | undefined;
let drawing = 0;
let reading = false;
const current = computed(() => worlds.value.find((world) => world.id === selected.value));
const items = computed(() => worlds.value.map((world) => {
  const key = ({ "minecraft:overworld": "MC_MAP_OVERWORLD", "minecraft:the_nether": "MC_MAP_NETHER", "minecraft:the_end": "MC_MAP_END" } as Record<string, string>)[world.dimension];
  return { value: world.id, title: `${world.name} · ${key ? t(key) : world.dimension}` };
}));

async function draw(center?: { x: number; z: number }) {
  const generation = ++drawing;
  viewport?.dispose();
  viewport = undefined;
  await nextTick();
  if (generation !== drawing || abort.signal.aborted || !canvas.value || !current.value) return;
  state.warnings = 0;
  viewport = new MapViewport(canvas.value, current.value, api.tile, (value) => {
    Object.assign(state, value);
    if (value.error) error.value = mapError(value.error);
  });
  if (center) viewport.center(center.x, center.z);
  else { x.value = String(current.value.spawn.x); z.value = String(current.value.spawn.z); }
}

async function load(refresh = false) {
  if (reading) return;
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
    await draw(refresh && selected.value === previous ? center : undefined);
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

watch(selected, () => { if (!loading.value) { error.value = ""; void draw(); } }, { flush: "sync" });
onMounted(() => void load());
onBeforeUnmount(() => { abort.abort(); viewport?.dispose(); });
</script>

<template>
  <div class="mc-world-map">
    <div class="mc-map-toolbar">
      <VSelect v-model="selected" :items="items" :label="t('MC_MAP_WORLD')" :disabled="loading || !worlds.length" hide-details density="compact" variant="outlined" class="mc-map-world-select" />
      <form class="mc-map-coordinates" @submit.prevent="go">
        <VTextField v-model="x" label="X" type="number" :min="-MAP_LIMIT" :max="MAP_LIMIT" step="1" hide-details density="compact" variant="outlined" />
        <VTextField v-model="z" label="Z" type="number" :min="-MAP_LIMIT" :max="MAP_LIMIT" step="1" hide-details density="compact" variant="outlined" />
        <VBtn type="submit" variant="text" :disabled="!current">{{ t("MC_MAP_GO") }}</VBtn>
      </form>
      <VBtn variant="text" :disabled="!current" @click="spawn">{{ t("MC_MAP_SPAWN") }}</VBtn>
      <VBtn variant="text" :loading="loading" @click="load(true)">{{ t("MC_MAP_REFRESH") }}</VBtn>
    </div>
    <VAlert v-if="error" type="error" density="compact" class="mx-3 mb-2" role="alert">{{ error }}</VAlert>
    <VAlert v-else-if="state.warnings" type="warning" density="compact" class="mx-3 mb-2">{{ t("MC_MAP_PARTIAL") }}</VAlert>
    <div class="mc-map-surface">
      <VProgressLinear v-if="loading || state.loading" indeterminate color="primary" class="mc-map-progress" :aria-label="t('MC_MAP_LOADING')" />
      <canvas v-if="!loading && current" ref="canvas" :aria-label="t('MC_MAP_TITLE')" role="img" />
      <div v-else class="mc-map-empty" role="status">{{ loading ? t("MC_MAP_LOADING") : error ? "" : t("MC_MAP_NO_WORLDS") }}</div>
      <template v-if="current && !loading">
        <span class="mc-map-north">{{ t("MC_MAP_NORTH") }} ↑</span>
        <div class="mc-map-zoom">
          <VBtn variant="text" color="white" size="small" min-width="36" :title="t('MC_MAP_ZOOM_IN')" :aria-label="t('MC_MAP_ZOOM_IN')" @click="viewport?.zoom(1.5)">+</VBtn>
          <VBtn variant="text" color="white" size="small" min-width="36" :title="t('MC_MAP_ZOOM_OUT')" :aria-label="t('MC_MAP_ZOOM_OUT')" @click="viewport?.zoom(1 / 1.5)">−</VBtn>
        </div>
        <span class="mc-map-position">X: {{ state.x }} · Z: {{ state.z }} · {{ state.zoom.toFixed(1) }}×</span>
      </template>
    </div>
  </div>
</template>

<style scoped>
.mc-world-map { display: flex; flex-direction: column; height: 100%; min-height: 400px; }
.mc-map-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 12px; }
.mc-map-world-select { min-width: 200px; flex: 1; }
.mc-map-coordinates { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 280px; }
.mc-map-coordinates :deep(.v-input) { min-width: 85px; flex: 1; }
.mc-map-surface { position: relative; flex: 1; min-height: 280px; background: #19252a; border-radius: 16px; overflow: hidden; }
.mc-map-surface canvas { display: block; width: 100%; height: 100%; position: absolute; inset: 0; cursor: grab; touch-action: none; }
.mc-map-progress { position: absolute; inset: 0 0 auto; z-index: 2; }
.mc-map-empty { display: grid; place-items: center; height: 100%; min-height: 280px; color: #dbe5e5; padding: 24px; text-align: center; }
.mc-map-north, .mc-map-position { position: absolute; color: #fff; background: #142025cc; border-radius: 6px; padding: 5px 9px; pointer-events: none; }
.mc-map-north { top: 12px; right: 12px; }
.mc-map-position { left: 12px; bottom: 12px; font-size: 12px; font-variant-numeric: tabular-nums; }
.mc-map-zoom { position: absolute; right: 12px; bottom: 12px; display: flex; flex-direction: column; gap: 4px; padding: 4px; border-radius: 6px; color: #fff; background: #142025cc; }
.mc-map-zoom :deep(.v-btn) { color: #fff; }
</style>
