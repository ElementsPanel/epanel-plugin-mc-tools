<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { VBtn, VCard, VLayout, VNavigationDrawer } from "vuetify/components";
import { t } from "../settings";

const props = withDefaults(defineProps<{ open?: boolean }>(), { open: undefined });
const emit = defineEmits<{ "update:open": [value: boolean] }>();
const localOpen = ref(false);
const opened = computed(() => props.open ?? localOpen.value);
const controls = ref<HTMLElement>();
const panelId = `mc-map-sidebar-${Math.random().toString(36).slice(2)}`;

async function toggle(value: boolean) {
  localOpen.value = value;
  emit("update:open", value);
  await nextTick();
  controls.value?.querySelector<HTMLButtonElement>(value ? ".mc-map-sidebar-close" : ".mc-map-menu")?.focus();
}
</script>

<template>
  <div ref="controls" class="mc-map-ui">
    <VBtn v-if="!opened" icon="mdi-menu" class="mc-map-menu" :width="60" :height="60" :title="t('MC_MAP_CONTROLS_OPEN')" :aria-label="t('MC_MAP_CONTROLS_OPEN')" :aria-expanded="opened" :aria-controls="panelId" @click="toggle(true)" />
    <VLayout class="mc-map-drawer-layout">
      <VNavigationDrawer :id="panelId" :model-value="opened" class="mc-map-sidebar" location="left" :width="480" rounded="0" absolute temporary floating disable-route-watcher disable-resize-watcher touchless retain-focus capture-focus tag="aside" :aria-label="t('MC_MAP_CONTROLS')" @update:model-value="toggle" @keydown.esc.stop.prevent="toggle(false)">
        <VCard :title="t('MC_MAP_CONTROLS')" class="mc-map-sidebar-card" rounded="0">
          <template #append>
            <VBtn icon="mdi-close" class="mc-map-sidebar-close" variant="text" size="small" :title="t('MC_MAP_CONTROLS_CLOSE')" :aria-label="t('MC_MAP_CONTROLS_CLOSE')" @click="toggle(false)" />
          </template>
          <div class="mc-map-sidebar-content"><slot /></div>
        </VCard>
      </VNavigationDrawer>
    </VLayout>
  </div>
</template>

<style scoped>
.mc-map-ui { position: absolute; inset: 0; z-index: 4; pointer-events: none; }
.mc-map-menu { position: absolute; top: 0; left: 0; padding: 12px; border-radius: 0 0 24px 0 !important; pointer-events: auto; color: rgb(var(--v-theme-on-surface)); background: rgba(var(--v-theme-surface), 0.96); box-shadow: 0 3px 16px #0004; }
.mc-map-drawer-layout { width: 100%; height: 100%; }
.mc-map-drawer-layout :deep(.v-navigation-drawer__scrim) { pointer-events: auto; }
.mc-map-sidebar :deep(.v-navigation-drawer__content) { overflow: hidden; }
.mc-map-sidebar-card { height: 100%; display: flex; flex-direction: column; overflow: hidden; }
.mc-map-sidebar-card > :deep(.v-card-item) { flex: 0 0 auto; min-height: 60px; padding: 10px 16px; }
.mc-map-sidebar-card > :deep(.v-card-item .v-card-title) { font-size: 15px; font-weight: 600; }
.mc-map-sidebar-content { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 12px 0; }
</style>
