<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { VBtn } from "vuetify/components";
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
    <VBtn v-if="!opened" icon="mdi-menu" class="mc-map-menu" :title="t('MC_MAP_CONTROLS_OPEN')" :aria-label="t('MC_MAP_CONTROLS_OPEN')" :aria-expanded="opened" :aria-controls="panelId" @click="toggle(true)" />
    <Transition name="mc-map-sidebar">
      <aside v-if="opened" :id="panelId" class="mc-map-sidebar" :aria-label="t('MC_MAP_CONTROLS')" @keydown.esc.stop.prevent="toggle(false)">
        <header class="mc-map-sidebar-header">
          <h2>{{ t("MC_MAP_CONTROLS") }}</h2>
          <VBtn icon="mdi-close" class="mc-map-sidebar-close" variant="text" size="small" :title="t('MC_MAP_CONTROLS_CLOSE')" :aria-label="t('MC_MAP_CONTROLS_CLOSE')" @click="toggle(false)" />
        </header>
        <div class="mc-map-sidebar-content"><slot /></div>
      </aside>
    </Transition>
  </div>
</template>

<style scoped>
.mc-map-ui { position: absolute; inset: 0; z-index: 4; pointer-events: none; }
.mc-map-menu { position: absolute; top: 12px; left: 12px; pointer-events: auto; color: rgb(var(--v-theme-on-surface)); background: rgba(var(--v-theme-surface), 0.96); box-shadow: 0 3px 16px #0004; }
.mc-map-sidebar { position: absolute; inset: 12px auto 12px 12px; width: min(420px, calc(100% - 24px)); display: flex; flex-direction: column; pointer-events: auto; color: rgb(var(--v-theme-on-surface)); background: rgba(var(--v-theme-surface), 0.96); border-radius: 16px; box-shadow: 0 4px 28px #0004; backdrop-filter: blur(12px); overflow: hidden; }
.mc-map-sidebar-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px 10px 16px; border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.1); }
.mc-map-sidebar-header h2 { margin: 0; font-size: 16px; font-weight: 600; }
.mc-map-sidebar-content { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 12px 0; }
.mc-map-sidebar-enter-active, .mc-map-sidebar-leave-active { transition: transform 160ms ease, opacity 160ms ease; }
.mc-map-sidebar-enter-from, .mc-map-sidebar-leave-to { transform: translateX(-16px); opacity: 0; }
@media (prefers-reduced-motion: reduce) { .mc-map-sidebar-enter-active, .mc-map-sidebar-leave-active { transition: none; } }
</style>
