<script setup lang="ts">
import { VBtn, VSelect } from "vuetify/components";
import { t } from "../settings";

defineProps<{ selected: string; items: { title: string; value: string }[]; enabled: boolean; loading: boolean; shareUrl: string }>();
const emit = defineEmits<{ choose: [value: string]; refresh: [] }>();
</script>

<template>
  <div class="mc-map-public-picker">
    <VSelect :model-value="selected" :items="items" :label="t('MC_MAP_PUBLIC_MAPS')" :disabled="loading || !enabled || !items.length" hide-details density="compact" variant="outlined" @update:model-value="emit('choose', $event)" />
    <VBtn v-if="selected" :href="shareUrl" target="_blank" rel="noopener noreferrer" prepend-icon="mdi-link-variant" variant="text">{{ t("MC_MAP_PUBLIC_LINK") }}</VBtn>
    <VBtn v-else :loading="loading" variant="text" @click="emit('refresh')">{{ t("MC_MAP_REFRESH") }}</VBtn>
  </div>
</template>

<style scoped>
.mc-map-public-picker { display: flex; flex-direction: column; gap: 8px; padding: 0 12px 12px; border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.1); }
.mc-map-public-picker .v-btn { align-self: flex-start; }
</style>
