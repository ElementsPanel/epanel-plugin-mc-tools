<script setup lang="ts">
import { VBtn, VList, VListItem } from "vuetify/components";
import { t } from "../settings";

defineProps<{ selected: string; items: { title: string; value: string }[]; enabled: boolean; loading: boolean }>();
const emit = defineEmits<{ choose: [value: string]; refresh: [] }>();
</script>

<template>
  <div class="mc-map-public-picker">
    <VList nav :aria-label="t('MC_MAP_PUBLIC_MAPS')">
      <VListItem v-for="item in items" :key="item.value" :title="item.title" :active="selected === item.value" :disabled="loading || !enabled" prepend-icon="mdi-earth" @click="emit('choose', item.value)" />
    </VList>
    <VBtn v-if="!selected" :loading="loading" variant="text" @click="emit('refresh')">{{ t("MC_MAP_REFRESH") }}</VBtn>
  </div>
</template>

<style scoped>
.mc-map-public-picker { display: flex; flex-direction: column; gap: 8px; padding: 0 12px 12px; border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.1); }
.mc-map-public-picker .v-btn { align-self: flex-start; }
</style>
