<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { VAlert } from "vuetify/components";
import { MAP_PAGE_PATH, type MapViewOptions, type PublicMapCatalog } from "../../../shared/map";
import { EMBED_QUERY, type EmbedFocus } from "../../../shared/embed";
import { t } from "../settings";
import { mapError, publicMapCatalog } from "./api";
import { createEmbedBridge, embedPort } from "./embed";
import { mapPageLocation } from "./page";
import WorldMapView from "./WorldMapView.vue";
import MapControls from "./MapControls.vue";
import PublicMapPicker from "./PublicMapPicker.vue";

const route = useRoute(), router = useRouter();
const sidebarOpen = ref(false);
const catalog = ref<PublicMapCatalog>({ enabled: false, maps: [] });
const selected = ref("");
const initialView = shallowRef<MapViewOptions>({});
const loading = ref(true), error = ref("");
let abort = new AbortController();
let generation = 0;
const items = computed(() => catalog.value.maps.map((map) => ({ title: map.name, value: map.id })));
const picker = computed(() => ({ selected: selected.value, items: items.value, enabled: catalog.value.enabled, loading: loading.value }));
const isEmbed = computed(() => String(route.query[EMBED_QUERY] ?? "") === "1");
const mapView = ref<{ focus(target: EmbedFocus): boolean; view(): MapViewOptions } | null>(null);
const currentView = ref<MapViewOptions>({});
const announced = ref(false);
const bridge = createEmbedBridge(embedPort(), {
  origins: () => catalog.value.embedOrigins ?? [],
  ready: () => ({ map: selected.value, worlds: catalog.value.maps.map((map) => ({ id: map.id, name: map.name })), embed: isEmbed.value }),
  view: () => ({
    map: selected.value, world: selected.value,
    x: currentView.value.x ?? 0, z: currentView.value.z ?? 0, zoom: currentView.value.zoom ?? 2,
    render: currentView.value.render === "3d" ? "3d" : "2d"
  }),
  focus: (target) => mapView.value?.focus(target) ?? false
});
const { markers: injectedMarkers, menu: injectedMenu } = bridge;

function onView(value: MapViewOptions) {
  currentView.value = value;
  if (!announced.value) { announced.value = true; bridge.announce(); }
  bridge.publishView();
}

async function load() {
  const current = ++generation;
  abort.abort();
  abort = new AbortController();
  loading.value = true;
  selected.value = "";
  error.value = "";
  announced.value = false;
  currentView.value = {};
  bridge.stop();
  try {
    const location = mapPageLocation(route.query);
    const result = await publicMapCatalog(abort.signal);
    if (current !== generation || abort.signal.aborted) return;
    catalog.value = result;
    if (!result.enabled) throw new Error("MC_MAP_PAGE_DISABLED");
    const map = location.map ?? result.maps[0]?.id;
    if (map && !result.maps.some((item) => item.id === map)) throw new Error("MC_MAP_PUBLIC_NOT_FOUND");
    initialView.value = location.view;
    selected.value = map ?? "";
  } catch (reason) {
    if (current === generation && !abort.signal.aborted) error.value = mapError(reason);
  } finally { if (current === generation) loading.value = false; }
}

function choose(value: string) {
  if (value === selected.value) return;
  // Keep the embed flag so switching maps cannot cut the bridge mid-session.
  const query = isEmbed.value ? { map: value, [EMBED_QUERY]: "1" } : { map: value };
  void router.replace({ path: MAP_PAGE_PATH, query });
}

// The bridge only listens while embedded and while the allowlist is loaded.
watch([isEmbed, () => catalog.value.embedOrigins, selected], () => {
  if (isEmbed.value && selected.value && (catalog.value.embedOrigins?.length ?? 0)) bridge.start();
}, { immediate: true });
watch(() => route.fullPath, () => void load(), { immediate: true });
onBeforeUnmount(() => { generation++; abort.abort(); bridge.stop(); });
</script>

<template>
  <main class="mc-map-page" :aria-label="t('MC_MAP_TITLE')">
    <template v-if="error || loading || !selected">
      <MapControls v-model:open="sidebarOpen"><PublicMapPicker v-bind="picker" @choose="choose" @refresh="load" /></MapControls>
      <div class="mc-map-page-message">
        <VAlert v-if="error" type="error" density="compact" role="alert">{{ error }}</VAlert>
        <div v-else class="mc-map-page-empty" role="status">{{ t(loading ? "MC_MAP_LOADING" : "MC_MAP_PUBLIC_EMPTY") }}</div>
      </div>
    </template>
    <WorldMapView v-else ref="mapView" :key="route.fullPath" v-model:sidebar-open="sidebarOpen" :public-map="selected" :initial-view="initialView"
      :custom-markers="injectedMarkers" :menu-items="injectedMenu" fullscreen
      @view="onView" @marker="bridge.notifyMarker($event)" @menu="bridge.notifyMenu($event)">
      <template #settings><PublicMapPicker v-bind="picker" @choose="choose" @refresh="load" /></template>
    </WorldMapView>
  </main>
</template>

<style scoped>
.mc-map-page { position: fixed; inset: 0; height: 100dvh; overflow: hidden; background: #19252a; }
.mc-map-page-message { position: absolute; top: 72px; left: 12px; width: min(620px, calc(100% - 24px)); }
.mc-map-page-empty { padding: 24px; border-radius: 14px; text-align: center; color: #fff; background: #142025dd; }
</style>
