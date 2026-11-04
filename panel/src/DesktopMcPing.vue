<script setup lang="ts">
import { usePluginService } from "@elements-panel/sdk";
import { watch } from "vue";
import { VAlert, VBtn } from "vuetify/components";
import PingFields from "./PingFields.vue";
import { t, usePingSettings } from "./settings";

const props = defineProps<{ instanceUuid: string; daemonId: string }>();
const { instanceInfo } = usePluginService("instance")!.hooks.useInstanceInfo({
  instanceId: props.instanceUuid,
  daemonId: props.daemonId,
  autoRefresh: false
});
const { form, loading, error, saved, load, save } = usePingSettings(props.instanceUuid, props.daemonId);
let initialized = false;
watch(instanceInfo, (value) => {
  if (!value || initialized) return;
  load(value);
  initialized = true;
}, { immediate: true });
</script>

<template>
  <div class="mc-ping-desktop">
    <div class="mc-ping-desktop-body">
      <PingFields :form="form" :disabled="loading || !instanceInfo" />
      <VAlert v-if="error" type="error" class="mt-4" role="alert">{{ error }}</VAlert>
      <VAlert v-else-if="saved" type="success" class="mt-4" role="status">
        {{ t("TXT_CODE_d3de39b4") }}
      </VAlert>
    </div>
    <div class="mc-ping-desktop-footer">
      <VBtn :loading="loading" :disabled="!instanceInfo" prepend-icon="mdi-content-save-outline" @click="save">
        {{ t("TXT_CODE_abfe9512") }}
      </VBtn>
    </div>
  </div>
</template>

<style scoped>
.mc-ping-desktop { display: flex; flex-direction: column; height: 100%; }
.mc-ping-desktop-body { flex: 1; overflow-y: auto; padding: 16px; }
.mc-ping-desktop-footer { display: flex; justify-content: flex-end; padding: 12px 16px; }
</style>
