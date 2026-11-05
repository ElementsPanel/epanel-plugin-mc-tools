<script setup lang="ts">
import { ref } from "vue";
import { VBtn, VCard, VCardActions, VCardText, VDialog, VSpacer } from "vuetify/components";
import { t } from "../settings";
import WorldMapView from "./WorldMapView.vue";

defineProps<{ instanceUuid: string; daemonId: string }>();
const visible = ref(false);
defineExpose({ open: () => { visible.value = true; } });
</script>

<template>
  <VDialog v-model="visible" width="96vw" max-width="1400">
    <VCard :title="t('MC_MAP_TITLE')">
      <VCardText class="mc-map-dialog-content">
        <WorldMapView v-if="visible" :key="daemonId + ':' + instanceUuid" :instance-uuid="instanceUuid" :daemon-id="daemonId" />
      </VCardText>
      <VCardActions>
        <VSpacer />
        <VBtn @click="visible = false">{{ t("MC_MAP_CLOSE") }}</VBtn>
      </VCardActions>
    </VCard>
  </VDialog>
</template>

<style scoped>
.mc-map-dialog-content { height: min(72dvh, 790px); min-height: 0; overflow-y: auto; }
</style>
