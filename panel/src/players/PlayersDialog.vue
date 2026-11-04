<script setup lang="ts">
import { ref } from "vue";
import { VBtn, VCard, VCardActions, VCardText, VDialog, VSpacer } from "vuetify/components";
import { t } from "../settings";
import PlayersView from "./PlayersView.vue";

defineProps<{ instanceUuid: string; daemonId: string }>();
const visible = ref(false);
defineExpose({ open: () => { visible.value = true; } });
</script>

<template>
  <VDialog v-model="visible" width="94vw" max-width="1100">
    <VCard :title="t('MC_PLAYERS_TITLE')">
      <VCardText class="mc-players-dialog-content">
        <PlayersView v-if="visible" :key="daemonId + ':' + instanceUuid" :instance-uuid="instanceUuid" :daemon-id="daemonId" />
      </VCardText>
      <VCardActions><VSpacer /><VBtn @click="visible = false">{{ t('MC_PLAYERS_CLOSE') }}</VBtn></VCardActions>
    </VCard>
  </VDialog>
</template>

<style scoped>
.mc-players-dialog-content { height: min(74dvh, 760px); min-height: 0; overflow-y: auto; }
.mc-players-dialog-content :deep(.mc-players-view) { padding: 0; }
</style>
