<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { VAlert } from "vuetify/components";
import { MAP_PAGE_PATH, type MapViewOptions, type PublicMapCatalog } from "../../../shared/map";
import { t } from "../settings";
import { mapError, publicMapCatalog } from "./api";
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

async function load() {
  const current = ++generation;
  abort.abort();
  abort = new AbortController();
  loading.value = true;
  selected.value = "";
  error.value = "";
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
  if (value !== selected.value) void router.replace({ path: MAP_PAGE_PATH, query: { map: value } });
}

watch(() => route.fullPath, () => void load(), { immediate: true });
onBeforeUnmount(() => { generation++; abort.abort(); });
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
    <WorldMapView v-else :key="route.fullPath" v-model:sidebar-open="sidebarOpen" :public-map="selected" :initial-view="initialView" fullscreen>
      <template #settings><PublicMapPicker v-bind="picker" @choose="choose" @refresh="load" /></template>
    </WorldMapView>
  </main>
</template>

<style scoped>
.mc-map-page { position: fixed; inset: 0; height: 100dvh; overflow: hidden; background: #19252a; }
.mc-map-page-message { position: absolute; top: 72px; left: 12px; width: min(620px, calc(100% - 24px)); }
.mc-map-page-empty { padding: 24px; border-radius: 14px; text-align: center; color: #fff; background: #142025dd; }
</style>
